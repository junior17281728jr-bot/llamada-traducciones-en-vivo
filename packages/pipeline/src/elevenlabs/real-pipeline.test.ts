/**
 * The whole chain with the REAL clients (ElevenLabs STT/TTS over WebSocket, Claude through the
 * official SDK) against local simulators: the fake ElevenLabs server and a fake `fetch` under the
 * Anthropic client. Same scenarios as direction-pipeline.test.ts, nothing leaves the machine.
 */
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LANGUAGE_SETTINGS,
  concatPcm,
  silencePcm16,
  synthesizeSpeechSignal,
  type LanguageSettings,
  type LanguageStateEvent,
  type PipelineStageEvent,
  type TranscriptSegment,
} from '@tw/shared';
import { ElevenLabsPipelineFactory, type ElevenLabsPipelineFactoryOptions } from '../elevenlabs-factory.js';
import { ElevenLabsConfigError } from './errors.js';
import { FakeElevenLabsServer, type FakeElevenLabsOptions } from './testing/fake-elevenlabs-server.js';

const CALL = 'c-real';
const EN = 'my flight was cancelled and I need a hotel';
const EN_ES = 'Mi vuelo fue cancelado y necesito un hotel.';
const ES_CHECK = 'voy a comprobar las opciones de alojamiento disponibles';
const ES_CHECK_EN = 'I will check the available accommodation options.';
const ES_HELLO = 'buenos días le atiende telecomway';
const ES_HELLO_FR = 'Bonjour, Telecomway à votre service.';

const normalise = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
const DICTIONARY: Record<string, string> = {
  [`es|${normalise(EN)}`]: EN_ES,
  [`en|${normalise(ES_CHECK)}`]: ES_CHECK_EN,
  [`fr|${normalise(ES_HELLO)}`]: ES_HELLO_FR,
};
const SOURCE: Record<string, string> = { [normalise(EN)]: 'en', [normalise(ES_CHECK)]: 'es', [normalise(ES_HELLO)]: 'es' };

/** Fake Anthropic API: answers the translator's JSON from a dictionary and records every request. */
function fakeAnthropic() {
  const calls: { body: { messages: { content: string }[] }; key: string | null }[] = [];
  const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const headers = new Headers(init?.headers);
    calls.push({ body, key: headers.get('x-api-key') ?? headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null });
    const prompt = body.messages[0]!.content;
    const to = /Target language: (\w+)/.exec(prompt)![1]!;
    const text = /<utterance>([\s\S]*?)<\/utterance>/.exec(prompt)![1]!;
    const translation = DICTIONARY[`${to}|${normalise(text)}`] ?? `[>${to}] ${text}`;
    const source = SOURCE[normalise(text)] ?? 'en';
    const message = {
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-5-5',
      content: [{ type: 'text', text: JSON.stringify({ t: translation, s: source }), citations: null }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
    return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

let server: FakeElevenLabsServer;
const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await server?.close();
});

async function start(options: FakeElevenLabsOptions = {}): Promise<void> {
  server = await FakeElevenLabsServer.start({
    apiKey: 'eleven-key',
    ...options,
    tts: { voicePitch: { 'voice-es': 120, 'voice-en': 180, 'voice-fr': 230 }, chunkMs: 20, ...options.tts },
  });
}

interface RigOptions {
  settings?: LanguageSettings;
  env?: Record<string, string | undefined>;
  secrets?: Partial<Record<'ELEVENLABS_API_KEY' | 'ANTHROPIC_API_KEY', string>>;
  factory?: Partial<ElevenLabsPipelineFactoryOptions>;
}

function rig(options: RigOptions = {}) {
  const settings = options.settings ?? DEFAULT_LANGUAGE_SETTINGS;
  const secrets = { ELEVENLABS_API_KEY: 'eleven-key', ANTHROPIC_API_KEY: 'anthropic-key', ...options.secrets };
  const anthropic = fakeAnthropic();
  const factory = new ElevenLabsPipelineFactory({
    getSecret: (name) => Promise.resolve(secrets[name]),
    env: { ELEVENLABS_BASE_URL: server.url, ELEVENLABS_VOICE_ES: 'voice-es', ELEVENLABS_VOICE_EN: 'voice-en', ELEVENLABS_VOICE_FR: 'voice-fr', ...options.env },
    createTranslatorClient: (apiKey) => new Anthropic({ apiKey, fetch: anthropic.fetch, maxRetries: 0 }),
    pipeline: { holdMs: 200, receivingHangoverMs: 30, errorDisplayMs: 60, sttRetries: 0 },
    stt: { reconnectDelayMs: 10 },
    tts: { keepaliveMs: 0, retryDelayMs: 5 },
    translator: { retryDelayMs: 1 },
    ...options.factory,
  });
  const passenger = factory.createDirectionPipeline({ callId: CALL, direction: 'passenger_to_operator', settings });
  const operator = factory.createDirectionPipeline({ callId: CALL, direction: 'operator_to_passenger', settings });
  closers.push(() => Promise.all([passenger.close(), operator.close()]));

  const segments: TranscriptSegment[] = [];
  const stages = { passenger: [] as PipelineStageEvent[], operator: [] as PipelineStageEvent[] };
  const languageStates: LanguageStateEvent[] = [];
  const out = { passenger: [] as Uint8Array[], operator: [] as Uint8Array[] };
  const errors: Error[] = [];
  passenger.onSegment((s) => segments.push(s));
  operator.onSegment((s) => segments.push(s));
  passenger.onStage((e) => stages.passenger.push(e));
  operator.onStage((e) => stages.operator.push(e));
  passenger.onAudio((c) => out.passenger.push(c));
  operator.onAudio((c) => out.operator.push(c));
  passenger.onError((e) => errors.push(e));
  operator.onError((e) => errors.push(e));
  passenger.onLanguageState((event) => {
    languageStates.push(event);
    operator.setPassengerLanguageState(event.state);
  });
  return { factory, anthropic, passenger, operator, segments, stages, languageStates, out, errors };
}

type Rig = ReturnType<typeof rig>;

function say(r: Rig, who: 'passenger' | 'operator', text: string, lang: string): void {
  server.say(who === 'passenger' ? null : 'es', { text, lang });
  const signal = concatPcm([synthesizeSpeechSignal(text, { pitchHz: who === 'passenger' ? 200 : 130 }), silencePcm16(200)]);
  const target = who === 'passenger' ? r.passenger : r.operator;
  for (let offset = 0; offset < signal.byteLength; offset += 640) {
    target.pushAudio(signal.slice(offset, Math.min(offset + 640, signal.byteLength)));
  }
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 6000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && Buffer.from(a).equals(Buffer.from(b));
const finals = (r: Rig, speaker: 'passenger' | 'operator') => r.segments.filter((s) => s.final && s.speaker === speaker);
const voice = (text: string, voiceId: string) => server.expectedTtsAudio(text, voiceId, 'pcm_16000');

describe('ElevenLabsPipelineFactory', () => {
  it('is not simulated, rejects invalid settings in Spanish and lists the configured voices', async () => {
    await start();
    const r = rig();
    expect(r.factory.simulated).toBe(false);
    expect(r.factory.configuredVoiceLanguages()).toEqual(['es', 'en', 'fr']);
    expect(r.factory.settings.translatorModel).toBe('claude-haiku-5-5');
    expect(() => rig({ env: { ELEVENLABS_TTS_OUTPUT_FORMAT: 'mp3_44100_128' } })).toThrowError(ElevenLabsConfigError);
  });

  it('does not fail at construction when keys are missing: the first phrase reports it in Spanish', async () => {
    await start();
    const noEleven = rig({ secrets: { ELEVENLABS_API_KEY: '' } });
    say(noEleven, 'passenger', EN, 'en');
    await waitFor(() => noEleven.errors.length >= 1, 'the missing ElevenLabs key error');
    expect(noEleven.errors[0]!.message).toContain('ELEVENLABS_API_KEY');
    expect(noEleven.stages.passenger.some((e) => e.stage === 'error' && e.detail?.includes('transcripción'))).toBe(true);
    expect(server.sttSessions).toHaveLength(0);

    const noAnthropic = rig({ secrets: { ANTHROPIC_API_KEY: '' } });
    say(noAnthropic, 'passenger', EN, 'en');
    await waitFor(() => finals(noAnthropic, 'passenger').length === 1, 'the untranslated segment');
    expect(finals(noAnthropic, 'passenger')[0]).toMatchObject({ originalText: EN, translatedText: null });
    expect(noAnthropic.errors.some((e) => e.message.includes('ANTHROPIC_API_KEY'))).toBe(true);
    expect(noAnthropic.anthropic.calls).toHaveLength(0);

    const noVoice = rig({ env: { ELEVENLABS_VOICE_ES: '' } });
    say(noVoice, 'passenger', EN, 'en');
    await waitFor(() => noVoice.errors.some((e) => e.message.includes('ELEVENLABS_VOICE_ES')), 'the missing voice error');
    expect(finals(noVoice, 'passenger')[0]).toMatchObject({ translatedText: EN_ES });
  });
});

describe('real clients against the simulators', () => {
  it('passenger English phrase: STT by WebSocket, Claude translation, Spanish voice back', async () => {
    await start();
    const r = rig();
    say(r, 'passenger', EN, 'en');
    await waitFor(() => finals(r, 'passenger').length === 1, 'the final segment');
    expect(finals(r, 'passenger')[0]).toMatchObject({ speaker: 'passenger', originalLang: 'en', originalText: EN, translatedLang: 'es', translatedText: EN_ES, final: true });
    expect(r.segments.some((s) => !s.final && s.speaker === 'passenger')).toBe(true);

    await waitFor(() => r.stages.passenger.at(-1)?.stage === 'idle' && r.out.passenger.length > 0, 'the voice to finish');
    expect(bytesEqual(concatPcm(r.out.passenger), voice(EN_ES, 'voice-es'))).toBe(true);
    expect(r.languageStates.at(-1)?.state).toMatchObject({ lang: 'en', status: 'tentative', source: 'stt+translator' });
    expect(r.errors).toHaveLength(0);

    const order = r.stages.passenger.map((e) => e.stage);
    expect(order.indexOf('receiving')).toBeLessThan(order.indexOf('transcribing'));
    expect(order.indexOf('transcribing')).toBeLessThan(order.indexOf('translating'));
    expect(order.indexOf('translating')).toBeLessThan(order.indexOf('speaking'));

    expect(r.anthropic.calls).toHaveLength(1);
    expect(r.anthropic.calls[0]!.key).toBe('anthropic-key');
    expect(server.sttSessions[0]!.headers['xi-api-key']).toBe('eleven-key');
    expect(server.sttSessions[0]!.languageCode).toBe('');
    // The operator lane pre-opens the English voice as soon as the passenger language is known; only the Spanish voice spoke.
    expect(server.ttsConnections.filter((c) => c.spokenText).map((c) => c.voiceId)).toEqual(['voice-es']);
  });

  it('changes the voice language mid-call without cutting the audio that is playing', async () => {
    await start({ tts: { paceMs: 2 } });
    const mixedEn: LanguageSettings = { operatorLang: 'es', passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'fixed', lang: 'en' } };
    const r = rig({ settings: mixedEn });

    say(r, 'operator', ES_CHECK, 'es');
    await waitFor(() => r.out.operator.length > 0, 'the first phrase to start playing');
    const chunksAtSwitch = r.out.operator.length;

    r.operator.applyLanguageSettings({ ...mixedEn, passengerHears: { mode: 'fixed', lang: 'fr' } });
    say(r, 'operator', ES_HELLO, 'es');

    await waitFor(() => finals(r, 'operator').length === 2, 'both phrases');
    await waitFor(() => r.stages.operator.at(-1)?.stage === 'idle', 'idle after the second phrase');
    expect(finals(r, 'operator').map((s) => [s.translatedLang, s.translatedText])).toEqual([
      ['en', ES_CHECK_EN],
      ['fr', ES_HELLO_FR],
    ]);

    // Phrase 1 in the English voice followed by phrase 2 in the French voice: nothing cut, dropped or overlapped.
    const expected = concatPcm([voice(ES_CHECK_EN, 'voice-en'), voice(ES_HELLO_FR, 'voice-fr')]);
    const actual = concatPcm(r.out.operator);
    expect(actual.byteLength).toBe(expected.byteLength);
    expect(bytesEqual(actual, expected)).toBe(true);
    expect(r.errors).toHaveLength(0);

    const spokenVoices = server.ttsConnections.filter((c) => c.spokenText).map((c) => c.voiceId);
    expect(spokenVoices).toEqual(['voice-en', 'voice-fr']);
    // The French voice was connected while the English phrase was still streaming.
    const english = server.ttsConnections.find((c) => c.spokenText && c.voiceId === 'voice-en')!;
    const french = server.ttsConnections.find((c) => c.voiceId === 'voice-fr')!;
    expect(french.openedAtChunk).toBeGreaterThanOrEqual(chunksAtSwitch);
    expect(french.openedAtChunk).toBeLessThan(english.audioChunksSent);
    expect(server.sttSessions[0]!.languageCode).toBe('es');
    expect(server.sttSessions).toHaveLength(1);
  });
});
