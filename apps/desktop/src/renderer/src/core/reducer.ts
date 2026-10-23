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
  type ConnectionState,
  type LaneState,
  type MicState,
} from './types';

export type ClientEvent =
  | { type: 'server'; message: ServerMessage }
  | { type: 'connection'; state: ConnectionState; error?: string | null }
  | { type: 'mic'; state: MicState }
  | { type: 'lane'; speaker: Speaker; patch: Partial<LaneState> }
  | { type: 'dismissEnded' }
  | { type: 'clearError' };

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
  };
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
    case 'dismissEnded':
      return state.call?.state === 'ended' ? { ...state, call: null } : state;
    case 'clearError':
      return { ...state, lastError: null };
    case 'server':
      return reduceServer(state, event.message, now);
  }
}

function reduceServer(state: CallClientState, message: ServerMessage, now: number): CallClientState {
  const call = state.call;
  switch (message.type) {
    case 'auth.ok':
      return { ...state, connection: 'connected', connectionError: null, operator: message.operator, server: message.server };
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
        call: { ...call, settings: message.settings, mode: languageModeOf(message.settings), detected: message.detected, notice: message.notice },
      };
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
      return { ...state, incoming, call: { ...call, state: 'ended', endedReason: message.reason } };
    }
    case 'error':
      return { ...state, lastError: { code: message.code, message: message.message, at: now } };
  }
}

export { INITIAL_CALL_CLIENT_STATE };
