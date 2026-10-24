/**
 * The seam between the two renderer teams.
 *
 * - Whoever owns src/core/** and src/call/** IMPLEMENTS `CallClientApi` (WebSocket, microphone,
 *   audio playback, level buffers) and the call screen.
 * - Whoever owns src/app/**, src/settings/** and src/history/** only CONSUMES it through `useCall()`.
 *
 * Extending these types is fine (add members); renaming or removing members breaks the other team.
 */
import type {
  CallId,
  CallState,
  Direction,
  EnvelopeWindow,
  ErrorCode,
  LanguageMode,
  LanguageNotice,
  LanguageSettings,
  LanguageState,
  OperatorInfo,
  PartialLanguageSettings,
  PipelineStage,
  ProviderMode,
  ChannelKind,
  ServiceStatus,
  Speaker,
  TranscriptSegment,
  CallEndReason,
  DirectionFallback,
  Unsubscribe,
} from '@tw/shared';

export type { Unsubscribe };

export const CONNECTION_STATES = ['disconnected', 'connecting', 'connected', 'reconnecting'] as const;
/** State of the operator WebSocket (`connected` means authenticated). */
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export interface ServerInfo {
  providers: ProviderMode;
  channel: ChannelKind;
  /** True when `debug.say` is accepted. */
  debug: boolean;
  maxCalls: number;
  /** True when the server accepts "modo audio del PC" calls (`call.startLocal`). */
  localAudio?: boolean;
}

export interface PresenceInfo {
  operators: OperatorInfo[];
  activeCalls: number;
  maxCalls: number;
}

/** Health of the external dependencies, from `system.status`. */
export interface SystemStatus {
  elevenlabs: ServiceStatus;
  translator: ServiceStatus;
  channel: ServiceStatus;
  detail: { elevenlabs?: string; translator?: string; channel?: string };
}

/** A call offered to this operator and not answered yet. */
export interface IncomingCall {
  callId: CallId;
  from: string;
  langHint: string | null;
  ringTimeoutSeconds: number | null;
  /** The server answers on the operator's behalf. */
  autoAccept: boolean;
  /** Client clock (epoch ms) when the offer arrived. */
  receivedAt: number;
}

export const MIC_STATES = ['off', 'requesting', 'live', 'denied', 'unavailable'] as const;
/** Local microphone. `live` means samples are being captured and sent. */
export type MicState = (typeof MIC_STATES)[number];

/** What one lane (Pasajero / Operador) shows besides the waveform. */
export interface LaneState {
  /** Latest pipeline stage of this lane's direction. */
  stage: PipelineStage;
  stageDetail: string | null;
  /** True while the REAL level of this lane is above the speaking threshold. */
  speaking: boolean;
  /**
   * False when levels stopped arriving from the server (connection lost): the lane must say so
   * instead of showing a flat "silence".
   */
  levelsFlowing: boolean;
}

export interface ActiveCall {
  callId: CallId;
  state: CallState;
  direction: Direction;
  remoteNumber: string;
  answeredAt: number | null;
  muted: boolean;
  /** True when the channel is the simulator: show the "Simulado" badge. */
  simulated: boolean;
  /** Null until the first `call.languages`. */
  settings: LanguageSettings | null;
  mode: LanguageMode | null;
  detected: LanguageState;
  notice: LanguageNotice | null;
  lanes: Record<Speaker, LaneState>;
  /** Ordered by start time; partials are replaced by their final version (same id). */
  segments: TranscriptSegment[];
  mic: MicState;
  /** Set once the call ended; the screen stays until the operator dismisses it. */
  endedReason: CallEndReason | null;
  /**
   * Same language on both ends: which directions carry the ORIGINAL voice instead of a synthesised translation
   * (from `call.languages.directAudio`; null until known or on an older server).
   */
  directAudio?: DirectAudioInfo | null;
  /** Plan B in use per direction (computer voice, original voice relayed); null while everything works. */
  fallback?: CallFallbackInfo | null;
  /**
   * Local call whose cable A has been silent for a long time (WhatsApp probably hung up): epoch ms when the app
   * closes it unless the operator keeps it. Null otherwise.
   */
  autoEndAt?: number | null;
}

export interface CallFallbackInfo {
  passengerToOperator: DirectionFallback;
  operatorToPassenger: DirectionFallback;
}

export interface DirectAudioInfo {
  passengerToOperator: boolean;
  operatorToPassenger: boolean;
}

export interface ClientError {
  code: ErrorCode | 'connection' | 'audio';
  message: string;
  /** Client clock (epoch ms). */
  at: number;
}

export const WATCH_STATUSES = ['off', 'needs_setup', 'waiting_connection', 'unsupported', 'arming', 'listening', 'starting', 'in_call', 'error'] as const;
/**
 * "Entrada automática de WhatsApp":
 * - `off`: turned off by the operator. `needs_setup`: the cable devices are not chosen yet.
 * - `waiting_connection` / `unsupported`: no server connection / the server has no "modo audio del PC".
 * - `arming`: waiting for cable A to be quiet after a call before listening again.
 * - `listening`: cable A is being listened to; sound there starts the call. `starting`: the call is entering.
 * - `in_call`: a call is on. `error`: cable A could not be opened (see `message`).
 */
export type WatchStatus = (typeof WATCH_STATUSES)[number];

export interface WatchState {
  enabled: boolean;
  status: WatchStatus;
  /** RMS 0..1 of cable A while listening (refreshed a few times a second). */
  level: number;
  message: string | null;
}

export interface CallClientState {
  /** "Entrada automática de WhatsApp" (modo audio del PC). */
  watch: WatchState;
  connection: ConnectionState;
  /** Why the connection is not `connected`, when known (Spanish, ready to show). */
  connectionError: string | null;
  server: ServerInfo | null;
  operator: OperatorInfo | null;
  presence: PresenceInfo | null;
  systemStatus: SystemStatus | null;
  incoming: IncomingCall | null;
  call: ActiveCall | null;
  lastError: ClientError | null;
}

/**
 * Waveform data of one lane, kept outside React state so the canvas can redraw ~40 times a
 * second without re-rendering components. Values come from REAL audio only: the Pasajero lane
 * from the server's levels frames (track 0), the Operador lane from the local microphone
 * samples (confirmed by track 1).
 */
export interface LevelSource {
  /** Maximum number of windows kept (a ring buffer). */
  readonly capacity: number;
  /** Windows oldest first, at most `capacity`. */
  snapshot(): readonly EnvelopeWindow[];
  /** Fires after new windows were added. */
  subscribe(listener: () => void): Unsubscribe;
  /** `performance.now()` of the last window that arrived, or null if none yet. */
  lastWindowAt(): number | null;
}

export interface CallActions {
  /** Opens the WebSocket and authenticates with the current session. */
  connect(): void;
  disconnect(): void;
  accept(callId: CallId): void;
  reject(callId: CallId): void;
  hangup(): void;
  /** Outbound call; omitted language keys use the operator's saved preferences. */
  dial(number: string, languages?: PartialLanguageSettings): void;
  /** Live language change; applies to the next phrases. */
  setLanguages(settings: PartialLanguageSettings): void;
  /** Switch between Manual / Automático / Mixto keeping the languages already chosen. */
  setMode(mode: LanguageMode): void;
  mute(muted: boolean): void;
  /** Simulated mode only: inject text as if the passenger (default) or the operator had said it. */
  debugSay(text: string, lang: string, as?: Speaker): void;
  /** Close the screen of an ended call. */
  dismissEndedCall(): void;
  /** Hides the last error banner. */
  dismissError?(): void;
  /**
   * "Modo audio del PC": start a translated session for a call that is happening in another program,
   * with the passenger audio taken from the cable devices chosen in Settings (see core/audio-prefs.ts).
   */
  startLocal?(label: string, options?: { langHint?: string; languages?: PartialLanguageSettings }): void;
  /** Turns the automatic entry of WhatsApp calls on or off (saved on this computer). */
  setAutoWhatsapp?(enabled: boolean): void;
  /** Settings changed the audio devices: the automatic entry re-reads them. */
  refreshAudioPrefs?(): void;
  /** The silent local call is still going on: cancel the countdown that would close it. */
  keepCall?(): void;
}

export interface CallClientApi {
  getState(): CallClientState;
  subscribe(listener: () => void): Unsubscribe;
  readonly levels: Record<Speaker, LevelSource>;
  readonly actions: CallActions;
}

export const INITIAL_WATCH_STATE: WatchState = { enabled: true, status: 'waiting_connection', level: 0, message: null };

export const INITIAL_CALL_CLIENT_STATE: CallClientState = {
  watch: INITIAL_WATCH_STATE,
  connection: 'disconnected',
  connectionError: null,
  server: null,
  operator: null,
  presence: null,
  systemStatus: null,
  incoming: null,
  call: null,
  lastError: null,
};
