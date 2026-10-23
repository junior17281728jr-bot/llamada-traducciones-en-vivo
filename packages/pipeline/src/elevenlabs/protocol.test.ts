import { describe, expect, it } from 'vitest';
import { ElevenLabsConfigError } from './errors.js';
import {
  STT_ERROR_TYPES,
  STT_PATH,
  buildSttAudioMessage,
  buildSttUrl,
  buildTtsInitMessage,
  buildTtsTextMessage,
  buildTtsUrl,
  classifyTtsFailure,
  parseSttServerMessage,
  parseTtsServerMessage,
} from './protocol.js';
import { missingVoiceMessage, readElevenLabsSettings, voiceIdFor } from './settings.js';

describe('STT URL and messages', () => {
  it('builds the realtime URL with the documented parameters and omits the language when auto-detecting', () => {
    const auto = new URL(buildSttUrl({ baseUrl: 'wss://api.example.test/', modelId: 'scribe_v2_realtime', audioFormat: 'pcm_16000', commitStrategy: 'vad', includeTimestamps: false, vadSilenceSeconds: 0.8 }));
    expect(auto.pathname).toBe(STT_PATH);
    expect(auto.searchParams.get('model_id')).toBe('scribe_v2_realtime');
    expect(auto.searchParams.get('language_code')).toBeNull();
    expect(auto.searchParams.get('audio_format')).toBe('pcm_16000');
    expect(auto.searchParams.get('commit_strategy')).toBe('vad');
    expect(auto.searchParams.get('include_language_detection')).toBe('true');
    expect(auto.searchParams.get('include_timestamps')).toBe('false');
    expect(auto.searchParams.get('vad_silence_threshold_secs')).toBe('0.8');

    const fixed = new URL(buildSttUrl({ baseUrl: 'ws://127.0.0.1:1', modelId: 'm', audioFormat: 'ulaw_8000', commitStrategy: 'manual', lang: 'fr', includeTimestamps: true, vadSilenceSeconds: 0.8 }));
    expect(fixed.searchParams.get('language_code')).toBe('fr');
    expect(fixed.searchParams.get('vad_silence_threshold_secs')).toBeNull();
  });

  it('shapes the audio message', () => {
    expect(buildSttAudioMessage('AAAA', false, 16000)).toEqual({ message_type: 'input_audio_chunk', audio_base_64: 'AAAA', commit: false, sample_rate: 16000 });
  });

  it('reads canonical and alternative transcript fields', () => {
    expect(parseSttServerMessage({ message_type: 'partial_transcript', text: 'hello', language_code: 'en' })).toEqual({ kind: 'partial', text: 'hello', lang: 'en' });
    expect(parseSttServerMessage({ message_type: 'partial_transcript', transcript: 'bonjour', language: 'fr-FR' })).toEqual({ kind: 'partial', text: 'bonjour', lang: 'fr' });
    expect(parseSttServerMessage({ message_type: 'committed_transcript', text: 'hello there', language_code: 'eng', language_probability: 0.87 })).toMatchObject({
      kind: 'committed',
      text: 'hello there',
      lang: 'en',
      probability: 0.87,
      startMs: null,
      endMs: null,
      withTimestamps: false,
    });
  });

  it('reads timestamps in the shapes it tolerates', () => {
    expect(parseSttServerMessage({ message_type: 'committed_transcript_with_timestamps', text: 'a b', words: [{ text: 'a', start: 1.5, end: 2 }, { text: 'b', start: 2, end: 2.75 }] })).toMatchObject({ startMs: 1500, endMs: 2750, withTimestamps: true });
    expect(parseSttServerMessage({ message_type: 'committed_transcript', text: 'x', start_time: 0.25, end_time: 1 })).toMatchObject({ startMs: 250, endMs: 1000 });
    expect(parseSttServerMessage({ message_type: 'committed_transcript', text: 'x', start_ms: 10, end_ms: 20 })).toMatchObject({ startMs: 10, endMs: 20 });
  });

  it('maps every documented error type to a policy and tolerates the generic error envelope', () => {
    for (const type of STT_ERROR_TYPES) {
      const event = parseSttServerMessage({ message_type: type, message: 'why' });
      expect(event.kind).toBe('error');
      if (event.kind === 'error') expect(['ignore', 'reconnect', 'fatal']).toContain(event.policy);
    }
    expect(parseSttServerMessage({ message_type: 'auth_error' })).toMatchObject({ kind: 'error', type: 'auth_error', policy: 'fatal' });
    expect(parseSttServerMessage({ message_type: 'error', error: 'rate_limited', message: 'slow down' })).toMatchObject({ kind: 'error', type: 'rate_limited', policy: 'reconnect', message: 'slow down' });
    expect(parseSttServerMessage({ error: 'something_else' })).toMatchObject({ kind: 'error', type: 'something_else', policy: 'reconnect' });
    expect(parseSttServerMessage({ message_type: 'brand_new_thing' })).toEqual({ kind: 'unknown', type: 'brand_new_thing' });
    expect(parseSttServerMessage('nope')).toEqual({ kind: 'unknown', type: null });
    expect(parseSttServerMessage({ message_type: 'session_started', session_id: 's1' })).toEqual({ kind: 'session_started', sessionId: 's1' });
  });
});

describe('TTS URL and messages', () => {
  it('builds the stream-input URL for a voice', () => {
    const url = new URL(buildTtsUrl({ baseUrl: 'wss://api.example.test', voiceId: 'voice/1', modelId: 'eleven_flash_v2_5', outputFormat: 'pcm_24000' }));
    expect(url.pathname).toBe('/v1/text-to-speech/voice%2F1/stream-input');
    expect(url.searchParams.get('model_id')).toBe('eleven_flash_v2_5');
    expect(url.searchParams.get('output_format')).toBe('pcm_24000');
  });

  it('shapes the first message and text messages', () => {
    expect(buildTtsInitMessage({ chunkLengthSchedule: [50, 90] })).toEqual({ text: ' ', voice_settings: { stability: 0.5, similarity_boost: 0.8 }, generation_config: { chunk_length_schedule: [50, 90] } });
    expect(buildTtsTextMessage('Hola')).toEqual({ text: 'Hola ', try_trigger_generation: true });
    expect(buildTtsTextMessage('Hola ')).toEqual({ text: 'Hola ', try_trigger_generation: true });
  });

  it('reads audio, final, error and unknown responses', () => {
    expect(parseTtsServerMessage({ audio: 'AAAA', isFinal: false, normalizedAlignment: null })).toEqual({ kind: 'audio', audioBase64: 'AAAA', isFinal: false });
    expect(parseTtsServerMessage({ audio: null, isFinal: true })).toEqual({ kind: 'final' });
    expect(parseTtsServerMessage({ error: 'invalid_api_key', message: 'bad key' })).toEqual({ kind: 'error', code: 'invalid_api_key', message: 'bad key' });
    expect(parseTtsServerMessage({ message: 'quota exceeded', code: 1008 })).toEqual({ kind: 'error', code: '1008', message: 'quota exceeded' });
    expect(parseTtsServerMessage({ something: 1 })).toEqual({ kind: 'unknown' });
  });

  it('classifies failure texts', () => {
    expect(classifyTtsFailure({ message: 'Invalid API key' })).toBe('auth');
    expect(classifyTtsFailure({ code: 1008, message: '' })).toBe('auth');
    expect(classifyTtsFailure({ message: 'quota_exceeded' })).toBe('quota');
    expect(classifyTtsFailure({ message: 'too many concurrent requests' })).toBe('rate_limited');
    expect(classifyTtsFailure({ message: 'voice not found' })).toBe('config');
    expect(classifyTtsFailure({ message: 'internal error' })).toBe('session');
  });
});

describe('settings from the environment', () => {
  it('applies the defaults', () => {
    const settings = readElevenLabsSettings({});
    expect(settings).toEqual({
      baseUrl: 'wss://api.elevenlabs.io',
      stt: { modelId: 'scribe_v2_realtime', audioFormat: 'pcm_16000', commitStrategy: 'vad', vadSilenceSeconds: null, includeTimestamps: false },
      tts: { modelId: 'eleven_flash_v2_5', outputFormat: 'pcm_16000', chunkLengthSchedule: [120, 160, 250, 290] },
      translatorModel: 'claude-haiku-5-5',
    });
  });

  it('reads overrides and rejects invalid values with Spanish messages', () => {
    const settings = readElevenLabsSettings({
      ELEVENLABS_BASE_URL: 'ws://127.0.0.1:9/',
      ELEVENLABS_STT_COMMIT_STRATEGY: 'manual',
      ELEVENLABS_STT_VAD_SILENCE_SECONDS: '1.2',
      ELEVENLABS_STT_INCLUDE_TIMESTAMPS: 'true',
      ELEVENLABS_TTS_OUTPUT_FORMAT: 'ulaw_8000',
      ELEVENLABS_TTS_CHUNK_SCHEDULE: '50, 90',
      TRANSLATOR_MODEL: 'claude-sonnet-5-5',
    });
    expect(settings.baseUrl).toBe('ws://127.0.0.1:9');
    expect(settings.stt).toMatchObject({ commitStrategy: 'manual', vadSilenceSeconds: 1.2, includeTimestamps: true });
    expect(settings.tts).toMatchObject({ outputFormat: 'ulaw_8000', chunkLengthSchedule: [50, 90] });
    expect(settings.translatorModel).toBe('claude-sonnet-5-5');

    const expectConfigError = (env: Record<string, string>, fragment: string): void => {
      expect(() => readElevenLabsSettings(env)).toThrowError(ElevenLabsConfigError);
      expect(() => readElevenLabsSettings(env)).toThrowError(fragment);
    };
    expectConfigError({ ELEVENLABS_TTS_OUTPUT_FORMAT: 'mp3_44100_128' }, 'ELEVENLABS_TTS_OUTPUT_FORMAT');
    expectConfigError({ ELEVENLABS_STT_AUDIO_FORMAT: 'opus' }, 'ELEVENLABS_STT_AUDIO_FORMAT');
    expectConfigError({ ELEVENLABS_STT_COMMIT_STRATEGY: 'auto' }, 'manual, vad, turn_prediction');
    expectConfigError({ ELEVENLABS_BASE_URL: 'https://api.elevenlabs.io' }, 'wss://');
    expectConfigError({ ELEVENLABS_STT_VAD_SILENCE_SECONDS: '9' }, 'entre 0.3 y 3.0');
    expectConfigError({ ELEVENLABS_TTS_CHUNK_SCHEDULE: '120,abc' }, 'ELEVENLABS_TTS_CHUNK_SCHEDULE');
  });

  it('resolves voices per language without defaults', () => {
    const env = { ELEVENLABS_VOICE_ES: 'voice-es', ELEVENLABS_VOICE_PT: ' voice-pt ' };
    expect(voiceIdFor(env, 'es')).toBe('voice-es');
    expect(voiceIdFor(env, 'pt-BR')).toBe('voice-pt');
    expect(voiceIdFor(env, 'fr')).toBeNull();
    expect(voiceIdFor(env, 'xx')).toBeNull();
    expect(missingVoiceMessage('fr')).toContain('ELEVENLABS_VOICE_FR');
    expect(missingVoiceMessage('fr')).toContain('Francés');
    expect(missingVoiceMessage('xx')).toContain('no es un idioma conocido');
  });
});
