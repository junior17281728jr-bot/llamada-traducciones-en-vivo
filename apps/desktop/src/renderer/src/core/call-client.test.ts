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
import { MicError, PlaybackError, type AudioIO, type CaptureOptions, type Playback } from './audio-io';
import { AUDIO_PREF_KEYS } from './audio-prefs';
import { LOCAL_DEVICES_MISSING_MESSAGE, createCallClient, type WebSocketLike } from './call-client';
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
  /** Binary frames of one audio type. */
  framesOf(type: number): Uint8Array[] {
    return this.micFrames().filter((frame) => frame[0] === type);
  }
}

class FakePlayback implements Playback {
  played: Uint8Array[] = [];
  sink: string | null = null;
  stops = 0;
  constructor(private readonly failSinkWith: PlaybackError | null) {}
  play(pcm: Uint8Array): void {
    this.played.push(pcm);
  }
  setVolume(): void {}
  setSink(deviceId: string): Promise<void> {
    if (this.failSinkWith) return Promise.reject(this.failSinkWith);
    this.sink = deviceId;
    return Promise.resolve();
  }
  stop(): void {
    this.stops += 1;
  }
}

class FakeAudio implements AudioIO {
  onPcm: ((pcm: Uint8Array) => void) | null = null;
  micStarts = 0;
  micStops = 0;
  failWith: MicError | null = null;
  played: Uint8Array[] = [];
  playbackStops = 0;
  /** "Modo audio del PC": captures of cable A and playbacks created for cable B. */
  captures: { onPcm: (pcm: Uint8Array) => void; options: CaptureOptions }[] = [];
  captureStops = 0;
  failCaptureWith: MicError | null = null;
  cablePlaybacks: FakePlayback[] = [];
  failSinkWith: PlaybackError | null = null;
  onEnded: (() => void) | null = null;
  async startMic(onPcm: (pcm: Uint8Array) => void, _deviceId?: string, onEnded?: () => void) {
    this.micStarts += 1;
    if (this.failWith) throw this.failWith;
    this.onPcm = onPcm;
    this.onEnded = onEnded ?? null;
    return { stop: () => void (this.micStops += 1) };
  }
  async startCapture(onPcm: (pcm: Uint8Array) => void, options: CaptureOptions) {
    if (this.failCaptureWith) throw this.failCaptureWith;
    this.captures.push({ onPcm, options });
    return { stop: () => void (this.captureStops += 1) };
  }
  createPlayback(): Playback {
    const playback = new FakePlayback(this.failSinkWith);
    this.cablePlaybacks.push(playback);
    return playback;
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
const activeLocalCall = (): ServerMessage => ({ type: 'call.state', callId: 'l1', state: 'active', direction: 'local', remoteNumber: 'WhatsApp', answeredAt: 1, muted: false, simulated: false });
const authOk = (debug = true, localAudio = false): ServerMessage => ({
  type: 'auth.ok',
  operator,
  token: 'tok-123',
  server: { protocolVersion: 1, providers: 'mock', channel: 'mock', debug, maxCalls: 3, localAudio },
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
let nowMs = 5000;

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
    now: () => nowMs,
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

function setCablePrefs(input: string | null = 'cable-a', output: string | null = 'cable-b'): void {
  for (const [key, value] of [
    [AUDIO_PREF_KEYS.passengerInput, input],
    [AUDIO_PREF_KEYS.passengerOutput, output],
  ] as const) {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  resetSessionForTests();
  setSession(session);
  setCablePrefs(null, null);
  nowMs = 5000;
  window.localStorage.removeItem(AUDIO_PREF_KEYS.autoWhatsapp);
  window.localStorage.removeItem(AUDIO_PREF_KEYS.autoEndSeconds);
});
afterEach(() => {
  vi.useRealTimers();
  resetSessionForTests();
  setCablePrefs(null, null);
  window.localStorage.removeItem(AUDIO_PREF_KEYS.autoWhatsapp);
  window.localStorage.removeItem(AUDIO_PREF_KEYS.autoEndSeconds);
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

  it('plays the translated voice and the relayed original voice (same language), and clears the waveforms when the ended call is dismissed', async () => {
    const client = setup();
    const ws = await connectAndStartCall(client);
    const voice = generateSinePcm16(200, 60, 0.4);
    const original = generateSinePcm16(300, 60, 0.4);
    ws.receiveBinary(encodeAudioFrame(AudioFrameType.TranslatedPassenger, voice));
    ws.receiveBinary(encodeAudioFrame(AudioFrameType.OriginalPassenger, original));
    expect(audio.played).toHaveLength(2);
    expect(Buffer.from(audio.played[0]!).equals(Buffer.from(voice))).toBe(true);
    expect(Buffer.from(audio.played[1]!).equals(Buffer.from(original))).toBe(true);

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

  it('never plays the voice meant for the cable (0x05) on the headphones of a phone call', async () => {
    const client = setup();
    const ws = await connectAndStartCall(client);
    ws.receiveBinary(encodeAudioFrame(AudioFrameType.TranslatedToPassenger, generateSinePcm16(200, 20, 0.4)));
    expect(audio.played).toHaveLength(0);
    expect(audio.cablePlaybacks).toHaveLength(0);
  });
});

describe('modo audio del PC', () => {
  // These tests start the translation by hand: the automatic entry stays off so it opens nothing of its own.
  beforeEach(() => window.localStorage.setItem(AUDIO_PREF_KEYS.autoWhatsapp, '0'));

  async function connectLocalReady(client: ReturnType<typeof setup>): Promise<FakeSocket> {
    client.actions.connect();
    socket().open();
    socket().receive(authOk(true, true));
    await flush();
    socket().sent.length = 0;
    return socket();
  }

  it('prepares cable A (no processing) and cable B, asks the server, sends the cable as 0x04 and plays 0x05 on cable B only', async () => {
    setCablePrefs();
    const client = setup();
    const ws = await connectLocalReady(client);
    const languages = { passengerSpeaks: { mode: 'fixed', lang: 'en' }, passengerHears: { mode: 'fixed', lang: 'en' } } as const;
    client.actions.startLocal!('WhatsApp', { langHint: 'en-US', languages });
    expect(ws.messages()).toEqual([]);
    await flush();

    expect(audio.cablePlaybacks).toHaveLength(1);
    expect(audio.cablePlaybacks[0]!.sink).toBe('cable-b');
    expect(audio.captures).toHaveLength(1);
    expect(audio.captures[0]!.options).toEqual({ deviceId: 'cable-a', processing: false });
    expect(audio.micStarts).toBe(0);
    expect(ws.messages()).toEqual([{ type: 'call.startLocal', label: 'WhatsApp', langHint: 'en', languages }]);

    // Audio captured before the server confirms is dropped.
    audio.captures[0]!.onPcm(generateSinePcm16(300, 20, 0.5));
    expect(ws.framesOf(AudioFrameType.PassengerLocal)).toHaveLength(0);

    ws.receive(activeLocalCall());
    ws.receive({
      type: 'call.languages',
      callId: 'l1',
      settings: { operatorLang: 'es', ...languages },
      detected: { lang: null, status: 'unknown', source: null, probability: null, agreeingSegments: 0 },
      notice: null,
    });
    await flush();
    expect(client.getState().call).toMatchObject({ direction: 'local', remoteNumber: 'WhatsApp', mic: 'live' });
    expect(audio.micStarts).toBe(1);

    // Cable A goes out as PassengerLocal, byte for byte, and never feeds the passenger lane locally.
    const voice = generateSinePcm16(300, 40, 0.5);
    audio.captures[0]!.onPcm(voice.slice(0, 640));
    audio.captures[0]!.onPcm(voice.slice(640, 1280));
    const frames = ws.framesOf(AudioFrameType.PassengerLocal);
    expect(frames).toHaveLength(2);
    const decoded = decodeAudioFrame(frames[0]!);
    expect(decoded.ok && Buffer.from(decoded.value.pcm).equals(Buffer.from(voice.slice(0, 640)))).toBe(true);
    expect(client.levels.passenger.snapshot()).toHaveLength(0);
    expect(client.levels.operator.snapshot()).toHaveLength(0);
    // The passenger lane still follows the server's measurement of that same audio.
    ws.receiveBinary(levelsFrame(LevelTrack.PassengerIn, [win(0.4)], 0));
    expect(client.levels.passenger.snapshot()).toHaveLength(1);

    // The operator microphone keeps working as always (0x01), measured locally.
    audio.onPcm!(generateSinePcm16(300, 20, 0.5));
    expect(ws.framesOf(AudioFrameType.OperatorMic)).toHaveLength(1);
    expect(client.levels.operator.snapshot().length).toBeGreaterThan(0);

    // 0x05 goes to cable B, never to the headphones; 0x02 goes to the headphones, never to the cable.
    const forCable = generateSinePcm16(180, 20, 0.4);
    const forOperator = generateSinePcm16(120, 20, 0.4);
    ws.receiveBinary(encodeAudioFrame(AudioFrameType.TranslatedToPassenger, forCable));
    ws.receiveBinary(encodeAudioFrame(AudioFrameType.TranslatedPassenger, forOperator));
    expect(audio.cablePlaybacks[0]!.played).toHaveLength(1);
    expect(Buffer.from(audio.cablePlaybacks[0]!.played[0]!).equals(Buffer.from(forCable))).toBe(true);
    expect(audio.played).toHaveLength(1);
    expect(Buffer.from(audio.played[0]!).equals(Buffer.from(forOperator))).toBe(true);

    // Ending releases everything: capture, cable playback and microphone; late cable audio goes nowhere.
    ws.receive({ type: 'call.ended', callId: 'l1', reason: 'hangup_operator', durationMs: 100 });
    expect(audio.captureStops).toBe(1);
    expect(audio.cablePlaybacks[0]!.stops).toBeGreaterThanOrEqual(1);
    expect(audio.micStops).toBe(1);
    audio.captures[0]!.onPcm(voice.slice(0, 640));
    expect(ws.framesOf(AudioFrameType.PassengerLocal)).toHaveLength(2);
    ws.receiveBinary(encodeAudioFrame(AudioFrameType.TranslatedToPassenger, forCable));
    expect(audio.cablePlaybacks[0]!.played).toHaveLength(1);
  });

  it('does not start without the two devices from Settings, and says where to choose them', async () => {
    setCablePrefs('cable-a', null);
    const client = setup();
    const ws = await connectLocalReady(client);
    client.actions.startLocal!('WhatsApp');
    await flush();
    expect(ws.messages()).toEqual([]);
    expect(audio.captures).toHaveLength(0);
    expect(audio.cablePlaybacks).toHaveLength(0);
    expect(client.getState().lastError).toMatchObject({ code: 'audio', message: LOCAL_DEVICES_MISSING_MESSAGE });
    expect(client.getState().lastError!.message).toContain('Ajustes > Audio');
  });

  it('does not start when the output cannot be chosen (no setSinkId) or a cable is missing, and releases what it prepared', async () => {
    setCablePrefs();
    const client = setup();
    const ws = await connectLocalReady(client);
    audio.failSinkWith = new PlaybackError('unsupported', 'Este equipo no permite elegir el dispositivo de salida de audio (falta AudioContext.setSinkId).');
    client.actions.startLocal!('WhatsApp');
    await flush();
    expect(ws.messages()).toEqual([]);
    expect(audio.captures).toHaveLength(0);
    expect(audio.cablePlaybacks[0]!.stops).toBe(1);
    expect(client.getState().lastError!.message).toContain('setSinkId');

    audio.failSinkWith = null;
    audio.failCaptureWith = new MicError('unavailable', 'No se encuentra el dispositivo de entrada elegido');
    client.actions.startLocal!('WhatsApp');
    await flush();
    expect(ws.messages()).toEqual([]);
    expect(audio.cablePlaybacks).toHaveLength(2);
    expect(audio.cablePlaybacks[1]!.stops).toBe(1);
    expect(client.getState().lastError!.message).toContain('cable A');
  });

  it('refuses when the server has no modo audio del PC, without a connection, or during a call', async () => {
    setCablePrefs();
    const client = setup();
    client.actions.connect();
    socket().open();
    socket().receive(authOk(true, false));
    await flush();
    socket().sent.length = 0;
    client.actions.startLocal!('WhatsApp');
    await flush();
    expect(socket().messages()).toEqual([]);
    expect(client.getState().lastError!.message).toContain('no admite el modo audio del PC');

    socket().receive(authOk(true, true));
    socket().receive(activeCall());
    await flush();
    socket().sent.length = 0;
    client.actions.startLocal!('WhatsApp');
    await flush();
    expect(socket().messages()).toEqual([]);
    expect(client.getState().lastError!.message).toContain('llamada en curso');
    expect(audio.captures).toHaveLength(0);
  });

  it('releases the prepared cable devices when the server refuses the local call or the connection drops', async () => {
    setCablePrefs();
    const client = setup({ reconnectDelaysMs: [100] });
    const ws = await connectLocalReady(client);
    client.actions.startLocal!('WhatsApp');
    await flush();
    expect(ws.messages()).toHaveLength(1);
    ws.receive({ type: 'error', code: 'operator_busy', message: 'Ya estás en una llamada' });
    expect(audio.captureStops).toBe(1);
    expect(audio.cablePlaybacks[0]!.stops).toBe(1);
    expect(client.getState().lastError).toMatchObject({ code: 'operator_busy' });

    client.actions.startLocal!('WhatsApp');
    await flush();
    expect(audio.captures).toHaveLength(2);
    ws.drop();
    expect(audio.captureStops).toBe(2);
    expect(audio.cablePlaybacks[1]!.stops).toBe(1);
  });
});

describe('entrada automática de WhatsApp', () => {
  const loud = (): Uint8Array => generateSinePcm16(300, 20, 0.5);
  const quiet = (): Uint8Array => silencePcm16(20);
  const feed = (capture: { onPcm: (pcm: Uint8Array) => void }, make: () => Uint8Array, frames: number): void => {
    for (let i = 0; i < frames; i++) capture.onPcm(make());
  };

  async function connectReady(client: ReturnType<typeof setup>): Promise<FakeSocket> {
    client.actions.connect();
    socket().open();
    socket().receive(authOk(true, true));
    await flush();
    socket().sent.length = 0;
    return socket();
  }

  it('listens to cable A while idle; sound there starts the call, and the first words are not lost', async () => {
    setCablePrefs();
    const client = setup();
    const ws = await connectReady(client);
    expect(client.getState().watch).toMatchObject({ enabled: true, status: 'listening' });
    expect(audio.captures).toHaveLength(1);
    expect(audio.captures[0]!.options).toMatchObject({ deviceId: 'cable-a', processing: false });

    // Line noise does not start anything.
    feed(audio.captures[0]!, quiet, 100);
    await flush();
    expect(ws.messages()).toEqual([]);

    // A short ding (a notification) does not either.
    feed(audio.captures[0]!, loud, 20);
    feed(audio.captures[0]!, quiet, 80);
    await flush();
    expect(ws.messages()).toEqual([]);

    // A ring or a voice for more than half a second does.
    feed(audio.captures[0]!, loud, 30);
    await flush();
    expect(ws.messages()).toEqual([{ type: 'call.startLocal', label: 'WhatsApp' }]);
    expect(audio.cablePlaybacks).toHaveLength(1);
    expect(audio.cablePlaybacks[0]!.sink).toBe('cable-b');
    expect(client.getState().watch.status).toBe('starting');
    feed(audio.captures[0]!, loud, 5);

    ws.receive(activeLocalCall());
    await flush();
    expect(client.getState().watch.status).toBe('in_call');
    // The same capture now feeds the call, beginning with what was said while it entered.
    const sent = ws.framesOf(AudioFrameType.PassengerLocal).length;
    expect(sent).toBeGreaterThanOrEqual(35);
    feed(audio.captures[0]!, loud, 3);
    expect(ws.framesOf(AudioFrameType.PassengerLocal)).toHaveLength(sent + 3);
    expect(audio.captures).toHaveLength(1);
  });

  it('after a call it waits for a quiet cable before listening again, so a call still going on in WhatsApp does not re-enter', async () => {
    setCablePrefs();
    const client = setup();
    const ws = await connectReady(client);
    feed(audio.captures[0]!, loud, 30);
    await flush();
    ws.receive(activeLocalCall());
    await flush();
    ws.receive({ type: 'call.ended', callId: 'l1', reason: 'hangup_operator', durationMs: 1000 });
    await flush();
    expect(audio.captureStops).toBe(1);
    expect(audio.captures).toHaveLength(2);
    expect(client.getState().watch.status).toBe('arming');
    ws.sent.length = 0;

    feed(audio.captures[1]!, loud, 50);
    await flush();
    expect(ws.messages()).toEqual([]);
    feed(audio.captures[1]!, quiet, 130);
    await flush();
    expect(client.getState().watch.status).toBe('listening');
    feed(audio.captures[1]!, loud, 30);
    await flush();
    expect(ws.messages()).toEqual([{ type: 'call.startLocal', label: 'WhatsApp' }]);
  });

  it('can be turned off, says when the cables are missing, and releases everything when the server refuses', async () => {
    const client = setup();
    await connectReady(client);
    expect(client.getState().watch.status).toBe('needs_setup');
    expect(audio.captures).toHaveLength(0);

    setCablePrefs();
    client.actions.refreshAudioPrefs!();
    await flush();
    expect(client.getState().watch.status).toBe('listening');
    client.actions.setAutoWhatsapp!(false);
    await flush();
    expect(client.getState().watch).toMatchObject({ enabled: false, status: 'off' });
    expect(audio.captureStops).toBe(1);
    expect(window.localStorage.getItem(AUDIO_PREF_KEYS.autoWhatsapp)).toBe('0');

    client.actions.setAutoWhatsapp!(true);
    await flush();
    feed(audio.captures[1]!, loud, 30);
    await flush();
    socket().receive({ type: 'error', code: 'max_calls_reached', message: 'Todas las líneas están ocupadas' });
    await flush();
    expect(audio.cablePlaybacks[0]!.stops).toBe(1);
    expect(client.getState().watch.status).toBe('arming');
  });

  it('closes a local call whose cable stayed silent, after a countdown the operator can cancel', async () => {
    window.localStorage.setItem(AUDIO_PREF_KEYS.autoEndSeconds, '20');
    setCablePrefs();
    const client = setup();
    const ws = await connectReady(client);
    feed(audio.captures[0]!, loud, 30);
    await flush();
    ws.receive(activeLocalCall());
    await flush();
    ws.sent.length = 0;

    feed(audio.captures[0]!, quiet, 1000);
    await vi.advanceTimersByTimeAsync(100);
    expect(client.getState().call!.autoEndAt).toBe(nowMs + 10_000);
    client.actions.keepCall!();
    expect(client.getState().call!.autoEndAt).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    expect(client.getState().call!.autoEndAt).toBeNull();

    // Voice during the countdown cancels it too.
    feed(audio.captures[0]!, quiet, 1000);
    await vi.advanceTimersByTimeAsync(100);
    expect(client.getState().call!.autoEndAt).not.toBeNull();
    feed(audio.captures[0]!, loud, 1);
    await vi.advanceTimersByTimeAsync(100);
    expect(client.getState().call!.autoEndAt).toBeNull();

    feed(audio.captures[0]!, quiet, 1000);
    await vi.advanceTimersByTimeAsync(100);
    nowMs += 10_000;
    await vi.advanceTimersByTimeAsync(100);
    expect(ws.messages()).toEqual([{ type: 'call.hangup', callId: 'l1' }]);
  });
});

describe('cutting the voice and losing the microphone', () => {
  it('stops the translated voice at once when the call ends, whoever hung up', async () => {
    const client = setup();
    const ws = await connectAndStartCall(client);
    ws.receiveBinary(encodeAudioFrame(AudioFrameType.TranslatedPassenger, generateSinePcm16(200, 60, 0.4)));
    expect(audio.played).toHaveLength(1);
    const stopsBefore = audio.playbackStops;
    ws.receive({ type: 'call.ended', callId: 'c1', reason: 'hangup_passenger', durationMs: 5 });
    expect(audio.playbackStops).toBe(stopsBefore + 1);
    // Nothing that arrives late is played either.
    ws.receiveBinary(encodeAudioFrame(AudioFrameType.TranslatedPassenger, generateSinePcm16(200, 60, 0.4)));
    expect(audio.played).toHaveLength(1);
  });

  it('warns when the microphone disappears mid-call and gets it back', async () => {
    const client = setup();
    await connectAndStartCall(client);
    expect(audio.micStarts).toBe(1);
    audio.onEnded?.();
    expect(client.getState().call!.mic).toBe('unavailable');
    expect(client.getState().lastError?.message).toContain('Se ha desconectado el micrófono');
    await vi.advanceTimersByTimeAsync(1600);
    expect(audio.micStarts).toBe(2);
    expect(client.getState().call!.mic).toBe('live');
  });

  it('gives up after a few failed attempts and says so', async () => {
    const client = setup();
    await connectAndStartCall(client);
    audio.failWith = new MicError('unavailable', 'No se encontró ningún micrófono');
    audio.onEnded?.();
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(1600);
    expect(audio.micStarts).toBe(4);
    expect(client.getState().call!.mic).toBe('unavailable');
    expect(client.getState().lastError?.message).toContain('no se ha podido recuperar');
    await vi.advanceTimersByTimeAsync(5000);
    expect(audio.micStarts).toBe(4);
  });

  it('a recovered microphone starts the attempt count again', async () => {
    const client = setup();
    await connectAndStartCall(client);
    for (let i = 0; i < 5; i++) {
      audio.onEnded?.();
      await vi.advanceTimersByTimeAsync(1600);
      expect(client.getState().call!.mic).toBe('live');
    }
    expect(audio.micStarts).toBe(6);
  });
});
