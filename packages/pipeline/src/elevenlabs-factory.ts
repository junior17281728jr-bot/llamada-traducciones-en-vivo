/**
 * PROVIDERS=elevenlabs: the real clients behind the same `TranslationDirectionPipeline` the mock
 * factory uses. Settings (models, formats, voices) come from the environment once; the API keys are
 * resolved through `getSecret` every time a session opens, so a key saved in Settings works without a
 * restart and a missing key fails the first call (with a clear message) rather than the server start.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { LANGUAGE_CODES, type DirectionPipeline, type DirectionPipelineConfig, type LanguageCode, type Logger, type PipelineFactory } from '@tw/shared';
import { ClaudeTranslator, type ClaudeTranslatorOptions } from './claude/translator.js';
import { TranslationDirectionPipeline, type DirectionPipelineOptions } from './direction-pipeline.js';
import { configuredVoiceLanguages, readElevenLabsSettings, voiceIdFor, type ElevenLabsSettings, type Env } from './elevenlabs/settings.js';
import type { WebSocketFactory } from './elevenlabs/socket.js';
import { ElevenLabsSttProvider, type ElevenLabsSttOptions } from './elevenlabs/stt.js';
import { ElevenLabsTtsProvider, type ElevenLabsTtsOptions } from './elevenlabs/tts.js';

export type ProviderSecretName = 'ELEVENLABS_API_KEY' | 'ANTHROPIC_API_KEY';

export interface ElevenLabsPipelineFactoryOptions {
  /** Settings first, then the environment (the server passes `SecretsStore.resolve`). */
  getSecret: (name: ProviderSecretName) => Promise<string | undefined>;
  /** Non-secret settings and the `ELEVENLABS_VOICE_<CODE>` voices. */
  env: Env;
  pipeline?: Partial<DirectionPipelineOptions>;
  logger?: Logger;
  /** Test hooks: local WebSocket servers and an Anthropic client with a fake `fetch`. */
  webSocketFactory?: WebSocketFactory;
  createTranslatorClient?: (apiKey: string) => Anthropic;
  stt?: Partial<Omit<ElevenLabsSttOptions, 'getApiKey'>>;
  tts?: Partial<Omit<ElevenLabsTtsOptions, 'getApiKey' | 'voiceIdFor'>>;
  translator?: Partial<Omit<ClaudeTranslatorOptions, 'getApiKey' | 'createClient'>>;
}

export class ElevenLabsPipelineFactory implements PipelineFactory {
  readonly simulated = false;
  readonly settings: ElevenLabsSettings;
  readonly stt: ElevenLabsSttProvider;
  readonly tts: ElevenLabsTtsProvider;
  readonly translator: ClaudeTranslator;

  /** Throws `ElevenLabsConfigError` (Spanish message) when a non-secret setting is invalid. Missing keys do not throw here. */
  constructor(private readonly options: ElevenLabsPipelineFactoryOptions) {
    const settings = readElevenLabsSettings(options.env);
    this.settings = settings;
    const common = { logger: options.logger, webSocketFactory: options.webSocketFactory };
    this.stt = new ElevenLabsSttProvider({
      baseUrl: settings.baseUrl,
      modelId: settings.stt.modelId,
      audioFormat: settings.stt.audioFormat,
      commitStrategy: settings.stt.commitStrategy,
      vadSilenceSeconds: settings.stt.vadSilenceSeconds,
      includeTimestamps: settings.stt.includeTimestamps,
      ...common,
      ...options.stt,
      getApiKey: () => options.getSecret('ELEVENLABS_API_KEY'),
    });
    this.tts = new ElevenLabsTtsProvider({
      baseUrl: settings.baseUrl,
      modelId: settings.tts.modelId,
      outputFormat: settings.tts.outputFormat,
      chunkLengthSchedule: settings.tts.chunkLengthSchedule,
      ...common,
      ...options.tts,
      getApiKey: () => options.getSecret('ELEVENLABS_API_KEY'),
      voiceIdFor: (lang) => voiceIdFor(options.env, lang),
    });
    this.translator = new ClaudeTranslator({
      model: settings.translatorModel,
      logger: options.logger,
      ...options.translator,
      getApiKey: () => options.getSecret('ANTHROPIC_API_KEY'),
      ...(options.createTranslatorClient ? { createClient: options.createTranslatorClient } : {}),
    });
  }

  createDirectionPipeline(config: DirectionPipelineConfig): DirectionPipeline {
    const pipelineOptions: Partial<DirectionPipelineOptions> = { ...(this.options.pipeline ?? {}) };
    if (this.options.logger && !pipelineOptions.logger) pipelineOptions.logger = this.options.logger;
    return new TranslationDirectionPipeline(config, { stt: this.stt, translator: this.translator, tts: this.tts }, pipelineOptions);
  }

  /** Languages with a voice configured (`ELEVENLABS_VOICE_<CODE>`), for diagnostics and Settings. */
  configuredVoiceLanguages(): LanguageCode[] {
    return configuredVoiceLanguages(this.options.env, LANGUAGE_CODES);
  }
}
