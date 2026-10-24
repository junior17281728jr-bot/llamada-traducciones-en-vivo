/**
 * Contracts between the server and everything external or swappable: telephony channels,
 * speech-to-text, translation, text-to-speech, whole-direction pipelines and stores.
 *
 * Conventions:
 * - Audio is always PCM16 mono little-endian at 16 kHz (`PcmChunk`). Implementations convert
 *   from/to provider or channel formats at their own edge.
 * - Events use `onX(handler)` registration that returns an `Unsubscribe` function (no EventEmitter),
 *   so these interfaces stay usable from Node and from the browser.
 * - Anything talking to a real external service must be testable against a local simulator, and
 *   must say "simulated" wherever the implementation is a mock.
 */
import type { LanguageCatalog } from './languages.js';
import type {
  ConnectionTestResult,
  ListCallsQuery,
  MaskedSecret,
  RecordingLeg,
  SecretKeyName,
  TestService,
} from './protocol.js';
import type {
  CallEndReason,
  CallId,
  CallRecord,
  ChannelKind,
  Direction,
  LanguageNotice,
  LanguageSettings,
  DirectionFallback,
  LanguageState,
  OperatorPreferences,
  PipelineDirection,
  PipelineStageEvent,
  Speaker,
  TranscriptSegment,
} from './types.js';

/** PCM16 mono little-endian 16 kHz bytes (a Node Buffer is accepted). */
export type PcmChunk = Uint8Array;

/** Removes the handler that was registered. Safe to call more than once. */
export type Unsubscribe = () => void;

/** Minimal logger so packages do not depend on a logging library. Never log secrets. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Telephony channel
// ---------------------------------------------------------------------------

/** Result of asking whether a number can be dialed right now. */
export type CanDialResult =
  | { allowed: true }
  | {
      allowed: false;
      /**
       * `permission_required`: the channel needs the callee's prior consent (e.g. WhatsApp
       * business-initiated calls). `invalid_number`, `unsupported` and `unavailable` are self-explanatory.
       */
      reason: 'permission_required' | 'invalid_number' | 'unsupported' | 'unavailable';
      message?: string;
    };

/**
 * Source of calls: Twilio, WhatsApp, or the local simulator. Every call uses the same company
 * number. WhatsApp and other audio channels plug in here later.
 */
export interface CallChannel {
  readonly kind: ChannelKind;
  /** True when the channel is a local mock; the UI must then show "Simulado". */
  readonly simulated: boolean;
  /** Starts listening (opens sockets/servers). Resolves when ready to receive calls. */
  start(): Promise<void>;
  /** Hangs up everything and releases resources. */
  stop(): Promise<void>;
  /** A passenger is calling in. The call is ringing until `answer()` or `reject()`. */
  onIncoming(handler: (call: ChannelCall) => void): Unsubscribe;
  /** Whether `dial(number)` is currently possible. Does not place a call. */
  canDial(number: string): Promise<CanDialResult>;
  /** Places an outbound call. Resolves once the call exists (still ringing); see `ChannelCall.onAnswered`. */
  dial(number: string): Promise<ChannelCall>;
}

export interface ChannelCallEnd {
  reason: CallEndReason;
  message?: string;
}

/** One telephone call as seen by the server, in the internal audio format. */
export interface ChannelCall {
  /** Unique id; the call session reuses it as the `CallId`. */
  readonly id: CallId;
  readonly direction: Direction;
  /** The passenger's number (caller for inbound, callee for outbound). */
  readonly remoteNumber: string;
  /** Language hint known before audio flows (e.g. from the simulator); may be absent. */
  readonly langHint?: string;
  /** Answers an inbound call. */
  answer(): Promise<void>;
  /** Declines an inbound call that is still ringing. */
  reject(): Promise<void>;
  /** Ends the call from our side. Idempotent. */
  hangup(): Promise<void>;
  /** Audio towards the passenger (what the operator said, translated). */
  sendAudio(pcm: PcmChunk): void;
  /**
   * Audio coming from the passenger. This is THE single point where the passenger's levels are
   * measured, for the simulated channel and for every real one.
   */
  onAudio(handler: (pcm: PcmChunk) => void): Unsubscribe;
  /** Outbound calls: the passenger picked up. Inbound calls fire it after `answer()`. */
  onAnswered(handler: () => void): Unsubscribe;
  /** The call ended, from either side. Fires exactly once. */
  onEnded(handler: (end: ChannelCallEnd) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Speech to text
// ---------------------------------------------------------------------------

export interface SttSessionOptions {
  /** Spoken language; leave undefined to auto-detect (passenger side). */
  lang?: string;
}

export interface SttPartial {
  text: string;
  lang?: string;
}

export interface SttFinal {
  text: string;
  /** Detected (or configured) language of the utterance, normalised, when the provider reports it. */
  lang?: string;
  /** Probability of `lang` (0..1) when the provider reports one. UNVERIFIED for ElevenLabs. */
  langProbability?: number;
  /** Milliseconds since the session started. */
  startMs: number;
  endMs: number;
}

export interface SttProvider {
  /** Opens one streaming recognition session (one per speaking direction). */
  openSession(options: SttSessionOptions): Promise<SttSession>;
}

export interface SttSession {
  /** Streams audio (any chunk size). */
  sendAudio(pcm: PcmChunk): void;
  /** Forces the current utterance to be finalised (manual commit). */
  commit(): void;
  /** Interim hypothesis for the utterance in progress. */
  onPartial(handler: (partial: SttPartial) => void): Unsubscribe;
  /** A finished utterance. */
  onFinal(handler: (final: SttFinal) => void): Unsubscribe;
  /** Provider or transport failure. The session may be dead afterwards. */
  onError(handler: (error: Error) => void): Unsubscribe;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

export interface TranslationContextTurn {
  speaker: Speaker;
  text: string;
}

export interface TranslateRequest {
  text: string;
  /** Source language; omit to let the translator identify it. */
  from?: string;
  to: string;
  /** Earlier turns of the conversation, oldest first, to keep terminology and references coherent. */
  context?: readonly TranslationContextTurn[];
}

export interface TranslateResult {
  text: string;
  /** Source language the translator identified (second detection signal), when it can tell. */
  detectedFrom?: string;
}

/** Structural subset of the DOM/Node `AbortSignal`, so this package needs neither lib. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/** Text translation. ElevenLabs has no such endpoint; the real implementation uses Claude. */
export interface TextTranslator {
  translate(request: TranslateRequest, options?: { signal?: AbortSignalLike }): Promise<TranslateResult>;
}

// ---------------------------------------------------------------------------
// Text to speech
// ---------------------------------------------------------------------------

export interface TtsSessionOptions {
  /** Language to speak; the provider picks the configured voice for it. */
  lang: string;
}

export interface TtsProvider {
  /** Opens a streaming synthesis session (one voice per session). */
  openSession(options: TtsSessionOptions): Promise<TtsSession>;
}

export interface TtsSession {
  readonly lang: string;
  /** Queues text for synthesis. */
  speak(text: string): void;
  /** Forces generation of everything queued so far. */
  flush(): void;
  /** Drops queued text and in-flight audio (hangup, error recovery). Not used for a language change. */
  cancel(): void;
  /** Opens/keeps the connection ready in the background (language switch without a gap). */
  prewarm(): Promise<void>;
  /** Synthesised audio, already converted to the internal format. */
  onAudio(handler: (pcm: PcmChunk) => void): Unsubscribe;
  /** Everything queued so far has been synthesised (the last audio chunk was delivered). */
  onDone(handler: () => void): Unsubscribe;
  onError(handler: (error: Error) => void): Unsubscribe;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// One translated direction: audio in -> segments + translated audio out
// ---------------------------------------------------------------------------

export interface DirectionPipelineConfig {
  callId: CallId;
  direction: PipelineDirection;
  /** Initial language settings; later changes arrive through `applyLanguageSettings`. */
  settings: LanguageSettings;
  /** Language hint known before audio flows (channel metadata). */
  langHint?: string;
}

/** Language picture emitted by a pipeline whenever the detected language or a warning changes. */
export interface LanguageStateEvent {
  state: LanguageState;
  /** Warning that goes with this change, or null. */
  notice: LanguageNotice | null;
}

/** Time spent in each stage for one segment, in milliseconds (null when a stage did not run). */
export interface LatencySummary {
  sttMs: number | null;
  translateMs: number | null;
  /** From sending text to the first audio byte. */
  ttsFirstByteMs: number | null;
  /** From the end of the speech to the first translated audio byte. */
  totalMs: number | null;
}

export interface PipelineMetrics {
  /** Segments that completed the whole chain. */
  segments: number;
  last: LatencySummary | null;
  average: LatencySummary;
  p95TotalMs: number | null;
}

/**
 * Everything needed to translate one speaking direction of one call. The default implementation
 * chains STT -> TextTranslator -> TTS; a future "Eleven Realtime Translation" client can replace
 * the whole chain behind this same interface (not implemented: protocol unverified).
 */
export interface DirectionPipeline {
  readonly direction: PipelineDirection;
  /** Input audio (operator mic or passenger audio). Safe to call before the providers are connected. */
  pushAudio(pcm: PcmChunk): void;
  /** Segments, partial and final, with `translatedText` filled in once available. */
  onSegment(handler: (segment: TranscriptSegment) => void): Unsubscribe;
  /** Stage changes (receiving / transcribing / translating / speaking / idle / error). */
  onStage(handler: (event: PipelineStageEvent) => void): Unsubscribe;
  /** Detected-language state and its warnings (meaningful for `passenger_to_operator`). */
  onLanguageState(handler: (event: LanguageStateEvent) => void): Unsubscribe;
  /** Translated speech for the listener. */
  onAudio(handler: (pcm: PcmChunk) => void): Unsubscribe;
  onError(handler: (error: Error) => void): Unsubscribe;
  /**
   * New language settings. They apply from the NEXT phrase: a phrase already being translated or
   * spoken finishes in the previous language and sound that is playing is never cut.
   */
  applyLanguageSettings(settings: LanguageSettings): void;
  /**
   * Tells the pipeline what the other direction detected, so `operator_to_passenger` can follow
   * the passenger's language (or hold the operator's text until it is known).
   */
  setPassengerLanguageState(state: LanguageState): void;
  /**
   * Current passenger-language view of this pipeline (for `passenger_to_operator`: its own detection, including a
   * channel hint applied before any audio). Optional: older implementations may not expose it.
   */
  getLanguageState?(): LanguageState;
  /** Plan B in use (system voice, original voice relayed). Optional: simulated pipelines have none. */
  onFallback?(handler: (state: DirectionFallback) => void): Unsubscribe;
  getFallback?(): DirectionFallback;
  getMetrics(): PipelineMetrics;
  close(): Promise<void>;
}

/** Creates the pipelines of a call, one per direction. Providers connect lazily and report failures via `onError`. */
export interface PipelineFactory {
  createDirectionPipeline(config: DirectionPipelineConfig): DirectionPipeline;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Call history and transcripts. */
export interface TranscriptStore {
  /** Inserts or replaces the call summary. */
  saveCall(record: CallRecord): Promise<void>;
  getCall(id: CallId): Promise<CallRecord | null>;
  /** Newest first. */
  listCalls(query?: ListCallsQuery): Promise<CallRecord[]>;
  /** Inserts or replaces a segment by `id`. */
  saveSegment(segment: TranscriptSegment): Promise<void>;
  /** Ordered by `startMs`. */
  getSegments(callId: CallId): Promise<TranscriptSegment[]>;
  /** Deletes calls (and their segments) created before `timestamp`; returns how many calls were removed. */
  deleteOlderThan(timestamp: number): Promise<number>;
}

export interface RecordingInfo {
  callId: CallId;
  /** Where the audio lives (store-specific: a file path, an object key...). */
  location: string;
  durationMs: number;
  bytes: number;
  createdAt: number;
}

/** Appends audio of both speakers while a call is in progress. */
export interface RecordingWriter {
  /** Appends PCM16 16 kHz mono for one speaker; timing follows the order of arrival. */
  write(speaker: Speaker, pcm: PcmChunk): void;
  /** Finalises the recording and returns its metadata. */
  close(): Promise<RecordingInfo>;
}

/** Call recordings (only used when `RECORD_CALLS=true`). */
export interface RecordingStore {
  open(callId: CallId): Promise<RecordingWriter>;
  get(callId: CallId): Promise<RecordingInfo | null>;
  /** Reads one leg of the finished recording as a WAV file. */
  read(callId: CallId, leg: RecordingLeg): Promise<Uint8Array | null>;
  /** Deletes recordings created before `timestamp`; returns how many were removed. */
  deleteOlderThan(timestamp: number): Promise<number>;
}

/**
 * Encrypted store for API keys. Values go in through `set` and come out only through
 * `resolve`, which is for server code: NOTHING that reaches a client may contain a value.
 */
export interface SecretsStore {
  set(name: SecretKeyName, value: string): Promise<void>;
  delete(name: SecretKeyName): Promise<void>;
  getMasked(name: SecretKeyName): Promise<MaskedSecret>;
  listMasked(): Promise<Record<SecretKeyName, MaskedSecret>>;
  /** Saved value, else the environment variable of the same name, else undefined. Server-side only. */
  resolve(name: SecretKeyName): Promise<string | undefined>;
}

/** Per-operator language preferences, applied when each call starts. */
export interface PreferencesStore {
  /** Saved preferences, or the defaults when none were saved. */
  get(operatorId: string): Promise<OperatorPreferences>;
  set(operatorId: string, preferences: OperatorPreferences): Promise<void>;
}

/** Runs the real check behind each "Probar conexión" button. */
export interface ConnectionTester {
  test(service: TestService): Promise<ConnectionTestResult>;
}

/** Built-in language list plus an optional live refresh when an ElevenLabs key exists. */
export interface LanguageCatalogProvider {
  /** Current catalogue (live if a refresh succeeded, else the built-in documentation list). */
  getCatalog(): Promise<LanguageCatalog>;
  /** Asks the provider for its models/languages; falls back to the documentation list on failure. */
  refresh(): Promise<LanguageCatalog>;
}
