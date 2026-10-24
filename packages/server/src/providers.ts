import {
  DEFAULT_ELEVENLABS_VOICE_ID,
  ElevenLabsConfigError,
  ElevenLabsPipelineFactory,
  MockPipelineFactory,
  SystemTtsProvider,
  MockTextTranslator,
  MockTts,
  UtteranceBus,
  utteranceKey,
  type DirectionPipelineOptions,
  type SystemVoiceEngine,
} from '@tw/pipeline';
import {
  DEFAULT_APP_SETTINGS,
  concatPcm,
  silencePcm16,
  synthesizeSpeechSignal,
  type AppSettings,
  type CallChannel,
  type PipelineFactory,
  type ProviderMode,
} from '@tw/shared';
import type { CallManager } from './call-manager.js';
import { MockCallChannel } from './channel/mock-channel.js';
import type { ServerConfig } from './config.js';
import type { DebugHooks } from './operator-socket.js';

export class NotConfiguredError extends Error {}

export interface Providers {
  mode: ProviderMode;
  /** Pipelines of the calls of `channel` (and of local calls when `localPipelines` is null). */
  pipelines: PipelineFactory;
  /**
   * Pipelines of "modo audio del PC" calls when they differ from `pipelines`: with PROVIDERS=auto the test call
   * stays simulated while local calls, which carry real audio, use ElevenLabs and Claude.
   */
  localPipelines: PipelineFactory | null;
  channel: CallChannel;
  /** Only with simulated providers: lets the text of simulated speech reach the simulated STT. */
  bus: UtteranceBus | null;
  /** True when the calls of `channel` use simulated STT, translation and voice. */
  simulatedProviders: boolean;
  /** True when "modo audio del PC" calls use simulated STT, translation and voice. */
  localSimulated: boolean;
  /** Simulation speed: 1 = real time; tests raise it. */
  speed: number;
}

/**
 * Chooses the implementations behind PROVIDERS and CHANNEL.
 * - PROVIDERS=mock: simulated STT, translator and voice (the utterance bus carries the text).
 * - PROVIDERS=auto (the desktop app): simulated for the test call, real (as below) for "modo audio del PC" calls.
 * - PROVIDERS=elevenlabs: real ElevenLabs STT/TTS and Claude translator. UNVERIFIED against the live
 *   services (only tested against local simulators). The API keys are resolved when each session opens:
 *   a missing key does not stop the server, it fails the first call with a clear message, and
 *   `system.status` already shows `unconfigured`.
 * - CHANNEL=twilio|whatsapp: not implemented; the server refuses to start instead of pretending to work.
 */
export interface CreateProvidersOptions {
  /** Simulation speed (mock only). */
  speed?: number;
  /** Resolves an API key (Settings first, then the environment). Needed by PROVIDERS=elevenlabs. */
  getSecret?: (name: 'ELEVENLABS_API_KEY' | 'ANTHROPIC_API_KEY') => Promise<string | undefined>;
  env?: Record<string, string | undefined>;
  /** Voice and plan B from Ajustes, read when each call (and each voice session) starts. */
  appSettings?: () => AppSettings;
  /** The computer's own voice, plan B of the real providers. */
  systemVoice?: SystemVoiceEngine;
}

export function createProviders(config: ServerConfig, options: CreateProvidersOptions = {}): Providers {
  const speed = options.speed ?? 1;
  if (config.channel !== 'mock' && config.channel !== 'desktop-audio') {
    throw new NotConfiguredError(
      `CHANNEL=${config.channel} todavía no está implementado: no hay código de telefonía real. Mira docs/CANALES.md. Usa CHANNEL=mock.`,
    );
  }
  const pipelineOptions: Partial<DirectionPipelineOptions> = {
    holdMs: config.langHoldSeconds * 1000,
    controller: {
      fallbackLang: config.fallbackLang,
      agreeSegments: config.langConfirmSegments,
      minWords: config.langMinWords,
      minProbability: config.langMinProbability,
      switchSegments: Math.max(config.langChangeSegments, config.langConfirmSegments),
    },
  };

  const real = (): ElevenLabsPipelineFactory => {
    const env = options.env ?? process.env;
    const getSecret = options.getSecret ?? ((name) => Promise.resolve(env[name]?.trim() || undefined));
    const settings = options.appSettings ?? (() => DEFAULT_APP_SETTINGS);
    try {
      return new ElevenLabsPipelineFactory({
        getSecret,
        env,
        pipeline: pipelineOptions,
        defaultVoiceId: () => settings().voiceId ?? DEFAULT_ELEVENLABS_VOICE_ID,
        // No computer voice on this platform (a Linux server): no plan B voice at all, so the main voice is never skipped.
        ...(options.systemVoice && options.systemVoice.platform !== 'none' ? { fallbackTts: new SystemTtsProvider(options.systemVoice) } : {}),
        fallbackPolicy: () => {
          const current = settings();
          return { systemVoice: current.fallbackSystemVoice, originalVoice: current.fallbackOriginalVoice };
        },
      });
    } catch (error) {
      if (error instanceof ElevenLabsConfigError) throw new NotConfiguredError(error.message);
      throw error;
    }
  };

  if (config.providers === 'elevenlabs') {
    const pipelines = real();
    // Real voices and translation, but calls still come from the simulated channel: its synthetic
    // "speech" is not real speech, so the real STT will not understand it. Only real audio will.
    const channel = new MockCallChannel({ speed });
    return { mode: 'elevenlabs', pipelines, localPipelines: null, channel, bus: null, simulatedProviders: false, localSimulated: false, speed };
  }

  const bus = new UtteranceBus();
  const channel = new MockCallChannel({ speed });
  channel.onUtterance((utterance) => bus.say(utteranceKey(utterance.callId, 'passenger'), { text: utterance.text, lang: utterance.lang }));
  const pipelines = new MockPipelineFactory({
    bus,
    translator: new MockTextTranslator({ latencyMs: 150 / speed }),
    tts: new MockTts({ realtime: speed === 1 }),
    pipeline: pipelineOptions,
  });
  if (config.providers === 'auto') {
    return { mode: 'auto', pipelines, localPipelines: real(), channel, bus, simulatedProviders: true, localSimulated: false, speed };
  }
  return { mode: 'mock', pipelines, localPipelines: null, channel, bus, simulatedProviders: true, localSimulated: true, speed };
}

/** `debug.say`: lets someone try the whole flow with no microphone and no phone. Simulated providers only. */
export function createDebugHooks(providers: Providers, channel: MockCallChannel, manager: CallManager): DebugHooks | undefined {
  const bus = providers.bus;
  if (!bus) return undefined;
  return {
    sayAsPassenger: (callId, text, lang) => channel.sayAsPassenger(callId, text, lang),
    sayAsOperator: (operatorId, callId, text, lang) => {
      const session = manager.sessionOf(operatorId);
      if (!session || session.callId !== callId || session.isEnded) return false;
      bus.say(utteranceKey(callId, 'operator'), { text, lang });
      // Synthetic operator "microphone": speech-like audio at playback speed, then a little silence.
      const signal = concatPcm([synthesizeSpeechSignal(text, { pitchHz: 130 }), silencePcm16(300)]);
      let offset = 0;
      const timer = setInterval(() => {
        const current = manager.sessionOf(operatorId);
        if (!current || current.callId !== callId || current.isEnded || offset >= signal.byteLength) {
          clearInterval(timer);
          return;
        }
        manager.pushOperatorAudio(operatorId, signal.slice(offset, offset + 640));
        offset += 640;
      }, Math.max(1, 20 / providers.speed));
      return true;
    },
  };
}
