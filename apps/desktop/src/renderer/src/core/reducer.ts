import {
  UNKNOWN_LANGUAGE_STATE,
  languageModeOf,
  speakerOfDirection,
  type ServerMessage,
  type Speaker,
  type TranscriptSegment,
} from '@tw/shared';
import {
  INITIAL_CALL_CLIENT_STATE,
  type ActiveCall,
  type CallClientState,
  type ClientError,
  type ConnectionState,
  type LaneState,
  type MicState,
  type WatchState,
} from './types';

export type ClientEvent =
  | { type: 'server'; message: ServerMessage }
  | { type: 'connection'; state: ConnectionState; error?: string | null }
  | { type: 'mic'; state: MicState }
  | { type: 'lane'; speaker: Speaker; patch: Partial<LaneState> }
  /** A problem found on this computer (audio devices), shown like a server error. */
  | { type: 'error'; code: ClientError['code']; message: string }
  | { type: 'dismissEnded' }
  | { type: 'clearError' }
  | { type: 'watch'; patch: Partial<WatchState> }
  | { type: 'autoEnd'; at: number | null };

export const IDLE_LANE: LaneState = { stage: 'idle', stageDetail: null, speaking: false, levelsFlowing: true };

function newCall(
  message: Extract<ServerMessage, { type: 'call.state' }>,
  previous: ActiveCall | null,
): ActiveCall {
  return {
    callId: message.callId,
    state: message.state,
    direction: message.direction,
    remoteNumber: message.remoteNumber,
    answeredAt: message.answeredAt,
    muted: message.muted,
    simulated: message.simulated,
    settings: previous?.settings ?? null,
    mode: previous?.mode ?? null,
    detected: previous?.detected ?? UNKNOWN_LANGUAGE_STATE,
    notice: previous?.notice ?? null,
    lanes: previous?.lanes ?? { passenger: IDLE_LANE, operator: IDLE_LANE },
    segments: previous?.segments ?? [],
    mic: previous?.mic ?? 'off',
    endedReason: null,
    directAudio: previous?.directAudio ?? null,
    fallback: previous?.fallback ?? null,
    autoEndAt: previous?.autoEndAt ?? null,
  };
}

/** The call on screen is over as far as the server is concerned (it ended while this app was away). */
function endStaleCall(state: CallClientState): CallClientState {
  const call = state.call;
  if (!call || call.state === 'ended') return state;
  return { ...state, call: { ...call, state: 'ended', endedReason: 'connection_lost' } };
}

function mergeSegment(segments: TranscriptSegment[], segment: TranscriptSegment): TranscriptSegment[] {
  const index = segments.findIndex((existing) => existing.id === segment.id);
  // A final version is never replaced by a late partial of the same segment.
  if (index >= 0 && segments[index]!.final && !segment.final) return segments;
  const next = index >= 0 ? segments.map((existing, i) => (i === index ? segment : existing)) : [...segments, segment];
  return next.sort((a, b) => a.startMs - b.startMs || a.createdAt - b.createdAt);
}

/** Pure state transitions of the call client. `now` is the client clock (epoch ms). */
export function reduce(state: CallClientState, event: ClientEvent, now: number): CallClientState {
  switch (event.type) {
    case 'connection':
      return {
        ...state,
        connection: event.state,
        connectionError: event.state === 'connected' ? null : (event.error ?? state.connectionError),
      };
    case 'mic':
      return state.call ? { ...state, call: { ...state.call, mic: event.state } } : state;
    case 'lane':
      return state.call
        ? { ...state, call: { ...state.call, lanes: { ...state.call.lanes, [event.speaker]: { ...state.call.lanes[event.speaker], ...event.patch } } } }
        : state;
    case 'error':
      return { ...state, lastError: { code: event.code, message: event.message, at: now } };
    case 'dismissEnded':
      return state.call?.state === 'ended' ? { ...state, call: null } : state;
    case 'clearError':
      return { ...state, lastError: null };
    case 'watch': {
      const next = { ...state.watch, ...event.patch };
      const same = (Object.keys(next) as (keyof WatchState)[]).every((key) => next[key] === state.watch[key]);
      return same ? state : { ...state, watch: next };
    }
    case 'autoEnd':
      if (!state.call || (state.call.autoEndAt ?? null) === event.at) return state;
      return { ...state, call: { ...state.call, autoEndAt: event.at } };
    case 'server':
      return reduceServer(state, event.message, now);
  }
}

function reduceServer(state: CallClientState, message: ServerMessage, now: number): CallClientState {
  const call = state.call;
  switch (message.type) {
    case 'auth.ok': {
      const next = { ...state, connection: 'connected' as const, connectionError: null, operator: message.operator, server: message.server };
      // After a reconnection the server says which call (if any) the operator still has: a call on screen that
      // the server no longer knows about is shown as ended, never kept "En llamada" with the microphone open.
      return state.call && state.call.state !== 'ended' && message.operator.currentCallId !== state.call.callId ? endStaleCall(next) : next;
    }
    case 'auth.error':
      return { ...state, connection: 'disconnected', connectionError: message.message };
    case 'presence':
      return { ...state, presence: { operators: message.operators, activeCalls: message.activeCalls, maxCalls: message.maxCalls } };
    case 'system.status':
      return {
        ...state,
        systemStatus: { elevenlabs: message.elevenlabs, translator: message.translator, channel: message.channel, detail: message.detail ?? {} },
      };
    case 'call.incoming':
      return {
        ...state,
        incoming: {
          callId: message.callId,
          from: message.from,
          langHint: message.langHint ?? null,
          ringTimeoutSeconds: message.ringTimeoutSeconds ?? null,
          autoAccept: message.autoAccept ?? false,
          receivedAt: now,
        },
      };
    case 'call.state': {
      const same = call?.callId === message.callId ? call : null;
      const next = newCall(message, same);
      return {
        ...state,
        call: next,
        incoming: state.incoming?.callId === message.callId ? null : state.incoming,
      };
    }
    case 'call.languages':
      if (!call || call.callId !== message.callId) return state;
      return {
        ...state,
        call: {
          ...call,
          settings: message.settings,
          mode: languageModeOf(message.settings),
          detected: message.detected,
          notice: message.notice,
          directAudio: message.directAudio ?? null,
        },
      };
    case 'call.fallback': {
      if (!call || call.callId !== message.callId) return state;
      const active = (side: typeof message.passengerToOperator): boolean => side.systemVoice || side.originalVoice;
      const fallback = active(message.passengerToOperator) || active(message.operatorToPassenger)
        ? { passengerToOperator: message.passengerToOperator, operatorToPassenger: message.operatorToPassenger }
        : null;
      return { ...state, call: { ...call, fallback } };
    }
    case 'pipeline.stage': {
      if (!call || call.callId !== message.callId) return state;
      const speaker = speakerOfDirection(message.direction);
      const lane: LaneState = { ...call.lanes[speaker], stage: message.stage, stageDetail: message.detail ?? null };
      return { ...state, call: { ...call, lanes: { ...call.lanes, [speaker]: lane } } };
    }
    case 'transcript.segment':
      if (!call || call.callId !== message.segment.callId) return state;
      return { ...state, call: { ...call, segments: mergeSegment(call.segments, message.segment) } };
    case 'call.ended': {
      const incoming = state.incoming?.callId === message.callId ? null : state.incoming;
      if (!call || call.callId !== message.callId) return { ...state, incoming };
      return { ...state, incoming, call: { ...call, state: 'ended', endedReason: message.reason, autoEndAt: null } };
    }
    case 'error': {
      const next = { ...state, lastError: { code: message.code, message: message.message, at: now } };
      // "That call does not exist" about the call on screen: it is over, so the screen can be closed.
      return message.code === 'unknown_call' && call && call.state !== 'ended' && message.callId === call.callId ? endStaleCall(next) : next;
    }
  }
}

export { INITIAL_CALL_CLIENT_STATE };
