/**
 * Operator protocol (desktop app <-> server), HTTP API types and simulator protocol (WS /sim).
 *
 * Control messages are JSON text frames validated with zod. Audio and audio levels travel in
 * binary frames (see "Binary frames"). Each operator connection serves ONE call at a time, so
 * binary frames carry no callId; JSON messages that belong to a call do.
 */
import { z } from 'zod';
import { EnvelopeMeter, INTERNAL_SAMPLE_RATE, type EnvelopeWindow } from './audio.js';
import { LANGUAGE_CODES } from './languages.js';
import {
  CALL_END_REASONS,
  CALL_STATES,
  CHANNEL_KINDS,
  DIRECTIONS,
  LANGUAGE_MODES,
  LANGUAGE_NOTICE_KINDS,
  LANGUAGE_SIGNAL_SOURCES,
  LANGUAGE_STATUSES,
  OPERATOR_ROLES,
  OPERATOR_STATUSES,
  PIPELINE_DIRECTIONS,
  PIPELINE_STAGES,
  PROVIDER_MODES,
  SERVICE_STATUSES,
  SPEAKERS,
  type CallRecord,
  type Direction,
  type LanguageNotice,
  type LanguageSettings,
  type LanguageState,
  type OperatorInfo,
  type OperatorPreferences,
  type PartialLanguageSettings,
  type PipelineStageEvent,
  type TranscriptSegment,
} from './types.js';

export const PROTOCOL_VERSION = 1 as const;
/** WebSocket path the operator apps connect to. */
export const OPERATOR_WS_PATH = '/operator';
/** WebSocket path of the passenger simulator (only exposed with the mock channel). */
export const SIM_WS_PATH = '/sim';
/** Upper bound for a JSON control message, in characters. */
export const MAX_CONTROL_MESSAGE_LENGTH = 64 * 1024;

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

const CallIdSchema = z.string().min(1).max(128);
/** Strict: a language code from the shared catalogue (what the operator UI offers). */
export const LanguageCodeSchema = z.enum(LANGUAGE_CODES);
/** Lenient: any language tag a provider may report (e.g. `und` or a code outside the catalogue). */
const LangTagSchema = z.string().min(2).max(16);
const PhoneNumberSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^\+?[0-9 ()\-.]+$/, 'Invalid phone number');
const TimestampSchema = z.number().nonnegative();

export const PassengerSpeaksSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }),
  z.object({ mode: z.literal('fixed'), lang: LanguageCodeSchema }),
]);

export const PassengerHearsSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('follow') }),
  z.object({ mode: z.literal('fixed'), lang: LanguageCodeSchema }),
]);

export const LanguageSettingsSchema = z.object({
  operatorLang: LanguageCodeSchema,
  passengerSpeaks: PassengerSpeaksSchema,
  passengerHears: PassengerHearsSchema,
});

/** Any subset of the settings; omitted keys keep their current value. */
export const PartialLanguageSettingsSchema = LanguageSettingsSchema.partial();

export const LanguageStateSchema = z.object({
  lang: LangTagSchema.nullable(),
  status: z.enum(LANGUAGE_STATUSES),
  source: z.enum(LANGUAGE_SIGNAL_SOURCES).nullable(),
  probability: z.number().min(0).max(1).nullable(),
  agreeingSegments: z.number().int().nonnegative(),
});

export const LanguageNoticeSchema = z.object({
  kind: z.enum(LANGUAGE_NOTICE_KINDS),
  lang: LangTagSchema.nullable(),
  candidates: z.object({ stt: LangTagSchema.nullable(), translator: LangTagSchema.nullable() }),
  at: TimestampSchema,
});

export const TranscriptSegmentSchema = z.object({
  id: z.string().min(1).max(128),
  callId: CallIdSchema,
  speaker: z.enum(SPEAKERS),
  originalLang: LangTagSchema.nullable(),
  originalText: z.string(),
  translatedLang: LangTagSchema.nullable(),
  translatedText: z.string().nullable(),
  startMs: TimestampSchema,
  endMs: TimestampSchema,
  final: z.boolean(),
  createdAt: TimestampSchema,
});

export const OperatorInfoSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  role: z.enum(OPERATOR_ROLES),
  status: z.enum(OPERATOR_STATUSES),
  currentCallId: CallIdSchema.nullable(),
  autoAccept: z.boolean(),
});

export const PipelineStageEventSchema = z.object({
  direction: z.enum(PIPELINE_DIRECTIONS),
  stage: z.enum(PIPELINE_STAGES),
  segmentId: z.string().min(1).max(128).optional(),
  detail: z.string().max(500).optional(),
});

export const OperatorPreferencesSchema = z.object({
  operatorLang: LanguageCodeSchema,
  defaultMode: z.enum(LANGUAGE_MODES),
  defaultPassengerSpeaks: LanguageCodeSchema.nullable(),
  defaultPassengerHears: LanguageCodeSchema.nullable(),
  autoAccept: z.boolean(),
});

// ---------------------------------------------------------------------------
// Client -> server (JSON)
// ---------------------------------------------------------------------------

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('auth.login'),
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(256),
  }),
  z.object({ type: z.literal('auth.resume'), token: z.string().min(1).max(2048) }),
  z.object({ type: z.literal('call.accept'), callId: CallIdSchema }),
  z.object({ type: z.literal('call.reject'), callId: CallIdSchema }),
  z.object({ type: z.literal('call.hangup'), callId: CallIdSchema }),
  /**
   * Outbound call. `languages` is optional: omitted keys come from the operator's saved
   * preferences; `passengerSpeaks: {mode:'auto'}` leaves detection on.
   */
  z.object({
    type: z.literal('call.dial'),
    number: PhoneNumberSchema,
    languages: PartialLanguageSettingsSchema.optional(),
  }),
  /** Live change from the operator. Applies to the NEXT phrases, never cuts audio that is playing. */
  z.object({
    type: z.literal('call.setLanguages'),
    callId: CallIdSchema,
    settings: PartialLanguageSettingsSchema,
  }),
  /** Mutes the operator's microphone: nothing is translated or sent to the passenger while muted. */
  z.object({ type: z.literal('call.mute'), callId: CallIdSchema, muted: z.boolean() }),
  /** Simulated mode only: injects `text` as if the passenger had said it in `lang`. */
  z.object({ type: z.literal('debug.say'), text: z.string().min(1).max(2000), lang: LanguageCodeSchema }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageType = ClientMessage['type'];

// ---------------------------------------------------------------------------
// Server -> client (JSON)
// ---------------------------------------------------------------------------

export const AUTH_ERROR_CODES = [
  'invalid_credentials',
  'token_invalid',
  'token_expired',
  'already_connected',
  'rate_limited',
] as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export const ERROR_CODES = [
  'bad_message',
  'not_authenticated',
  'unknown_call',
  'operator_busy',
  'max_calls_reached',
  'dial_permission_required',
  'dial_failed',
  'invalid_number',
  'debug_disabled',
  'pipeline_error',
  'internal_error',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ServiceStatusSchema = z.enum(SERVICE_STATUSES);

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('auth.ok'),
    operator: OperatorInfoSchema,
    /** Opaque token for `auth.resume` after a reconnect. */
    token: z.string().min(1),
    server: z.object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      providers: z.enum(PROVIDER_MODES),
      channel: z.enum(CHANNEL_KINDS),
      /** True when `debug.say` is accepted (simulated providers only). */
      debug: z.boolean(),
      maxCalls: z.number().int().positive(),
    }),
  }),
  z.object({ type: z.literal('auth.error'), code: z.enum(AUTH_ERROR_CODES), message: z.string() }),
  /** Operator roster and load; broadcast whenever it changes. */
  z.object({
    type: z.literal('presence'),
    operators: z.array(OperatorInfoSchema),
    activeCalls: z.number().int().nonnegative(),
    maxCalls: z.number().int().positive(),
  }),
  /** A call is offered to this operator. */
  z.object({
    type: z.literal('call.incoming'),
    callId: CallIdSchema,
    from: z.string(),
    /** Language hint known before audio flows (channel metadata); not the detected language. */
    langHint: LangTagSchema.optional(),
    ringTimeoutSeconds: z.number().positive().optional(),
    /** True when the server answers on the operator's behalf (auto-accept). */
    autoAccept: z.boolean().optional(),
  }),
  /** Sent on every state change and when the mute flag changes. */
  z.object({
    type: z.literal('call.state'),
    callId: CallIdSchema,
    state: z.enum(CALL_STATES),
    direction: z.enum(DIRECTIONS),
    remoteNumber: z.string(),
    answeredAt: TimestampSchema.nullable(),
    muted: z.boolean(),
    /** True when the channel is the simulator: the UI must show "Simulado". */
    simulated: z.boolean(),
  }),
  /** Current language picture; sent when the call starts and whenever any part changes. */
  z.object({
    type: z.literal('call.languages'),
    callId: CallIdSchema,
    settings: LanguageSettingsSchema,
    /** Detected passenger language, its confidence and the signal that produced it. */
    detected: LanguageStateSchema,
    /** Last warning that still applies (uncertain / changed / fallback used), or null. */
    notice: LanguageNoticeSchema.nullable(),
  }),
  z.object({
    type: z.literal('call.ended'),
    callId: CallIdSchema,
    reason: z.enum(CALL_END_REASONS),
    durationMs: z.number().nonnegative(),
  }),
  /** Partial updates share `segment.id` with their final version. */
  z.object({ type: z.literal('transcript.segment'), segment: TranscriptSegmentSchema }),
  /** Per-direction stage chip: receiving / transcribing / translating / speaking / idle / error. */
  PipelineStageEventSchema.extend({
    type: z.literal('pipeline.stage'),
    callId: CallIdSchema,
  }),
  /** Health of the external dependencies; `simulated` means a local mock, never a real service. */
  z.object({
    type: z.literal('system.status'),
    elevenlabs: ServiceStatusSchema,
    translator: ServiceStatusSchema,
    channel: ServiceStatusSchema,
    /** Optional human-readable reason per service (shown next to a degraded/down status). */
    detail: z
      .object({
        elevenlabs: z.string().max(500).optional(),
        translator: z.string().max(500).optional(),
        channel: z.string().max(500).optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal('error'),
    code: z.enum(ERROR_CODES),
    message: z.string(),
    callId: CallIdSchema.optional(),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageType = ServerMessage['type'];

// ---------------------------------------------------------------------------
// Simulator protocol (WS /sim). One socket simulates one passenger phone.
// ---------------------------------------------------------------------------

const Base64Schema = z.string().max(2_000_000);

export const SimClientMessageSchema = z.discriminatedUnion('type', [
  /** The simulated passenger calls in. */
  z.object({ type: z.literal('sim.incoming'), from: PhoneNumberSchema, lang: LanguageCodeSchema }),
  /** The socket acts as an idle phone: the next outbound call dialed by an operator rings here. */
  z.object({ type: z.literal('sim.listen'), lang: LanguageCodeSchema }),
  /** Picks up an outbound call that is ringing on this socket. */
  z.object({ type: z.literal('sim.answer') }),
  /**
   * The passenger says `text` in `lang`. `audio` (PCM16 16 kHz mono, base64) is the signal the
   * simulator synthesised for it; when absent the server synthesises one of matching length.
   * The text travels out of band because simulated STT cannot recognise a synthetic signal.
   */
  z.object({
    type: z.literal('sim.say'),
    text: z.string().min(1).max(2000),
    lang: LanguageCodeSchema,
    audio: Base64Schema.optional(),
  }),
  /** Continuous passenger audio (PCM16 16 kHz mono, base64), including digital silence between phrases. */
  z.object({ type: z.literal('sim.audio'), audio: Base64Schema }),
  z.object({ type: z.literal('sim.hangup') }),
]);
export type SimClientMessage = z.infer<typeof SimClientMessageSchema>;

export const SimServerMessageSchema = z.discriminatedUnion('type', [
  /** What the passenger hears (the operator's translated voice), PCM16 16 kHz mono in base64. */
  z.object({ type: z.literal('sim.audio'), audio: Base64Schema, text: z.string().optional() }),
  z.object({
    type: z.literal('sim.state'),
    state: z.enum(CALL_STATES),
    callId: CallIdSchema.nullable(),
    direction: z.enum(DIRECTIONS).optional(),
    remoteNumber: z.string().optional(),
    reason: z.enum(CALL_END_REASONS).optional(),
  }),
]);
export type SimServerMessage = z.infer<typeof SimServerMessageSchema>;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseWith<T>(schema: z.ZodType<T>, raw: string): ParseResult<T> {
  if (raw.length > MAX_CONTROL_MESSAGE_LENGTH) return { ok: false, error: 'Message too large' };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Invalid JSON' };
  }
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  const detail = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
  return { ok: false, error: detail.join('; ') };
}

/** Validates a JSON text frame sent by an operator app. */
export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  return parseWith(ClientMessageSchema, raw);
}

/** Validates a JSON text frame sent by the server. */
export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  return parseWith(ServerMessageSchema, raw);
}

export function parseSimClientMessage(raw: string): ParseResult<SimClientMessage> {
  return parseWith(SimClientMessageSchema, raw);
}

export function parseSimServerMessage(raw: string): ParseResult<SimServerMessage> {
  return parseWith(SimServerMessageSchema, raw);
}

/** Serialises any protocol message to a JSON text frame. */
export function encodeMessage(message: ClientMessage | ServerMessage | SimClientMessage | SimServerMessage): string {
  return JSON.stringify(message);
}

// ---------------------------------------------------------------------------
// Binary frames
//
// byte 0       frame type
// audio types  bytes 1..: PCM16 little-endian, mono, 16 kHz (whole samples)
// 0x10 levels  see `encodeLevelsFrame`
// ---------------------------------------------------------------------------

export const AudioFrameType = {
  /** Operator microphone, client -> server. */
  OperatorMic: 0x01,
  /** Passenger voice translated to the operator's language, server -> client. */
  TranslatedPassenger: 0x02,
  /** Passenger's original voice, server -> client. */
  OriginalPassenger: 0x03,
} as const;
export type AudioFrameTypeValue = (typeof AudioFrameType)[keyof typeof AudioFrameType];

/** Audio levels (waveform envelopes), server -> client. */
export const LEVELS_FRAME_TYPE = 0x10 as const;

/** Frame types the server accepts from an operator app. */
export const SERVER_ACCEPTED_FRAME_TYPES: readonly number[] = [AudioFrameType.OperatorMic];
/** Frame types an operator app accepts from the server. */
export const CLIENT_ACCEPTED_FRAME_TYPES: readonly number[] = [
  AudioFrameType.TranslatedPassenger,
  AudioFrameType.OriginalPassenger,
  LEVELS_FRAME_TYPE,
];

/** Largest accepted audio payload: one second of PCM16 mono 16 kHz. */
export const MAX_AUDIO_PAYLOAD_BYTES = 16_000 * 2;

const AUDIO_FRAME_TYPES: readonly number[] = Object.values(AudioFrameType);

/** Prefixes `pcm` (PCM16 16 kHz mono) with the frame-type byte. */
export function encodeAudioFrame(type: AudioFrameTypeValue, pcm: Uint8Array): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(pcm.byteLength + 1);
  frame[0] = type;
  frame.set(pcm, 1);
  return frame;
}

export interface AudioFrame {
  type: AudioFrameTypeValue;
  /** PCM16 payload (a view into the received frame, no copy). */
  pcm: Uint8Array;
}

/**
 * Parses an audio frame. Pass `allowed` to accept only the types valid for the receiving
 * side (server: `[OperatorMic]`, client: the two passenger types).
 */
export function decodeAudioFrame(
  data: Uint8Array,
  allowed: readonly number[] = AUDIO_FRAME_TYPES,
): ParseResult<AudioFrame> {
  if (data.byteLength < 1) return { ok: false, error: 'Empty audio frame' };
  const type = data[0]!;
  if (!AUDIO_FRAME_TYPES.includes(type)) return { ok: false, error: `Unknown audio frame type 0x${type.toString(16)}` };
  if (!allowed.includes(type)) {
    return { ok: false, error: `Audio frame type 0x${type.toString(16)} not allowed here` };
  }
  const payload = data.byteLength - 1;
  if (payload % 2 !== 0) return { ok: false, error: 'Audio payload is not whole PCM16 samples' };
  if (payload > MAX_AUDIO_PAYLOAD_BYTES) return { ok: false, error: 'Audio frame too large' };
  return { ok: true, value: { type: type as AudioFrameTypeValue, pcm: data.subarray(1) } };
}

// ---- Levels (0x10) --------------------------------------------------------

/**
 * Which stream a levels frame describes. Pasajero lane = `PassengerIn` (what arrives from the
 * call channel, measured in `ChannelCall.onAudio`). Operador lane = `OperatorIn` (what the
 * server received from the operator microphone). The two `Translated*` tracks measure the
 * synthesised voices and are optional extras.
 */
export const LevelTrack = {
  /** Passenger audio arriving from the call channel. */
  PassengerIn: 0,
  /** Operator microphone audio arriving at the server. */
  OperatorIn: 1,
  /** Translated voice sent towards the operator. */
  TranslatedToOperator: 2,
  /** Translated voice sent towards the passenger. */
  TranslatedToPassenger: 3,
} as const;
export type LevelTrackValue = (typeof LevelTrack)[keyof typeof LevelTrack];

/** Every window in a levels frame covers this many milliseconds of audio. */
export const LEVEL_WINDOW_MS = 20;
export const LEVELS_HEADER_BYTES = 11;
export const LEVELS_WINDOW_BYTES = 6;
export const MAX_LEVEL_WINDOWS_PER_FRAME = 255;

const LEVEL_TRACKS: readonly number[] = Object.values(LevelTrack);

/**
 * Levels frame, all integers little-endian:
 *
 *   offset 0   u8   0x10
 *   offset 1   u8   track (see `LevelTrack`)
 *   offset 2   u32  seq: per-track counter, +1 per frame; a jump means lost frames
 *   offset 6   u32  timeMs: milliseconds since the call was answered, at the START of the first window
 *   offset 10  u8   window count (0..255)
 *   offset 11  count x { i16 min, i16 max, u16 rms }   each window spans LEVEL_WINDOW_MS
 *
 * `min`/`max` are raw int16 sample values; `rms` is the RMS scaled to 0..65535 (full scale = 65535).
 * Decoded windows are normalised ({@link EnvelopeWindow}). Frames with zero windows are valid
 * heartbeats: they keep the lane "connected" while the audio is silent.
 */
export interface LevelsFrame {
  track: LevelTrackValue;
  seq: number;
  timeMs: number;
  windows: EnvelopeWindow[];
}

function clampTo(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function encodeLevelsFrame(frame: LevelsFrame): Uint8Array<ArrayBuffer> {
  const count = frame.windows.length;
  if (count > MAX_LEVEL_WINDOWS_PER_FRAME) throw new RangeError(`Too many windows in one levels frame: ${count}`);
  const out = new Uint8Array(LEVELS_HEADER_BYTES + count * LEVELS_WINDOW_BYTES);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, LEVELS_FRAME_TYPE);
  dv.setUint8(1, frame.track);
  dv.setUint32(2, frame.seq >>> 0, true);
  dv.setUint32(6, Math.max(0, Math.round(frame.timeMs)) >>> 0, true);
  dv.setUint8(10, count);
  let offset = LEVELS_HEADER_BYTES;
  for (const window of frame.windows) {
    dv.setInt16(offset, clampTo(Math.round(window.min * 32768), -32768, 32767), true);
    dv.setInt16(offset + 2, clampTo(Math.round(window.max * 32768), -32768, 32767), true);
    dv.setUint16(offset + 4, clampTo(Math.round(window.rms * 65535), 0, 65535), true);
    offset += LEVELS_WINDOW_BYTES;
  }
  return out;
}

export function decodeLevelsFrame(data: Uint8Array): ParseResult<LevelsFrame> {
  if (data.byteLength < LEVELS_HEADER_BYTES) return { ok: false, error: 'Levels frame too short' };
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (dv.getUint8(0) !== LEVELS_FRAME_TYPE) return { ok: false, error: 'Not a levels frame' };
  const track = dv.getUint8(1);
  if (!LEVEL_TRACKS.includes(track)) return { ok: false, error: `Unknown level track ${track}` };
  const count = dv.getUint8(10);
  if (data.byteLength !== LEVELS_HEADER_BYTES + count * LEVELS_WINDOW_BYTES) {
    return { ok: false, error: 'Levels frame length does not match its window count' };
  }
  const windows: EnvelopeWindow[] = [];
  let offset = LEVELS_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    windows.push({
      min: dv.getInt16(offset, true) / 32768,
      max: dv.getInt16(offset + 2, true) / 32768,
      rms: dv.getUint16(offset + 4, true) / 65535,
    });
    offset += LEVELS_WINDOW_BYTES;
  }
  return {
    ok: true,
    value: { track: track as LevelTrackValue, seq: dv.getUint32(2, true), timeMs: dv.getUint32(6, true), windows },
  };
}

/**
 * Turns the continuous PCM stream of ONE track into levels frames, so the server (channel and
 * operator audio) and the simulator frame levels the same way. One frame per `push` that
 * completed at least one 20 ms window: with 20 ms chunks that is 50 frames per second, with
 * smaller chunks it coalesces, with larger ones a frame carries several windows. `timeMs` follows
 * the number of samples seen (so it assumes the audio is continuous, as the simulator and
 * telephony channels deliver it); `heartbeat` keeps the lane alive when no audio arrives.
 */
export class LevelsFrameBuilder {
  readonly track: LevelTrackValue;
  private readonly meter: EnvelopeMeter;
  private readonly startMs: number;
  private seq = 0;
  private windowsSent = 0;

  /** `startMs`: milliseconds since the call was answered at which this stream starts. */
  constructor(track: LevelTrackValue, startMs = 0, sampleRate: number = INTERNAL_SAMPLE_RATE) {
    this.track = track;
    this.startMs = startMs;
    this.meter = new EnvelopeMeter(sampleRate, LEVEL_WINDOW_MS);
  }

  /** Sequence number the next frame will carry. */
  get nextSeq(): number {
    return this.seq;
  }

  /** Frames for the complete windows contained in `pcm` (none when the chunk did not finish a window). */
  push(pcm: Uint8Array): Uint8Array<ArrayBuffer>[] {
    const windows = this.meter.push(pcm);
    const frames: Uint8Array<ArrayBuffer>[] = [];
    for (let offset = 0; offset < windows.length; offset += MAX_LEVEL_WINDOWS_PER_FRAME) {
      const batch = windows.slice(offset, offset + MAX_LEVEL_WINDOWS_PER_FRAME);
      frames.push(
        encodeLevelsFrame({
          track: this.track,
          seq: this.seq++,
          timeMs: this.startMs + this.windowsSent * LEVEL_WINDOW_MS,
          windows: batch,
        }),
      );
      this.windowsSent += batch.length;
    }
    return frames;
  }

  /** A frame with no windows: "the server is alive, no audio right now". `timeMs` is the current call time. */
  heartbeat(timeMs: number): Uint8Array<ArrayBuffer> {
    return encodeLevelsFrame({ track: this.track, seq: this.seq++, timeMs, windows: [] });
  }
}

// ---- Dispatch -------------------------------------------------------------

export type BinaryFrame = ({ kind: 'audio' } & AudioFrame) | { kind: 'levels'; levels: LevelsFrame };

/** Parses any binary frame; `allowed` restricts the frame types the receiving side accepts. */
export function decodeBinaryFrame(
  data: Uint8Array,
  allowed: readonly number[] = [...AUDIO_FRAME_TYPES, LEVELS_FRAME_TYPE],
): ParseResult<BinaryFrame> {
  if (data.byteLength < 1) return { ok: false, error: 'Empty binary frame' };
  const type = data[0]!;
  if (type === LEVELS_FRAME_TYPE) {
    if (!allowed.includes(type)) return { ok: false, error: 'Levels frame not allowed here' };
    const levels = decodeLevelsFrame(data);
    return levels.ok ? { ok: true, value: { kind: 'levels', levels: levels.value } } : levels;
  }
  const audio = decodeAudioFrame(data, allowed);
  return audio.ok ? { ok: true, value: { kind: 'audio', ...audio.value } } : audio;
}

// ---------------------------------------------------------------------------
// HTTP API (the desktop app and the server share these shapes)
// ---------------------------------------------------------------------------

export const API_PATHS = {
  login: '/api/login',
  languages: '/api/languages',
  preferences: '/api/me/preferences',
  keys: '/api/settings/keys',
  test: (service: string): string => `/api/settings/test/${encodeURIComponent(service)}`,
  calls: '/api/calls',
  call: (id: string): string => `/api/calls/${encodeURIComponent(id)}`,
  callAudio: (id: string, leg: string): string =>
    `/api/calls/${encodeURIComponent(id)}/audio/${encodeURIComponent(leg)}`,
} as const;

/** Body of every non-2xx JSON response. */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

// POST /api/login
export const LoginRequestSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export interface LoginResponse {
  /** Bearer token for the HTTP API and `auth.resume` on the operator WebSocket. */
  token: string;
  expiresAt: number;
  operator: OperatorInfo;
}

// GET /api/languages -> LanguageCatalog (declared in languages.ts)

// GET /api/me/preferences -> OperatorPreferences ; PUT /api/me/preferences (body and response: OperatorPreferences)
export const PutPreferencesRequestSchema = OperatorPreferencesSchema;
export type PutPreferencesRequest = OperatorPreferences;

// GET/PUT /api/settings/keys (admin only). Write-only: values are NEVER returned, only a mask.
export const SECRET_KEY_NAMES = [
  'ELEVENLABS_API_KEY',
  'ANTHROPIC_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'META_ACCESS_TOKEN',
  'META_PHONE_NUMBER_ID',
] as const;
export type SecretKeyName = (typeof SECRET_KEY_NAMES)[number];

export const SECRET_SOURCES = ['settings', 'env', 'none'] as const;
export interface MaskedSecret {
  configured: boolean;
  /** Last 4 characters; null when nothing is saved or the secret is too short to reveal any part. */
  last4: string | null;
  /** When it was saved from Settings (epoch ms); null for environment values and unset keys. */
  savedAt: number | null;
  /** `settings` wins over `env`. */
  source: (typeof SECRET_SOURCES)[number];
}
export interface KeysResponse {
  keys: Record<SecretKeyName, MaskedSecret>;
}
export const PutKeysRequestSchema = z.object({
  /** A string saves the value; null (or an empty string) deletes the saved one. */
  keys: z.partialRecord(z.enum(SECRET_KEY_NAMES), z.string().max(4096).nullable()),
});
export type PutKeysRequest = z.infer<typeof PutKeysRequestSchema>;

// POST /api/settings/test/:service
export const TEST_SERVICES = ['elevenlabs', 'anthropic', 'twilio', 'whatsapp'] as const;
export type TestService = (typeof TEST_SERVICES)[number];

export const CONNECTION_STATUSES = ['ok', 'fail', 'unconfigured', 'simulated'] as const;
/**
 * - `ok`: a real check against the service succeeded.
 * - `fail`: the check ran and failed (see `message`).
 * - `unconfigured`: nothing to test yet (missing key or channel configuration).
 * - `simulated`: the active provider is the mock; NO real service was contacted.
 */
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export interface ConnectionTestResult {
  service: TestService;
  status: ConnectionStatus;
  /** Spanish text for the operator/admin. For `simulated` it says that no real service was contacted. */
  message: string;
  /** False for `simulated` and `unconfigured`. */
  contactedRealService: boolean;
  latencyMs: number | null;
  testedAt: number;
}

// GET /api/calls , GET /api/calls/:id , GET /api/calls/:id/audio/:leg
export const RECORDING_LEGS = ['mixed', 'passenger', 'operator'] as const;
export type RecordingLeg = (typeof RECORDING_LEGS)[number];

export interface ListCallsQuery {
  limit?: number;
  /** Only calls created before this epoch-ms timestamp (paging). */
  before?: number;
  operatorId?: string;
  direction?: Direction;
}
export interface ListCallsResponse {
  calls: CallRecord[];
}
export interface CallDetailResponse {
  call: CallRecord;
  segments: TranscriptSegment[];
}
/** The audio endpoint answers `audio/wav` (PCM16 16 kHz mono), or 404 when there is no recording. */
export const RECORDING_CONTENT_TYPE = 'audio/wav' as const;

// ---------------------------------------------------------------------------
// Compile-time guard: zod schemas must stay in sync with the plain TS types.
// ---------------------------------------------------------------------------

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type _ProtocolTypeGuards = [
  Assert<Equal<z.infer<typeof TranscriptSegmentSchema>, TranscriptSegment>>,
  Assert<Equal<z.infer<typeof OperatorInfoSchema>, OperatorInfo>>,
  Assert<Equal<z.infer<typeof LanguageSettingsSchema>, LanguageSettings>>,
  Assert<Equal<z.infer<typeof PartialLanguageSettingsSchema>, PartialLanguageSettings>>,
  Assert<Equal<z.infer<typeof LanguageStateSchema>, LanguageState>>,
  Assert<Equal<z.infer<typeof LanguageNoticeSchema>, LanguageNotice>>,
  Assert<Equal<z.infer<typeof PipelineStageEventSchema>, PipelineStageEvent>>,
  Assert<Equal<z.infer<typeof OperatorPreferencesSchema>, OperatorPreferences>>,
];
