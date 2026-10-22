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
}

export interface ClientError {
  code: ErrorCode | 'connection' | 'audio';
  message: string;
  /** Client clock (epoch ms). */
  at: number;
}

export interface CallClientState {
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
  /** Simulated mode only: inject text as if the passenger had said it. */
  debugSay(text: string, lang: string): void;
  /** Close the screen of an ended call. */
  dismissEndedCall(): void;
}

export interface CallClientApi {
  getState(): CallClientState;
  subscribe(listener: () => void): Unsubscribe;
  readonly levels: Record<Speaker, LevelSource>;
  readonly actions: CallActions;
}

export const INITIAL_CALL_CLIENT_STATE: CallClientState = {
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
