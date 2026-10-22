import { afterEach, describe, expect, it } from 'vitest';
import {
  AudioFrameType,
  DEFAULT_OPERATOR_PREFERENCES,
  LevelTrack,
  concatPcm,
  decodeBinaryFrame,
  silencePcm16,
  synthesizeSpeechSignal,
  type EnvelopeWindow,
  type OperatorPreferences,
  type ServerMessage,
  type TranscriptSegment,
} from '@tw/shared';
import { MockPipelineFactory, MockTts, UtteranceBus, mockVoicePitchHz, utteranceKey } from '@tw/pipeline';
import { CallManager } from './call-manager.js';
import type { OperatorLink } from './call-session.js';
import { MockCallChannel, MockPhone } from './channel/mock-channel.js';
import { silentLogger } from './logger.js';
import { FilePreferencesStore } from './stores/preferences.js';
import { FileRecordingStore } from './stores/recordings.js';
import { FileTranscriptStore } from './stores/transcripts.js';
import { tempDataDir } from './test-utils.js';

class FakeOperator implements OperatorLink {
  readonly messages: ServerMessage[] = [];
  readonly binary: Uint8Array[] = [];
  send(message: ServerMessage): void {
    this.messages.push(message);
  }
  sendBinary(data: Uint8Array): void {
    this.binary.push(data);
  }
  of<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
  finals(speaker: 'passenger' | 'operator'): TranscriptSegment[] {
    return this.of('transcript.segment').map((m) => m.segment).filter((s) => s.final && s.speaker === speaker);
  }
  audio(type: number): Uint8Array {
    const chunks: Uint8Array[] = [];
    for (const frame of this.binary) {
      if (frame[0] !== type) continue;
      const decoded = decodeBinaryFrame(frame);
      if (decoded.ok && decoded.value.kind === 'audio') chunks.push(decoded.value.pcm);
    }
    return concatPcm(chunks);
  }
  levels(track: number): EnvelopeWindow[] {
    const windows: EnvelopeWindow[] = [];
    for (const frame of this.binary) {
      const decoded = decodeBinaryFrame(frame);
      if (decoded.ok && decoded.value.kind === 'levels' && decoded.value.levels.track === track) {
        windows.push(...decoded.value.levels.windows);
      }
    }
    return windows;
  }
}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && Buffer.from(a).equals(Buffer.from(b));
const voice = (text: string, lang: string) => synthesizeSpeechSignal(text, { pitchHz: mockVoicePitchHz(lang) });
const EN = 'my flight was cancelled and I need a hotel';
const EN_ES = 'Mi vuelo fue cancelado y necesito un hotel.';
const ES_CHECK = 'voy a comprobar las opciones de alojamiento disponibles';

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const open: { stop: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const item of open.splice(0)) await item.stop();
});

interface WorldOptions {
  autoAccept?: boolean;
  maxCalls?: number;
  ringTimeoutSeconds?: number;
  record?: boolean;
  speed?: number;
}

async function world(options: WorldOptions = {}) {
  const dir = await tempDataDir();
  const bus = new UtteranceBus();
  const channel = new MockCallChannel({ speed: options.speed ?? 25 });
  await channel.start();
  channel.onUtterance((u) => bus.say(utteranceKey(u.callId, 'passenger'), { text: u.text, lang: u.lang }));
  const transcripts = new FileTranscriptStore(dir);
  const recordings = options.record ? new FileRecordingStore(dir) : null;
  const preferences = new FilePreferencesStore(dir);
  const pipelines = new MockPipelineFactory({
    bus,
    tts: new MockTts({}),
    pipeline: { holdMs: 300, receivingHangoverMs: 30 },
  });
  const manager = new CallManager({
    config: {
      maxConcurrentCalls: options.maxCalls ?? 3,
      ringTimeoutSeconds: options.ringTimeoutSeconds ?? 30,
      autoAccept: options.autoAccept ?? false,
      fallbackLang: 'en',
    },
    channel,
    pipelines,
    transcripts,
    recordings,
    preferences,
    logger: silentLogger,
    outboundRingSeconds: 5,
  });
  manager.start();
  const handle = { stop: async () => manager.stop().then(() => channel.stop()) };
  open.push(handle);

  const operators = new Map<string, FakeOperator>();
  const connect = async (id: string, prefs: Partial<OperatorPreferences> = {}): Promise<FakeOperator> => {
    await preferences.set(id, { ...DEFAULT_OPERATOR_PREFERENCES, ...prefs });
    const link = new FakeOperator();
    const result = await manager.connectOperator({ id, name: id, role: 'operator' }, link);
    expect(result.ok).toBe(true);
    operators.set(id, link);
    return link;
  };
  const speakAsOperator = (operatorId: string, callId: string, text: string, lang = 'es'): void => {
    bus.say(utteranceKey(callId, 'operator'), { text, lang });
    const signal = concatPcm([synthesizeSpeechSignal(text, { pitchHz: 130 }), silencePcm16(200)]);
    for (let offset = 0; offset < signal.byteLength; offset += 640) {
      manager.pushOperatorAudio(operatorId, signal.slice(offset, Math.min(offset + 640, signal.byteLength)));
    }
  };
  return { dir, bus, channel, manager, transcripts, recordings, preferences, connect, operators, speakAsOperator };
}

const phoneOf = (channel: MockCallChannel): MockPhone => channel.createPhone();

describe('inbound calls', () => {
  it('enters on its own, is transcribed and translated both ways, and the history keeps it', async () => {
    const w = await world({ record: true });
    const op = await w.connect('op1', { autoAccept: true });
    const phone = phoneOf(w.channel);
    const heard: Uint8Array[] = [];
    phone.onHeard((pcm) => heard.push(pcm));

    const call = phone.incoming('+34600111222', 'en');
    await waitFor(() => op.of('call.state').some((m) => m.state === 'active'), 'the call to become active');
    expect(op.of('call.incoming')[0]).toMatchObject({ callId: call.id, from: '+34600111222', autoAccept: true });
    expect(op.of('call.state').at(-1)).toMatchObject({ direction: 'inbound', simulated: true, muted: false });
    expect(op.of('call.languages')[0]!.settings).toMatchObject({ operatorLang: 'es', passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'follow' } });

    phone.say(EN, 'en');
    await waitFor(() => op.finals('passenger').length === 1, 'the passenger phrase');
    expect(op.finals('passenger')[0]).toMatchObject({ originalLang: 'en', originalText: EN, translatedLang: 'es', translatedText: EN_ES });
    await waitFor(() => op.audio(AudioFrameType.TranslatedPassenger).byteLength >= voice(EN_ES, 'es').byteLength, 'the translated voice');
    expect(bytesEqual(op.audio(AudioFrameType.TranslatedPassenger), voice(EN_ES, 'es'))).toBe(true);
    expect(op.of('call.languages').at(-1)!.detected).toMatchObject({ lang: 'en', status: 'tentative' });

    w.speakAsOperator('op1', call.id, ES_CHECK);
    await waitFor(() => op.finals('operator').length === 1, 'the operator phrase');
    expect(op.finals('operator')[0]).toMatchObject({ originalLang: 'es', translatedLang: 'en', translatedText: 'I will check the available accommodation options.' });
    const expectedForPassenger = voice('I will check the available accommodation options.', 'en');
    await waitFor(() => heard.reduce((n, c) => n + c.byteLength, 0) >= expectedForPassenger.byteLength, 'the passenger to hear the translation');
    expect(bytesEqual(concatPcm(heard), expectedForPassenger)).toBe(true);

    await phone.hangup();
    await waitFor(() => op.of('call.ended').length === 1, 'the call to end');
    expect(op.of('call.ended')[0]).toMatchObject({ callId: call.id, reason: 'hangup_passenger' });
    await waitFor(() => op.of('presence').at(-1)?.operators[0]?.status === 'available', 'the operator to be free');

    const saved = await w.transcripts.getCall(call.id);
    expect(saved).toMatchObject({ state: 'ended', endReason: 'hangup_passenger', passengerLang: 'en', recorded: true, operatorId: 'op1' });
    const segments = await w.transcripts.getSegments(call.id);
    expect(segments.map((s) => s.speaker).sort()).toEqual(['operator', 'passenger']);
    expect((await w.recordings!.get(call.id))?.bytes).toBeGreaterThan(0);
    expect(await w.recordings!.read(call.id, 'passenger')).not.toBeNull();
  });

  it('rings the operator and waits when auto-accept is off; accepting starts the call', async () => {
    const w = await world();
    const op = await w.connect('op1');
    const phone = phoneOf(w.channel);
    const call = phone.incoming('+34600000001', 'fr');
    await waitFor(() => op.of('call.incoming').length === 1, 'the ring');
    expect(op.of('call.incoming')[0]!.autoAccept).toBe(false);
    expect(op.of('call.state')).toHaveLength(0);
    await w.manager.accept('op1', call.id);
    await waitFor(() => op.of('call.state').some((m) => m.state === 'active'), 'the call to become active');
    expect(w.manager.activeCalls).toBe(1);
  });

  it('moves to the next operator when one declines, and to the next again after a ring timeout', async () => {
    const w = await world({ ringTimeoutSeconds: 0.15 });
    const a = await w.connect('a');
    const b = await w.connect('b');
    const c = await w.connect('c');
    const phone = phoneOf(w.channel);
    const call = phone.incoming('+34600000002', 'en');
    const first = [a, b, c].find((o) => o.of('call.incoming').length === 1)!;
    await waitFor(() => [a, b, c].some((o) => o.of('call.incoming').length === 1), 'the first ring');
    const firstId = first === a ? 'a' : first === b ? 'b' : 'c';
    w.manager.reject(firstId, call.id);
    await waitFor(() => [a, b, c].filter((o) => o.of('call.incoming').length === 1).length === 2, 'the second operator to ring');
    // The second operator ignores it: after the ring timeout the third one gets it.
    await waitFor(() => [a, b, c].filter((o) => o.of('call.incoming').length === 1).length === 3, 'the third operator to ring', 3000);
    expect([a, b, c].every((o) => o.of('call.incoming').length === 1)).toBe(true);
  });

  it('rejects the call and records it when nobody is free', async () => {
    const w = await world();
    const phone = phoneOf(w.channel);
    const states: string[] = [];
    phone.onState((s) => states.push(s.state + (s.reason ? `:${s.reason}` : '')));
    const call = phone.incoming('+34600000003', 'en');
    await waitFor(() => states.includes('ended:rejected'), 'the call to be rejected');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await w.transcripts.getCall(call.id)).toMatchObject({ state: 'ended', endReason: 'no_answer', operatorId: null });
  });

  it('serves three calls at once and rejects the fourth', async () => {
    const w = await world({ autoAccept: true });
    const ops = await Promise.all(['a', 'b', 'c', 'd'].map((id) => w.connect(id)));
    const phones = [1, 2, 3, 4].map(() => phoneOf(w.channel));
    const states = phones.map(() => [] as string[]);
    phones.forEach((p, i) => p.onState((s) => states[i]!.push(s.state + (s.reason ? `:${s.reason}` : ''))));

    for (let i = 0; i < 3; i++) phones[i]!.incoming(`+3460000000${i}`, 'en');
    await waitFor(() => ops.reduce((n, o) => n + o.of('call.state').filter((m) => m.state === 'active').length, 0) === 3, 'three active calls');
    expect(w.manager.activeCalls).toBe(3);

    phones[3]!.incoming('+34600000009', 'en');
    await waitFor(() => states[3]!.includes('ended:rejected'), 'the fourth call to be rejected');
    expect(w.manager.activeCalls).toBe(3);
    const presence = ops[3]!.of('presence').at(-1)!;
    expect(presence).toMatchObject({ activeCalls: 3, maxCalls: 3 });
    expect(presence.operators.filter((o) => o.status === 'in_call')).toHaveLength(3);
  });

  it('ends the call when its operator disconnects', async () => {
    const w = await world({ autoAccept: true });
    const op = await w.connect('op1');
    const phone = phoneOf(w.channel);
    const states: string[] = [];
    phone.onState((s) => states.push(s.state));
    phone.incoming('+34600000004', 'en');
    await waitFor(() => op.of('call.state').some((m) => m.state === 'active'), 'the call to become active');
    w.manager.disconnectOperator('op1');
    await waitFor(() => states.includes('ended'), 'the call to end');
    await waitFor(() => w.manager.activeCalls === 0, 'the line to be released');
  });

  it('refuses a second connection of the same operator', async () => {
    const w = await world();
    await w.connect('op1');
    const second = await w.manager.connectOperator({ id: 'op1', name: 'op1', role: 'operator' }, new FakeOperator());
    expect(second).toEqual({ ok: false, code: 'already_connected' });
  });
});

describe('outbound calls', () => {
  it('dials a simulated passenger who picks up, and translates', async () => {
    const w = await world();
    const op = await w.connect('op1', { defaultMode: 'mixed', defaultPassengerHears: 'pt' });
    const phone = phoneOf(w.channel);
    phone.listen('pt');
    const heard: Uint8Array[] = [];
    phone.onHeard((pcm) => heard.push(pcm));

    await w.manager.dial('op1', '+351912345678');
    await waitFor(() => op.of('call.state').some((m) => m.state === 'ringing' && m.direction === 'outbound'), 'ringing');
    const callId = op.of('call.state')[0]!.callId;
    phone.answer();
    await waitFor(() => op.of('call.state').some((m) => m.state === 'active'), 'the call to become active');

    w.speakAsOperator('op1', callId, ES_CHECK);
    await waitFor(() => op.finals('operator').length === 1, 'the operator phrase');
    expect(op.finals('operator')[0]).toMatchObject({ translatedLang: 'pt', translatedText: 'Vou verificar as opções de alojamento disponíveis.' });
    await waitFor(() => heard.reduce((n, c) => n + c.byteLength, 0) >= voice('Vou verificar as opções de alojamento disponíveis.', 'pt').byteLength, 'the passenger to hear');
  });

  it('explains why a call cannot be placed: no phone listening, invalid number, or busy operator', async () => {
    const w = await world();
    const op = await w.connect('op1');
    await w.manager.dial('op1', '+34600000000');
    expect(op.of('error').at(-1)).toMatchObject({ code: 'dial_failed' });
    expect(op.of('error').at(-1)!.message).toContain('simulado');
    await w.manager.dial('op1', 'abc');
    expect(op.of('error').at(-1)).toMatchObject({ code: 'invalid_number' });
  });

  it('cannot dial while in a call', async () => {
    const w = await world({ autoAccept: true });
    const op = await w.connect('op1');
    phoneOf(w.channel).incoming('+34600000005', 'en');
    await waitFor(() => op.of('call.state').some((m) => m.state === 'active'), 'the call to become active');
    await w.manager.dial('op1', '+34600000006');
    expect(op.of('error').at(-1)).toMatchObject({ code: 'operator_busy' });
  });
});

describe('live language changes and audio levels', () => {
  it('changes languages during the call, confirms them to the operator and keeps the audio whole', async () => {
    const w = await world({ autoAccept: true });
    const op = await w.connect('op1');
    const phone = phoneOf(w.channel);
    const heard: Uint8Array[] = [];
    phone.onHeard((pcm) => heard.push(pcm));
    const call = phone.incoming('+34600000007', 'en');
    await waitFor(() => op.of('call.state').some((m) => m.state === 'active'), 'the call to become active');

    w.manager.setLanguages('op1', call.id, { passengerHears: { mode: 'fixed', lang: 'it' }, passengerSpeaks: { mode: 'auto' } });
    expect(op.of('call.languages').at(-1)!.settings).toMatchObject({ passengerHears: { mode: 'fixed', lang: 'it' } });
    w.speakAsOperator('op1', call.id, ES_CHECK);
    await waitFor(() => op.finals('operator').length === 1, 'the first phrase');
    expect(op.finals('operator')[0]).toMatchObject({ translatedLang: 'it', translatedText: 'Verificherò le opzioni di alloggio disponibili.' });

    w.manager.setLanguages('op1', call.id, { passengerHears: { mode: 'fixed', lang: 'fr' } });
    w.speakAsOperator('op1', call.id, ES_CHECK);
    await waitFor(() => op.finals('operator').length === 2, 'the second phrase');
    expect(op.finals('operator')[1]).toMatchObject({ translatedLang: 'fr', translatedText: "Je vais vérifier les options d'hébergement disponibles." });

    const expected = concatPcm([
      voice('Verificherò le opzioni di alloggio disponibili.', 'it'),
      voice("Je vais vérifier les options d'hébergement disponibles.", 'fr'),
    ]);
    await waitFor(() => heard.reduce((n, c) => n + c.byteLength, 0) >= expected.byteLength, 'the passenger to hear both phrases');
    expect(bytesEqual(concatPcm(heard), expected)).toBe(true);
  });

  it('measures each leg on its own: waves only move for the person who is speaking', async () => {
    const w = await world({ autoAccept: true });
    const op = await w.connect('op1');
    const phone = phoneOf(w.channel);
    const call = phone.incoming('+34600000008', 'en');
    await waitFor(() => op.of('call.state').some((m) => m.state === 'active'), 'the call to become active');

    // Only digital silence from both sides: both lanes flat.
    await waitFor(() => op.levels(LevelTrack.PassengerIn).length >= 25, 'passenger silence frames');
    expect(op.levels(LevelTrack.PassengerIn).every((win) => win.rms === 0 && win.min === 0 && win.max === 0)).toBe(true);
    expect(op.levels(LevelTrack.OperatorIn)).toHaveLength(0);

    // The passenger speaks: only the passenger lane moves.
    const operatorBefore = op.levels(LevelTrack.OperatorIn).length;
    phone.say(EN, 'en');
    await waitFor(() => op.levels(LevelTrack.PassengerIn).some((win) => win.rms > 0.01), 'passenger voice levels');
    expect(op.levels(LevelTrack.OperatorIn)).toHaveLength(operatorBefore);
    await waitFor(() => op.finals('passenger').length === 1, 'the passenger phrase');

    // The operator speaks: the operator lane moves, and the passenger lane goes back to flat.
    const passengerMark = op.levels(LevelTrack.PassengerIn).length;
    w.speakAsOperator('op1', call.id, ES_CHECK);
    expect(op.levels(LevelTrack.OperatorIn).some((win) => win.rms > 0.01)).toBe(true);
    await waitFor(() => op.levels(LevelTrack.PassengerIn).length > passengerMark + 20, 'more passenger frames');
    expect(op.levels(LevelTrack.PassengerIn).slice(passengerMark).every((win) => win.rms === 0)).toBe(true);
  });

  it('muting stops the operator audio from being translated or measured', async () => {
    const w = await world({ autoAccept: true });
    const op = await w.connect('op1');
    const phone = phoneOf(w.channel);
    const call = phone.incoming('+34600000010', 'en');
    await waitFor(() => op.of('call.state').some((m) => m.state === 'active'), 'the call to become active');
    w.manager.mute('op1', call.id, true);
    expect(op.of('call.state').at(-1)!.muted).toBe(true);
    w.speakAsOperator('op1', call.id, ES_CHECK);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(op.finals('operator')).toHaveLength(0);
    expect(op.levels(LevelTrack.OperatorIn)).toHaveLength(0);
  });
});
