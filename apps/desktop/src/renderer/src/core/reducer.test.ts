import { describe, expect, it } from 'vitest';
import type { LanguageSettings, ServerMessage, TranscriptSegment } from '@tw/shared';
import { INITIAL_CALL_CLIENT_STATE, type CallClientState } from './types';
import { reduce, type ClientEvent } from './reducer';

const operator = { id: 'op1', name: 'Ana', role: 'operator' as const, status: 'available' as const, currentCallId: null, autoAccept: false };
const server = { protocolVersion: 1 as const, providers: 'mock' as const, channel: 'mock' as const, debug: true, maxCalls: 3 };
const settings: LanguageSettings = { operatorLang: 'es', passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'follow' } };

const seg = (id: string, speaker: 'passenger' | 'operator', startMs: number, final: boolean, text = 'x'): TranscriptSegment => ({
  id,
  callId: 'c1',
  speaker,
  originalLang: 'en',
  originalText: text,
  translatedLang: final ? 'es' : null,
  translatedText: final ? `ES ${text}` : null,
  startMs,
  endMs: startMs + 10,
  final,
  createdAt: startMs,
});

function run(events: ClientEvent[], from: CallClientState = INITIAL_CALL_CLIENT_STATE): CallClientState {
  return events.reduce((state, event) => reduce(state, event, 1000), from);
}
const srv = (message: ServerMessage): ClientEvent => ({ type: 'server', message });
const active = srv({ type: 'call.state', callId: 'c1', state: 'active', direction: 'inbound', remoteNumber: '+34600', answeredAt: 5, muted: false, simulated: true });

describe('call client reducer', () => {
  it('authenticates and tracks presence and system status', () => {
    const state = run([
      { type: 'connection', state: 'connecting' },
      srv({ type: 'auth.ok', operator, token: 't', server }),
      srv({ type: 'presence', operators: [operator], activeCalls: 1, maxCalls: 3 }),
      srv({ type: 'system.status', elevenlabs: 'simulated', translator: 'simulated', channel: 'simulated' }),
    ]);
    expect(state).toMatchObject({ connection: 'connected', operator: { name: 'Ana' }, server: { debug: true }, presence: { activeCalls: 1 } });
    expect(state.systemStatus).toEqual({ elevenlabs: 'simulated', translator: 'simulated', channel: 'simulated', detail: {} });
  });

  it('shows the authentication error and goes back to disconnected', () => {
    const state = run([srv({ type: 'auth.error', code: 'invalid_credentials', message: 'Usuario o contraseña incorrectos' })]);
    expect(state).toMatchObject({ connection: 'disconnected', connectionError: 'Usuario o contraseña incorrectos' });
  });

  it('offers an incoming call and turns it into an active call when it is answered', () => {
    const ringing = run([srv({ type: 'call.incoming', callId: 'c1', from: '+34600', ringTimeoutSeconds: 30, autoAccept: false })]);
    expect(ringing.incoming).toMatchObject({ callId: 'c1', from: '+34600', ringTimeoutSeconds: 30, autoAccept: false, receivedAt: 1000, langHint: null });
    const answered = run([active], ringing);
    expect(answered.incoming).toBeNull();
    expect(answered.call).toMatchObject({ callId: 'c1', state: 'active', simulated: true, mic: 'off', endedReason: null });
    expect(answered.call!.lanes.passenger).toMatchObject({ stage: 'idle', speaking: false, levelsFlowing: true });
  });

  it('keeps languages, segments and lanes when the call state changes (mute)', () => {
    const state = run([
      active,
      srv({ type: 'call.languages', callId: 'c1', settings, detected: { lang: 'en', status: 'tentative', source: 'stt+translator', probability: null, agreeingSegments: 1 }, notice: null }),
      srv({ type: 'transcript.segment', segment: seg('s1', 'passenger', 10, true) }),
      srv({ type: 'call.state', callId: 'c1', state: 'active', direction: 'inbound', remoteNumber: '+34600', answeredAt: 5, muted: true, simulated: true }),
    ]);
    expect(state.call).toMatchObject({ muted: true, mode: 'auto', detected: { lang: 'en' } });
    expect(state.call!.segments).toHaveLength(1);
  });

  it('derives the mode from the settings the server confirms', () => {
    const base = run([active]);
    const confirm = (s: LanguageSettings) =>
      run([srv({ type: 'call.languages', callId: 'c1', settings: s, detected: { lang: null, status: 'unknown', source: null, probability: null, agreeingSegments: 0 }, notice: null })], base).call!.mode;
    expect(confirm(settings)).toBe('auto');
    expect(confirm({ ...settings, passengerHears: { mode: 'fixed', lang: 'en' } })).toBe('mixed');
    expect(confirm({ ...settings, passengerSpeaks: { mode: 'fixed', lang: 'fr' }, passengerHears: { mode: 'fixed', lang: 'fr' } })).toBe('manual');
  });

  it('ignores messages about another call', () => {
    const base = run([active]);
    const other = run(
      [
        srv({ type: 'transcript.segment', segment: { ...seg('s1', 'passenger', 1, true), callId: 'other' } }),
        srv({ type: 'pipeline.stage', callId: 'other', direction: 'passenger_to_operator', stage: 'speaking' }),
        srv({ type: 'call.ended', callId: 'other', reason: 'hangup_passenger', durationMs: 1 }),
      ],
      base,
    );
    expect(other).toEqual(base);
  });

  it('maps each pipeline direction to its own lane', () => {
    const state = run([
      active,
      srv({ type: 'pipeline.stage', callId: 'c1', direction: 'passenger_to_operator', stage: 'translating', segmentId: 's1' }),
      srv({ type: 'pipeline.stage', callId: 'c1', direction: 'operator_to_passenger', stage: 'error', detail: 'No se pudo traducir' }),
    ]);
    expect(state.call!.lanes.passenger).toMatchObject({ stage: 'translating', stageDetail: null });
    expect(state.call!.lanes.operator).toMatchObject({ stage: 'error', stageDetail: 'No se pudo traducir' });
  });

  it('replaces partial segments by their final version, keeps time order, and never reverts a final to a partial', () => {
    const state = run([
      active,
      srv({ type: 'transcript.segment', segment: seg('b', 'operator', 200, false, 'hola') }),
      srv({ type: 'transcript.segment', segment: seg('a', 'passenger', 100, false, 'hel') }),
      srv({ type: 'transcript.segment', segment: seg('a', 'passenger', 100, true, 'hello') }),
      srv({ type: 'transcript.segment', segment: seg('a', 'passenger', 100, false, 'he') }),
    ]);
    expect(state.call!.segments.map((s) => [s.id, s.originalText, s.final])).toEqual([
      ['a', 'hello', true],
      ['b', 'hola', false],
    ]);
  });

  it('keeps the ended call on screen with its reason until it is dismissed', () => {
    const ended = run([active, srv({ type: 'call.ended', callId: 'c1', reason: 'hangup_passenger', durationMs: 4000 })]);
    expect(ended.call).toMatchObject({ state: 'ended', endedReason: 'hangup_passenger' });
    expect(reduce(ended, { type: 'dismissEnded' }, 1)).toMatchObject({ call: null });
    expect(reduce(run([active]), { type: 'dismissEnded' }, 1).call).not.toBeNull();
  });

  it('after a reconnection, a call the server no longer has is shown as ended (connection lost), and one it still has is kept', () => {
    const inCall = run([active]);
    const gone = reduce(inCall, srv({ type: 'auth.ok', operator: { ...operator, status: 'available', currentCallId: null }, token: 't', server }), 1);
    expect(gone.call).toMatchObject({ callId: 'c1', state: 'ended', endedReason: 'connection_lost' });
    expect(gone.connection).toBe('connected');
    const kept = reduce(inCall, srv({ type: 'auth.ok', operator: { ...operator, status: 'in_call', currentCallId: 'c1' }, token: 't', server }), 1);
    expect(kept.call).toMatchObject({ callId: 'c1', state: 'active' });
    // Already ended on screen: nothing changes.
    const ended = run([active, srv({ type: 'call.ended', callId: 'c1', reason: 'hangup_passenger', durationMs: 1 })]);
    expect(reduce(ended, srv({ type: 'auth.ok', operator, token: 't', server }), 1).call).toMatchObject({ endedReason: 'hangup_passenger' });
  });

  it('an unknown_call error about the call on screen ends it, so the screen can be closed', () => {
    const state = run([active, srv({ type: 'error', code: 'unknown_call', message: 'Esa llamada ya ha terminado', callId: 'c1' })]);
    expect(state.call).toMatchObject({ state: 'ended', endedReason: 'connection_lost' });
    expect(state.lastError?.code).toBe('unknown_call');
    const other = run([active, srv({ type: 'error', code: 'unknown_call', message: 'x', callId: 'c2' })]);
    expect(other.call).toMatchObject({ state: 'active' });
  });

  it('keeps which directions carry the original voice (same language) from call.languages', () => {
    const state = run([
      active,
      srv({ type: 'call.languages', callId: 'c1', settings, detected: { lang: 'es', status: 'confirmed', source: 'stt+translator', probability: null, agreeingSegments: 2 }, notice: null, directAudio: { passengerToOperator: true, operatorToPassenger: false } }),
    ]);
    expect(state.call?.directAudio).toEqual({ passengerToOperator: true, operatorToPassenger: false });
    const older = run([active, srv({ type: 'call.languages', callId: 'c1', settings, detected: { lang: null, status: 'unknown', source: null, probability: null, agreeingSegments: 0 }, notice: null })]);
    expect(older.call?.directAudio).toBeNull();
  });

  it('clears an incoming offer when the call ends before it is answered', () => {
    const state = run([
      srv({ type: 'call.incoming', callId: 'c9', from: '+1' }),
      srv({ type: 'call.ended', callId: 'c9', reason: 'no_answer', durationMs: 0 }),
    ]);
    expect(state.incoming).toBeNull();
    expect(state.call).toBeNull();
  });

  it('records server errors and lets them be cleared', () => {
    const failed = run([srv({ type: 'error', code: 'dial_permission_required', message: 'Hace falta permiso' })]);
    expect(failed.lastError).toEqual({ code: 'dial_permission_required', message: 'Hace falta permiso', at: 1000 });
    expect(reduce(failed, { type: 'clearError' }, 1).lastError).toBeNull();
  });

  it('applies local lane patches (speaking, levels flowing) and mic state only to the active call', () => {
    const state = run([
      active,
      { type: 'lane', speaker: 'passenger', patch: { speaking: true } },
      { type: 'lane', speaker: 'operator', patch: { levelsFlowing: false } },
      { type: 'mic', state: 'live' },
    ]);
    expect(state.call!.lanes.passenger.speaking).toBe(true);
    expect(state.call!.lanes.operator.speaking).toBe(false);
    expect(state.call!.lanes.operator.levelsFlowing).toBe(false);
    expect(state.call!.mic).toBe('live');
    expect(run([{ type: 'mic', state: 'live' }]).call).toBeNull();
  });

  it('reports connection changes with a reason and clears it when connected', () => {
    const down = run([{ type: 'connection', state: 'reconnecting', error: 'Se perdió la conexión' }]);
    expect(down).toMatchObject({ connection: 'reconnecting', connectionError: 'Se perdió la conexión' });
    expect(reduce(down, { type: 'connection', state: 'connected' }, 1).connectionError).toBeNull();
  });
});
