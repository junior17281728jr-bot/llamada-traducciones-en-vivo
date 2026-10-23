/**
 * Everything this package believes about the ElevenLabs realtime APIs, in ONE place.
 *
 * UNVERIFIED: every path, query parameter, message field, error type and close code below comes
 * from summaries of the ElevenLabs documentation and from memory. Nothing has been checked
 * against the real service (no access from this environment). When something turns out to be
 * different, change it here only: the STT/TTS clients never spell these names themselves.
 *
 * Each constant carries its own UNVERIFIED note so a reviewer can tick them off one by one.
 */
import { normalizeLanguageCode, parseAudioFormat, type WireAudioFormat } from '@tw/shared';

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

/** UNVERIFIED: WebSocket base of the public API (`ELEVENLABS_BASE_URL` overrides it for local simulators). */
export const ELEVENLABS_DEFAULT_BASE_URL = 'wss://api.elevenlabs.io';

/** UNVERIFIED: the API key travels in this HTTP header during the WebSocket upgrade. */
export const ELEVENLABS_AUTH_HEADER = 'xi-api-key';

/**
 * UNVERIFIED: alternative placement of the key inside the first TTS message (`xi_api_key`). Not used:
 * the key would then be part of a message body and could end up in a log by mistake.
 */
export const TTS_FIRST_MESSAGE_KEY_FIELD = 'xi_api_key';

// ---------------------------------------------------------------------------
// Speech to text: Scribe v2 Realtime
// ---------------------------------------------------------------------------

/** UNVERIFIED: realtime transcription endpoint. */
export const STT_PATH = '/v1/speech-to-text/realtime';
/** UNVERIFIED: realtime model id. */
export const STT_DEFAULT_MODEL = 'scribe_v2_realtime';
export const STT_COMMIT_STRATEGIES = ['manual', 'vad', 'turn_prediction'] as const;
export type SttCommitStrategy = (typeof STT_COMMIT_STRATEGIES)[number];
export const STT_DEFAULT_COMMIT_STRATEGY: SttCommitStrategy = 'vad';
export const STT_DEFAULT_AUDIO_FORMAT: WireAudioFormat = 'pcm_16000';

/** UNVERIFIED: query parameter names of the STT URL. */
export const STT_QUERY = {
  modelId: 'model_id',
  /** Omitted when auto-detecting the language. */
  languageCode: 'language_code',
  audioFormat: 'audio_format',
  commitStrategy: 'commit_strategy',
  includeTimestamps: 'include_timestamps',
  includeLanguageDetection: 'include_language_detection',
  /** Only meaningful with `commit_strategy=vad`. */
  vadSilenceSeconds: 'vad_silence_threshold_secs',
} as const;

/** UNVERIFIED: the only client message type; audio is base64 of the bytes in `audio_format`. */
export const STT_CLIENT_MESSAGE_TYPE = 'input_audio_chunk';

/** UNVERIFIED: server message types. */
export const STT_SERVER_MESSAGE = {
  sessionStarted: 'session_started',
  partial: 'partial_transcript',
  committed: 'committed_transcript',
  committedWithTimestamps: 'committed_transcript_with_timestamps',
  /** Generic envelope some errors may use (`{message_type:'error', error:'...'}`). */
  error: 'error',
} as const;

/** UNVERIFIED: error message types the server may send as `message_type`. */
export const STT_ERROR_TYPES = [
  'session_time_limit_exceeded',
  'insufficient_audio_activity',
  'commit_throttled',
  'queue_overflow',
  'chunk_size_exceeded',
  'rate_limited',
  'quota_exceeded',
  'auth_error',
  'input_error',
  'transcriber_error',
] as const;
export type SttErrorType = (typeof STT_ERROR_TYPES)[number];

/**
 * What the client does with each error type. `ignore`: log and carry on (the session is still
 * usable). `reconnect`: the session is gone; open a new one and replay the unconfirmed audio.
 * `fatal`: nothing to retry; report and stop. UNVERIFIED like the names themselves.
 */
export type SttErrorPolicy = 'ignore' | 'reconnect' | 'fatal';
export const STT_ERROR_POLICY: Record<SttErrorType, SttErrorPolicy> = {
  session_time_limit_exceeded: 'reconnect',
  insufficient_audio_activity: 'ignore',
  commit_throttled: 'ignore',
  queue_overflow: 'reconnect',
  chunk_size_exceeded: 'ignore',
  rate_limited: 'reconnect',
  quota_exceeded: 'fatal',
  auth_error: 'fatal',
  input_error: 'fatal',
  transcriber_error: 'reconnect',
};

/** UNVERIFIED: alternative field names tolerated when reading transcripts. */
export const STT_FIELDS = {
  text: ['text', 'transcript'],
  language: ['language_code', 'language', 'detected_language'],
  probability: ['language_probability', 'language_confidence', 'probability'],
  sessionId: ['session_id', 'id'],
  words: ['words'],
  errorText: ['message', 'error', 'detail'],
} as const;

export interface SttUrlParams {
  baseUrl: string;
  modelId: string;
  audioFormat: WireAudioFormat;
  commitStrategy: SttCommitStrategy;
  lang?: string | undefined;
  includeTimestamps: boolean;
  vadSilenceSeconds?: number | null | undefined;
}

export function buildSttUrl(params: SttUrlParams): string {
  const url = new URL(STT_PATH, normaliseBase(params.baseUrl));
  url.searchParams.set(STT_QUERY.modelId, params.modelId);
  if (params.lang) url.searchParams.set(STT_QUERY.languageCode, params.lang);
  url.searchParams.set(STT_QUERY.audioFormat, params.audioFormat);
  url.searchParams.set(STT_QUERY.commitStrategy, params.commitStrategy);
  url.searchParams.set(STT_QUERY.includeTimestamps, String(params.includeTimestamps));
  url.searchParams.set(STT_QUERY.includeLanguageDetection, 'true');
  if (params.commitStrategy === 'vad' && params.vadSilenceSeconds != null) {
    url.searchParams.set(STT_QUERY.vadSilenceSeconds, String(params.vadSilenceSeconds));
  }
  return url.toString();
}

/** UNVERIFIED shape: `{message_type:'input_audio_chunk', audio_base_64, commit, sample_rate}`. */
export function buildSttAudioMessage(audioBase64: string, commit: boolean, sampleRate: number): Record<string, unknown> {
  return { message_type: STT_CLIENT_MESSAGE_TYPE, audio_base_64: audioBase64, commit, sample_rate: sampleRate };
}

export type SttServerEvent =
  | { kind: 'session_started'; sessionId: string | null }
  | { kind: 'partial'; text: string; lang: string | null }
  | {
      kind: 'committed';
      text: string;
      lang: string | null;
      probability: number | null;
      /** Milliseconds derived from the message timestamps, when it carries any. */
      startMs: number | null;
      endMs: number | null;
      withTimestamps: boolean;
    }
  | { kind: 'error'; type: string; message: string; policy: SttErrorPolicy }
  | { kind: 'unknown'; type: string | null };

/** Tolerant reader of one decoded server message. Never throws. */
export function parseSttServerMessage(data: unknown): SttServerEvent {
  if (!isRecord(data)) return { kind: 'unknown', type: null };
  const type = typeof data.message_type === 'string' ? data.message_type : typeof data.type === 'string' ? data.type : null;

  if (type && (STT_ERROR_TYPES as readonly string[]).includes(type)) {
    return { kind: 'error', type, message: pickString(data, STT_FIELDS.errorText) ?? type, policy: STT_ERROR_POLICY[type as SttErrorType] };
  }
  if (type === STT_SERVER_MESSAGE.error || (type === null && typeof data.error === 'string')) {
    const code = typeof data.error === 'string' ? data.error : typeof data.code === 'string' ? data.code : 'error';
    const known = (STT_ERROR_TYPES as readonly string[]).includes(code) ? STT_ERROR_POLICY[code as SttErrorType] : 'reconnect';
    return { kind: 'error', type: code, message: pickString(data, STT_FIELDS.errorText) ?? code, policy: known };
  }
  switch (type) {
    case STT_SERVER_MESSAGE.sessionStarted:
      return { kind: 'session_started', sessionId: pickString(data, STT_FIELDS.sessionId) };
    case STT_SERVER_MESSAGE.partial:
      return { kind: 'partial', text: pickString(data, STT_FIELDS.text) ?? '', lang: normalizeLanguageCode(pickString(data, STT_FIELDS.language)) };
    case STT_SERVER_MESSAGE.committed:
    case STT_SERVER_MESSAGE.committedWithTimestamps: {
      const span = readTimestamps(data);
      return {
        kind: 'committed',
        text: pickString(data, STT_FIELDS.text) ?? '',
        lang: normalizeLanguageCode(pickString(data, STT_FIELDS.language)),
        probability: pickProbability(data),
        startMs: span?.startMs ?? null,
        endMs: span?.endMs ?? null,
        withTimestamps: type === STT_SERVER_MESSAGE.committedWithTimestamps,
      };
    }
    default:
      return { kind: 'unknown', type };
  }
}

// ---------------------------------------------------------------------------
// Text to speech: WebSocket "stream-input"
// ---------------------------------------------------------------------------

/** UNVERIFIED: streaming synthesis endpoint; `{voice_id}` is replaced. */
export const TTS_PATH_TEMPLATE = '/v1/text-to-speech/{voice_id}/stream-input';
/** UNVERIFIED: low-latency model id. */
export const TTS_DEFAULT_MODEL = 'eleven_flash_v2_5';
/**
 * UNVERIFIED: `pcm_16000` is NOT confirmed as an accepted `output_format` (documented ones seen in
 * summaries: mp3_44100_128, ulaw_8000, alaw_8000, pcm_44100). Any `pcm_*`, `ulaw_8000` or
 * `alaw_8000` value is decoded here; mp3 is not.
 */
export const TTS_DEFAULT_OUTPUT_FORMAT: WireAudioFormat = 'pcm_16000';
/** Formats this package can turn back into PCM16 16 kHz (see `parseAudioFormat` in @tw/shared). */
export const TTS_DECODABLE_OUTPUT_FORMATS: readonly WireAudioFormat[] = [
  'pcm_8000',
  'pcm_16000',
  'pcm_22050',
  'pcm_24000',
  'pcm_44100',
  'pcm_48000',
  'ulaw_8000',
  'alaw_8000',
];
/** UNVERIFIED: query parameter names of the TTS URL. */
export const TTS_QUERY = { modelId: 'model_id', outputFormat: 'output_format' } as const;
/** UNVERIFIED: characters buffered before each generation step. */
export const TTS_DEFAULT_CHUNK_LENGTH_SCHEDULE: readonly number[] = [120, 160, 250, 290];
/** UNVERIFIED: voice settings sent in the first message. */
export const TTS_DEFAULT_VOICE_SETTINGS: Readonly<Record<string, number | boolean>> = { stability: 0.5, similarity_boost: 0.8 };
/** UNVERIFIED: the server closes a silent connection after about this long... */
export const TTS_INACTIVITY_TIMEOUT_MS = 20_000;
/** ...so an idle connection sends a keep-alive this often. */
export const TTS_KEEPALIVE_INTERVAL_MS = 10_000;

export function ttsPath(voiceId: string): string {
  return TTS_PATH_TEMPLATE.replace('{voice_id}', encodeURIComponent(voiceId));
}

export function buildTtsUrl(params: { baseUrl: string; voiceId: string; modelId: string; outputFormat: WireAudioFormat }): string {
  const url = new URL(ttsPath(params.voiceId), normaliseBase(params.baseUrl));
  url.searchParams.set(TTS_QUERY.modelId, params.modelId);
  url.searchParams.set(TTS_QUERY.outputFormat, params.outputFormat);
  return url.toString();
}

/** UNVERIFIED: first message (`text: ' '` opens the stream and carries the settings). */
export function buildTtsInitMessage(options: {
  voiceSettings?: Readonly<Record<string, unknown>> | undefined;
  chunkLengthSchedule?: readonly number[] | undefined;
}): Record<string, unknown> {
  return {
    text: ' ',
    voice_settings: { ...TTS_DEFAULT_VOICE_SETTINGS, ...(options.voiceSettings ?? {}) },
    generation_config: { chunk_length_schedule: [...(options.chunkLengthSchedule ?? TTS_DEFAULT_CHUNK_LENGTH_SCHEDULE)] },
  };
}

/** UNVERIFIED: text chunk; a trailing space marks a word boundary for the server. */
export function buildTtsTextMessage(text: string): Record<string, unknown> {
  return { text: text.endsWith(' ') ? text : `${text} `, try_trigger_generation: true };
}
/** UNVERIFIED: forces generation of everything buffered without closing the stream. */
export const TTS_FLUSH_MESSAGE: Readonly<Record<string, unknown>> = { text: ' ', flush: true };
/** UNVERIFIED: end of stream; the server answers with `isFinal: true` and closes. */
export const TTS_CLOSE_MESSAGE: Readonly<Record<string, unknown>> = { text: '' };
/** UNVERIFIED: a lone space keeps an idle connection open. */
export const TTS_KEEPALIVE_MESSAGE: Readonly<Record<string, unknown>> = { text: ' ' };

/** Why the TTS client ends each phrase with the close message instead of only `flush`: see `TtsServerEvent`. */
export const TTS_PHRASE_END_NOTE =
  'The only end-of-audio signal we know of is `isFinal` after the close message, so every phrase gets its own connection and the next one is pre-opened in the background.';

export type TtsServerEvent =
  | { kind: 'audio'; audioBase64: string; isFinal: boolean }
  | { kind: 'final' }
  | { kind: 'error'; code: string | null; message: string }
  | { kind: 'unknown' };

/** UNVERIFIED shape: `{audio: base64|null, isFinal: boolean|null, normalizedAlignment, alignment}` or `{error, message, code}`. */
export function parseTtsServerMessage(data: unknown): TtsServerEvent {
  if (!isRecord(data)) return { kind: 'unknown' };
  if (typeof data.error === 'string' || typeof data.error_code === 'string' || (typeof data.message === 'string' && data.audio === undefined && data.isFinal === undefined)) {
    const code = typeof data.error === 'string' ? data.error : typeof data.error_code === 'string' ? data.error_code : typeof data.code === 'string' || typeof data.code === 'number' ? String(data.code) : null;
    const message = typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error : 'error';
    return { kind: 'error', code, message };
  }
  const isFinal = data.isFinal === true || data.is_final === true;
  if (typeof data.audio === 'string' && data.audio.length > 0) return { kind: 'audio', audioBase64: data.audio, isFinal };
  if (isFinal) return { kind: 'final' };
  if (data.audio === null || data.audio === '' || 'normalizedAlignment' in data || 'alignment' in data) return { kind: 'audio', audioBase64: '', isFinal: false };
  return { kind: 'unknown' };
}

export type TtsFailureKind = 'auth' | 'quota' | 'rate_limited' | 'config' | 'session';

/**
 * UNVERIFIED mapping of TTS error texts and close codes to a failure kind. 1008 (policy violation)
 * is what the service is believed to use for authentication and quota problems.
 */
export function classifyTtsFailure(input: { code?: string | number | null; message?: string | null }): TtsFailureKind {
  const text = `${input.code ?? ''} ${input.message ?? ''}`.toLowerCase();
  if (/api[_ -]?key|unauthori[sz]ed|authenticat|forbidden|invalid_key|permission/.test(text)) return 'auth';
  if (/quota|credit|insufficient|exceeded your/.test(text)) return 'quota';
  if (/rate[_ -]?limit|too many|429|concurren/.test(text)) return 'rate_limited';
  if (/voice.*(not found|does not exist|invalid)|invalid.*voice|model.*(not found|does not exist)|output_format/.test(text)) return 'config';
  if (input.code === 1008 || input.code === '1008') return 'auth';
  return 'session';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normaliseBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '') + '/';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(data: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string') return value;
  }
  return null;
}

function pickProbability(data: Record<string, unknown>): number | null {
  for (const key of STT_FIELDS.probability) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.min(1, Math.max(0, value));
  }
  return null;
}

/**
 * UNVERIFIED: timestamps may come as `words[{start,end}]` in seconds, as `start_time`/`end_time` in
 * seconds, or as `start_ms`/`end_ms`. Anything else is ignored (the client falls back to its audio clock).
 */
function readTimestamps(data: Record<string, unknown>): { startMs: number; endMs: number } | null {
  const seconds = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) : null);
  const millis = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null);
  const direct = { startMs: millis(data.start_ms), endMs: millis(data.end_ms) };
  if (direct.startMs !== null && direct.endMs !== null) return direct as { startMs: number; endMs: number };
  const timed = { startMs: seconds(data.start_time ?? data.start), endMs: seconds(data.end_time ?? data.end) };
  if (timed.startMs !== null && timed.endMs !== null) return timed as { startMs: number; endMs: number };
  const words = data.words;
  if (Array.isArray(words) && words.length > 0) {
    const first = words.find(isRecord);
    const last = [...words].reverse().find(isRecord);
    const startMs = first ? seconds(first.start ?? first.start_time) : null;
    const endMs = last ? seconds(last.end ?? last.end_time) : null;
    if (startMs !== null && endMs !== null) return { startMs, endMs };
  }
  return null;
}

/** Validates a format name against what this package can decode; returns the parsed sample rate. */
export function assertDecodableFormat(format: string): WireAudioFormat {
  parseAudioFormat(format);
  return format as WireAudioFormat;
}
