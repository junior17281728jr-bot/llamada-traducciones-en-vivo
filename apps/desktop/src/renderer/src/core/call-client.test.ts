import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AudioFrameType,
  LevelTrack,
  decodeAudioFrame,
  encodeAudioFrame,
  encodeLevelsFrame,
  encodeMessage,
  generateSinePcm16,
  parseClientMessage,
  silencePcm16,
  type ClientMessage,
  type EnvelopeWindow,
  type LanguageSettings,
  type ServerMessage,
} from '@tw/shared';
import { MicError, type AudioIO } from './audio-io';
import { createCallClient, type WebSocketLike } from './call-client';
import { getSession, resetSessionForTests, setSession, type Session } from './session';

const operator = { id: 'op1', name: 'Ana', role: 'operator' as const, status: 'available' as const, currentCallId: null, autoAccept: false };
const session: Session = { serverUrl: 'http://127.0.0.1:8787/', token: 'tok-123', expiresAt: Date.now() + 3_600_000, operator };
const settings: LanguageSettings = { operatorLang: 'es', passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'follow' } };

class FakeSocket implements WebSocketLike {
  binaryType = 'blob';
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: (string | ArrayBufferLike | ArrayBufferView)[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
  receive(message: ServerMessage): void {
    this.onmessage?.({ data: encodeMessage(message) });
  }
  receiveBinary(frame: Uint8Array): void {
    this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) });
  }
  messages(): ClientMessage[] {
    return this.sent.filter((item): item is string => typeof item === 'string').map((text) => {
      const parsed = parseClientMessage(text);
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.value;
    });
  }
  micFrames(): Uint8Array[] {
    return this.sent.filter((item): item is Uint8Array => item instanceof Uint8Array);
  }
}

class FakeAudio implements AudioIO {
  onPcm: ((pcm: Uint8Array) => void) | null = null;
  micStarts = 0;
  micStops = 0;
  failWith: MicError | null = null;
  played: Uint8Array[] = [];
  playbackStops = 0;
  async startMic(onPcm: (pcm: Uint8Array) => void) {
    this.micStarts += 1;
    if (this.failWith) throw this.failWith;
    this.onPcm = onPcm;
    return { stop: () => void (this.micStops += 1) };
  }
  playback = {
    play: (pcm: Uint8Array) => void this.played.push(pcm),
    setVolume: () => undefined,
    setSink: () => Promise.resolve(),
    stop: () => void (this.playbackStops += 1),
  };
}

const win = (max: number): EnvelopeWindow => ({ min: -max, max, rms: max / 2 });
const SILENT: EnvelopeWindow = { min: 0, max: 0, rms: 0 };
const levelsFrame = (track: number, windows: EnvelopeWindow[], seq = 0) => encodeLevelsFrame({ track: track as never, seq, timeMs: seq * 20, windows });
const activeCall = (muted = false): ServerMessage => ({ type: 'call.state', callId: 'c1', state: 'active', direction: 'inbound', remoteNumber: '+34600', answeredAt: 1, muted, simulated: true });
const authOk = (debug = true): ServerMessage => ({
  type: 'auth.ok',
  operator,
  token: 'tok-123',
  server: { protocolVersion: 1, providers: 'mock', channel: 'mock', debug, maxCalls: 3 },
});
const languages = (s: LanguageSettings = settings): ServerMessage => ({
  type: 'call.languages',
  callId: 'c1',
  settings: s,
  detected: { lang: 'en', status: 'tentative', source: 'stt+translator', probability: null, agreeingSegments: 1 },
  notice: null,
});

let sockets: FakeSocket[];
let audio: FakeAudio;
let perf: number;

function setup(options: { reconnectDelaysMs?: number[] } = {}) {
  sockets = [];
  audio = new FakeAudio();
  perf = 1000;
  const client = createCallClient(session, {
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    audio,
    now: () => 5000,
    perfNow: () => perf,
    watchdogMs: 100,
    ...options,
  });
  return client;
}

const socket = () => sockets.at(-1)!;
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}
async function connectAndStartCall(client: ReturnType<typeof setup>, debug = true): Promise<FakeSocket> {
  client.actions.connect();
  socket().open();
  socket().receive(authOk(debug));
  socket().receive(activeCall());
  socket().receive(languages());
  await flush();
  return socket();
}

beforeEach(() => {
  vi.useFakeTimers();
  resetSessionForTests();
  setSession(session);
});
afterEach(() => {
  vi.useRealTimers();
  resetSessionForTests();
});

describe('connection', () => {
  it('opens the operator socket, resumes the login session and becomes connected', () => {
    const client = setup();
    client.actions.connect();
    expect(client.getState().connection).toBe('connecting');
    expect(socket().url).toBe('ws://127.0.0.1:8787/operator');
    expect(socket().binaryType).toBe('arraybuffer');
    socket().open();
    expect(socket().messages()).toEqual([{ type: 'auth.resume', token: 'tok-123' }]);
    socket().receive(authOk());
    expect(client.getState()).toMatchObject({ connection: 'connected', operator: { name: 'Ana' }, server: { debug: true } });
    client.actions.disconnect();
    expect(client.getState().connection).toBe('disconnected');
  });

  it('reconnects with backoff after a drop and resumes again', async () => {
    const client = setup({ reconnectDelaysMs: [100, 200] });
    client.actions.connect();
    socket().open();
    socket().receive(authOk());
    socket().drop();
    expect(client.getState()).toMatchObject({ connection: 'reconnecting', connectionError: expect.stringContaining('Reconectando') });
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets).toHaveLength(2);
    socket().drop();
    await vi.advanceTimersByTimeAsync(150);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60);
    expect(sockets).toHaveLength(3);
    socket().open();
    socket().receive(authOk());
    expect(client.getState().connection).toBe('connected');
    expect(client.getState().connectionError).toBeNull();
  });

  it('an invalid or expired token ends the login session and does not reconnect', async () => {
    const client = setup();
    client.actions.connect();
    socket().open();
    socket().receive({ type: 'auth.error', code: 'token_expired', message: 'La sesión no es válida. Inicia sesión de nuevo.' });
    expect(client.getState()).toMatchObject({ connection: 'disconnected', connectionError: 'La sesión no es válida. Inicia sesión de nuevo.' });
    expect(getSession()).toBeNull();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sockets).toHaveLength(1);
  });
});

describe('actions', () => {
  it('sends the right control messages', async () => {
    const client = setup();
    const ws = await connectAndStartCall(client);
    ws.sent.length = 0;
    client.actions.accept('c9');
    client.actions.reject('c8');
    client.actions.hangup();
    client.actions.dial('+34600111222', { passengerHears: { mode: 'fixed', lang: 'it' } });
    client.actions.setLanguages({ operatorLang: 'es' });
    client.actions.mute(true);
    client.actions.debugSay('hello there my friend', 'en');
    client.actions.debugSay('buenos días', 'es', 'operator');
    expect(ws.messages()).toEqual([
      { type: 'call.accept', callId: 'c9' },
      { type: 'call.reject', callId: 'c8' },
      { type: 'call.hangup', callId: 'c1' },
      { type: 'call.dial', number: '+34600111222', languages: { passengerHears: { mode: 'fixed', lang: 'it' } } },
      { type: 'call.setLanguages', callId: 'c1', settings: { operatorLang: 'es' } },
      { type: 'call.mute', callId: 'c1', muted: true },
      { type: 'debug.say', text: 'hello there my friend', lang: 'en' },
      { type: 'debug.say', text: 'buenos días', lang: 'es', as: 'operator' },
    ]);
  });

  it('setMode keeps the languages the operator already chose and uses the detected one when leaving automatic', async () => {
    const client = setup();
    const ws = await connectAndStartCall(client);
    ws.sent.length = 0;
    client.actions.setMode('mixed');
    client.actions.setMode('manual');
    expect(ws.messages()).toEqual([
      { type: 'call.setLanguages', callId: 'c1', settings: { operatorLang: 'es', passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'fixed', lang: 'en' } } },
      { type: 'call.setLanguages', callId: 'c1', settings: { operatorLang: 'es', passengerSpeaks: { mode: 'fixed', lang: 'en' }, passengerHears: { mode: 'fixed', lang: 'en' } } },
    ]);
  });

  it('debug.say is ignored unless the server allows it, and nothing is sent without a call', async () => {
    const client = setup();
    const ws = await connectAndStartCall(client, false);
    ws.sent.length = 0;
    client.actions.debugSay('hello there', 'en');
    expect(ws.messages()).toEqual([]);
    client.actions.dismissEndedCall();
    expect(client.getState().call).not.toBeNull();
    ws.receive({ type: 'call.ended', callId: 'c1', reason: 'hangup_passenger', durationMs: 5 });
    ws.sent.length = 0;
    client.actions.hangup();
    client.actions.mute(true);
    expect(ws.messages()).toEqual([]);
    client.actions.dismissEndedCall();
    expect(client.getState().call).toBeNull();
  });
});

describe('microphone and the operator lane', () => {
  it('starts the microphone when the call is active and sends exactly the samples it measures', async () => {
    const client = setup();
    const ws = await connectAndStartCall(client);
    expect(audio.micStarts).toBe(1);
    expect(client.getState().call!.mic).toBe('live');

    const voice = generateSinePcm16(300, 40, 0.5);
    audio.onPcm!(voice.slice(0, 640));
    audio.onPcm!(voice.slice(640, 1280));
    expect(ws.micFrames()).toHaveLength(2);
    const decoded = decodeAudioFrame(ws.micFrames()[0]!);
    expect(decoded.ok && decoded.value.type).toBe(AudioFrameType.OperatorMic);
    expect(decoded.ok && Buffer.from(decoded.value.pcm).equals(Buffer.from(voice.slice(0, 640)))).toBe(true);

    const windows = client.levels.operator.snapshot();
    expect(windows.length).toBeGreaterThanOrEqual(2);
    expect(windows.some((w) => w.rms > 0.1)).toBe(true);
    expect(client.getState().call!.lanes.operator.speaking).toBe(true);
    expect(client.levels.passenger.snapshot()).toHaveLength(0);
  });

  it('muting sends nothing and the lane goes flat', async () => {
    const client = setup();
    const ws = await connectAndStartCall(client);
    audio.onPcm!(generateSinePcm16(300, 20, 0.5));
    expect(ws.micFrames()).toHaveLength(1);
    ws.receive(activeCall(true));
    audio.onPcm!(generateSinePcm16(300, 20, 0.5));
    expect(ws.micFrames()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(400);
    const last = client.levels.operator.snapshot().slice(-10);
    expect(last.length).toBe(10);
    expect(last.every((w) => w.rms === 0 && w.min === 0 && w.max === 0)).toBe(true);
    expect(client.getState().call!.lanes.operator.speaking).toBe(false);
  });

  it('reports a denied microphone and keeps the lane flat instead of pretending', async () => {
    const client = setup();
    audio.failWith = new MicError('denied', 'No hay permiso para usar el micrófono');
    const ws = await connectAndStartCall(client);
    expect(client.getState().call!.mic).toBe('denied');
    expect(client.getState().lastError).toMatchObject({ message: 'No hay permiso para usar el micrófono' });
    await vi.advanceTimersByTimeAsync(300);
    expect(client.levels.operator.snapshot().every((w) => w.rms === 0)).toBe(true);
    expect(ws.micFrames()).toHaveLength(0);
  });

  it('stops the microphone and the playback when the call ends', async () => {
    const client = setup();
    const ws = await connectAndStartCall(client);
    ws.receive({ type: 'call.ended', callId: 'c1', reason: 'hangup_operator', durationMs: 100 });
    expect(audio.micStops).toBe(1);
    expect(client.getState().call).toMatchObject({ state: 'ended', mic: 'live' });
    audio.onPcm?.(generateSinePcm16(300, 20, 0.5));
    expect(ws.micFrames()).toHaveLength(0);
  });

  it('warns when the operator speaks but the server never hears the microphone', async () => {
    const client = setup();
    const ws = await connectAndStartCall(client);
    for (let i = 0; i < 10; i++) {
      audio.onPcm!(generateSinePcm16(300, 20, 0.5));
      perf += 400;
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(client.getState().lastError).toMatchObject({ message: expect.stringContaining('no recibe tu micrófono') });
    ws.receiveBinary(levelsFrame(LevelTrack.OperatorIn, [win(0.5)]));
  });
});

describe('the passenger lane', () => {
  it('only moves with the server levels of the passenger track', async () => {
    const client = setup();
    const ws = await connectAndStartCall(client);
    ws.receiveBinary(levelsFrame(LevelTrack.PassengerIn, [SILENT, SILENT, SILENT], 0));
    expect(client.levels.passenger.snapshot()).toHaveLength(3);
    expect(client.levels.passenger.snapshot().every((w) => w.rms === 0)).toBe(true);
    expect(client.getState().call!.lanes.passenger.speaking).toBe(false);

    ws.receiveBinary(levelsFrame(LevelTrack.PassengerIn, [win(0.4), win(0.5)], 1));
    expect(client.levels.passenger.snapshot()).toHaveLength(5);
    expect(client.getState().call!.lanes.passenger.speaking).toBe(true);

    // Operator track frames never touch the passenger lane, and vice versa.
    ws.receiveBinary(levelsFrame(LevelTrack.OperatorIn, [win(0.9)], 0));
    expect(client.levels.passenger.snapshot()).toHaveLength(5);
    expect(client.levels.operator.snapshot().every((w) => w.rms === 0)).toBe(true);
    expect(client.getState().call!.lanes.operator.speaking).toBe(false);
  });

  it('heartbeats keep the lane connected without adding any waveform', async () => {
    const client = setup();
    const ws = await connectAndStartCall(client);
    ws.receiveBinary(levelsFrame(LevelTrack.PassengerIn, [], 0));
    expect(client.levels.passenger.snapshot()).toHaveLength(0);
    expect(client.getState().call!.lanes.passenger.levelsFlowing).toBe(true);
  });

  it('says so when the levels stop arriving, and recovers when they come back', async () => {
    const client = setup();
    const ws = await connectAndStartCall(client);
    ws.receiveBinary(levelsFrame(LevelTrack.PassengerIn, [win(0.3)], 0));
    perf += 1000;
    await vi.advanceTimersByTimeAsync(100);
    expect(client.getState().call!.lanes.passenger.levelsFlowing).toBe(true);
    perf += 1000;
    await vi.advanceTimersByTimeAsync(100);
    expect(client.getState().call!.lanes.passenger.levelsFlowing).toBe(false);
    const before = client.levels.passenger.snapshot().length;
    await vi.advanceTimersByTimeAsync(500);
    expect(client.levels.passenger.snapshot()).toHaveLength(before);
    ws.receiveBinary(levelsFrame(LevelTrack.PassengerIn, [win(0.3)], 1));
    expect(client.getState().call!.lanes.passenger.levelsFlowing).toBe(true);
  });

  it('plays the translated voice only, and clears the waveforms when the ended call is dismissed', async () => {
    const client = setup();
    const ws = await connectAndStartCall(client);
    const voice = generateSinePcm16(200, 60, 0.4);
    ws.receiveBinary(encodeAudioFrame(AudioFrameType.TranslatedPassenger, voice));
    ws.receiveBinary(encodeAudioFrame(AudioFrameType.OriginalPassenger, voice));
    expect(audio.played).toHaveLength(1);
    expect(Buffer.from(audio.played[0]!).equals(Buffer.from(voice))).toBe(true);

    ws.receiveBinary(levelsFrame(LevelTrack.PassengerIn, [win(0.4)], 0));
    ws.receive({ type: 'call.ended', callId: 'c1', reason: 'hangup_passenger', durationMs: 5 });
    expect(client.levels.passenger.snapshot()).toHaveLength(1);
    client.actions.dismissEndedCall();
    expect(client.levels.passenger.snapshot()).toHaveLength(0);
    expect(client.levels.operator.snapshot()).toHaveLength(0);
  });

  it('ignores frames that are not valid for a client', async () => {
    const client = setup();
    const ws = await connectAndStartCall(client);
    ws.receiveBinary(encodeAudioFrame(AudioFrameType.OperatorMic, silencePcm16(20)));
    ws.receiveBinary(new Uint8Array([0x7f, 1, 2]));
    expect(audio.played).toHaveLength(0);
    expect(client.levels.passenger.snapshot()).toHaveLength(0);
  });
});
