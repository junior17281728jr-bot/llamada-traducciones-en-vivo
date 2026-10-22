import { describe, expect, it } from 'vitest';
import { computeEnvelope, generateSinePcm16, silencePcm16 } from './audio.js';
import {
  API_PATHS,
  AudioFrameType,
  CLIENT_ACCEPTED_FRAME_TYPES,
  LEVELS_FRAME_TYPE,
  LEVELS_HEADER_BYTES,
  LEVELS_WINDOW_BYTES,
  LevelTrack,
  LevelsFrameBuilder,
  MAX_AUDIO_PAYLOAD_BYTES,
  PutKeysRequestSchema,
  SERVER_ACCEPTED_FRAME_TYPES,
  decodeAudioFrame,
  decodeBinaryFrame,
  decodeLevelsFrame,
  encodeAudioFrame,
  encodeLevelsFrame,
  encodeMessage,
  parseClientMessage,
  parseServerMessage,
  parseSimClientMessage,
  parseSimServerMessage,
  type LevelsFrame,
  type ServerMessage,
} from './protocol.js';
import { UNKNOWN_LANGUAGE_STATE } from './types.js';

describe('client messages', () => {
  it('accepts every message type of the protocol', () => {
    const valid = [
      { type: 'auth.login', username: 'ana', password: 'x' },
      { type: 'auth.resume', token: 'abc' },
      { type: 'call.accept', callId: 'c1' },
      { type: 'call.reject', callId: 'c1' },
      { type: 'call.hangup', callId: 'c1' },
      { type: 'call.dial', number: '+34 600 111 222' },
      { type: 'call.dial', number: '+33612345678', languages: { passengerSpeaks: { mode: 'fixed', lang: 'fr' } } },
      { type: 'call.setLanguages', callId: 'c1', settings: { passengerHears: { mode: 'fixed', lang: 'it' } } },
      { type: 'call.setLanguages', callId: 'c1', settings: {} },
      { type: 'call.mute', callId: 'c1', muted: true },
      { type: 'debug.say', text: 'Hello', lang: 'en' },
    ];
    for (const message of valid) {
      const result = parseClientMessage(JSON.stringify(message));
      expect(result.ok, JSON.stringify(message)).toBe(true);
    }
  });

  it('rejects malformed input with a reason', () => {
    expect(parseClientMessage('not json')).toEqual({ ok: false, error: 'Invalid JSON' });
    expect(parseClientMessage(JSON.stringify({ type: 'nope' })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ type: 'call.dial', number: 'abc' })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ type: 'debug.say', text: 'hi', lang: 'xx' })).ok).toBe(false);
    expect(
      parseClientMessage(
        JSON.stringify({ type: 'call.setLanguages', callId: 'c1', settings: { passengerHears: { mode: 'fixed' } } }),
      ).ok,
    ).toBe(false);
    expect(parseClientMessage('x'.repeat(70_000))).toEqual({ ok: false, error: 'Message too large' });
  });

  it('round-trips through encodeMessage', () => {
    const message = { type: 'call.mute', callId: 'c9', muted: false } as const;
    expect(parseClientMessage(encodeMessage(message))).toEqual({ ok: true, value: message });
  });
});

describe('server messages', () => {
  const segment = {
    id: 's1',
    callId: 'c1',
    speaker: 'passenger',
    originalLang: 'en',
    originalText: 'Hello',
    translatedLang: 'es',
    translatedText: 'Hola',
    startMs: 0,
    endMs: 900,
    final: true,
    createdAt: 1_700_000_000_000,
  } as const;

  const operator = { id: 'op1', name: 'Ana', role: 'operator', status: 'available', currentCallId: null, autoAccept: false } as const;

  it('accepts the messages the UI relies on', () => {
    const messages: ServerMessage[] = [
      {
        type: 'auth.ok',
        operator,
        token: 't',
        server: { protocolVersion: 1, providers: 'mock', channel: 'mock', debug: true, maxCalls: 3 },
      },
      { type: 'auth.error', code: 'invalid_credentials', message: 'No' },
      { type: 'presence', operators: [operator], activeCalls: 0, maxCalls: 3 },
      { type: 'call.incoming', callId: 'c1', from: '+3312345678', langHint: 'fr', ringTimeoutSeconds: 30 },
      {
        type: 'call.state',
        callId: 'c1',
        state: 'active',
        direction: 'inbound',
        remoteNumber: '+3312345678',
        answeredAt: 1,
        muted: false,
        simulated: true,
      },
      {
        type: 'call.languages',
        callId: 'c1',
        settings: { operatorLang: 'es', passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'follow' } },
        detected: { lang: 'fr', status: 'uncertain', source: 'stt', probability: 0.4, agreeingSegments: 0 },
        notice: { kind: 'uncertain', lang: null, candidates: { stt: 'fr', translator: 'it' }, at: 5 },
      },
      {
        type: 'call.languages',
        callId: 'c1',
        settings: { operatorLang: 'es', passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'follow' } },
        detected: UNKNOWN_LANGUAGE_STATE,
        notice: null,
      },
      { type: 'call.ended', callId: 'c1', reason: 'hangup_passenger', durationMs: 1000 },
      { type: 'transcript.segment', segment },
      { type: 'pipeline.stage', callId: 'c1', direction: 'passenger_to_operator', stage: 'translating', segmentId: 's1' },
      { type: 'pipeline.stage', callId: 'c1', direction: 'operator_to_passenger', stage: 'error', detail: 'TTS caído' },
      { type: 'system.status', elevenlabs: 'simulated', translator: 'simulated', channel: 'simulated' },
      { type: 'system.status', elevenlabs: 'down', translator: 'ok', channel: 'degraded', detail: { elevenlabs: 'sin clave' } },
      { type: 'error', code: 'unknown_call', message: 'x', callId: 'c1' },
    ];
    for (const message of messages) {
      const parsed = parseServerMessage(encodeMessage(message));
      expect(parsed, message.type).toEqual({ ok: true, value: message });
    }
  });

  it('rejects an unknown pipeline stage and an unknown service status', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'pipeline.stage', callId: 'c', direction: 'passenger_to_operator', stage: 'dancing' })).ok).toBe(false);
    expect(parseServerMessage(JSON.stringify({ type: 'system.status', elevenlabs: 'fine', translator: 'ok', channel: 'ok' })).ok).toBe(false);
  });
});

describe('simulator protocol', () => {
  it('validates client and server messages', () => {
    for (const message of [
      { type: 'sim.incoming', from: '+33123456789', lang: 'fr' },
      { type: 'sim.listen', lang: 'it' },
      { type: 'sim.answer' },
      { type: 'sim.say', text: 'Bonjour', lang: 'fr' },
      { type: 'sim.say', text: 'Bonjour', lang: 'fr', audio: 'AAA=' },
      { type: 'sim.audio', audio: 'AAAA' },
      { type: 'sim.hangup' },
    ]) {
      expect(parseSimClientMessage(JSON.stringify(message)).ok, JSON.stringify(message)).toBe(true);
    }
    for (const message of [
      { type: 'sim.audio', audio: 'AAAA', text: 'Hola' },
      { type: 'sim.state', state: 'active', callId: 'c1', direction: 'inbound' },
      { type: 'sim.state', state: 'ended', callId: null, reason: 'hangup_operator' },
    ]) {
      expect(parseSimServerMessage(JSON.stringify(message)).ok, JSON.stringify(message)).toBe(true);
    }
    expect(parseSimClientMessage(JSON.stringify({ type: 'sim.say', text: '', lang: 'fr' })).ok).toBe(false);
  });
});

describe('audio frames', () => {
  it('prefix the PCM with the frame type and decode it back', () => {
    const pcm = generateSinePcm16(440, 20);
    const frame = encodeAudioFrame(AudioFrameType.OperatorMic, pcm);
    expect(frame[0]).toBe(0x01);
    const decoded = decodeAudioFrame(frame);
    expect(decoded.ok && decoded.value.type).toBe(AudioFrameType.OperatorMic);
    expect(decoded.ok && decoded.value.pcm).toEqual(pcm);
  });

  it('uses the documented type bytes', () => {
    expect(AudioFrameType.OperatorMic).toBe(0x01);
    expect(AudioFrameType.TranslatedPassenger).toBe(0x02);
    expect(AudioFrameType.OriginalPassenger).toBe(0x03);
    expect(LEVELS_FRAME_TYPE).toBe(0x10);
  });

  it('enforces which side may send which type', () => {
    const mic = encodeAudioFrame(AudioFrameType.OperatorMic, silencePcm16(20));
    const voice = encodeAudioFrame(AudioFrameType.TranslatedPassenger, silencePcm16(20));
    expect(decodeAudioFrame(mic, SERVER_ACCEPTED_FRAME_TYPES).ok).toBe(true);
    expect(decodeAudioFrame(voice, SERVER_ACCEPTED_FRAME_TYPES).ok).toBe(false);
    expect(decodeAudioFrame(voice, CLIENT_ACCEPTED_FRAME_TYPES).ok).toBe(true);
    expect(decodeAudioFrame(mic, CLIENT_ACCEPTED_FRAME_TYPES).ok).toBe(false);
  });

  it('rejects empty, unknown, odd-length and oversized frames', () => {
    expect(decodeAudioFrame(new Uint8Array(0)).ok).toBe(false);
    expect(decodeAudioFrame(Uint8Array.from([0x7f, 0, 0])).ok).toBe(false);
    expect(decodeAudioFrame(Uint8Array.from([0x01, 0, 0, 0])).ok).toBe(false);
    expect(decodeAudioFrame(new Uint8Array(MAX_AUDIO_PAYLOAD_BYTES + 3)).ok).toBe(false);
  });
});

describe('levels frames', () => {
  const frame: LevelsFrame = {
    track: LevelTrack.OperatorIn,
    seq: 4_000_000_000,
    timeMs: 123_456,
    windows: [
      { min: -0.5, max: 0.25, rms: 0.125 },
      { min: 0, max: 0, rms: 0 },
      { min: -1, max: 32767 / 32768, rms: 1 },
    ],
  };

  it('uses the documented byte layout', () => {
    const bytes = encodeLevelsFrame(frame);
    expect(bytes.byteLength).toBe(LEVELS_HEADER_BYTES + 3 * LEVELS_WINDOW_BYTES);
    const view = new DataView(bytes.buffer);
    expect(view.getUint8(0)).toBe(0x10);
    expect(view.getUint8(1)).toBe(1);
    expect(view.getUint32(2, true)).toBe(4_000_000_000);
    expect(view.getUint32(6, true)).toBe(123_456);
    expect(view.getUint8(10)).toBe(3);
    expect(view.getInt16(11, true)).toBe(-16384);
    expect(view.getInt16(13, true)).toBe(8192);
    expect(view.getUint16(15, true)).toBe(Math.round(0.125 * 65535));
    expect(view.getUint16(17 + 6 + 4, true)).toBe(65535);
  });

  it('round-trips within the quantisation error', () => {
    const decoded = decodeLevelsFrame(encodeLevelsFrame(frame));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.track).toBe(LevelTrack.OperatorIn);
    expect(decoded.value.seq).toBe(4_000_000_000);
    expect(decoded.value.timeMs).toBe(123_456);
    decoded.value.windows.forEach((window, i) => {
      expect(window.min).toBeCloseTo(frame.windows[i]!.min, 4);
      expect(window.max).toBeCloseTo(frame.windows[i]!.max, 4);
      expect(window.rms).toBeCloseTo(frame.windows[i]!.rms, 4);
    });
  });

  it('carries real envelopes computed from audio, track by track', () => {
    const passenger = computeEnvelope(generateSinePcm16(300, 40, 0.7), 16000, 20);
    const operator = computeEnvelope(silencePcm16(40), 16000, 20);
    const a = decodeLevelsFrame(encodeLevelsFrame({ track: LevelTrack.PassengerIn, seq: 0, timeMs: 0, windows: passenger }));
    const b = decodeLevelsFrame(encodeLevelsFrame({ track: LevelTrack.OperatorIn, seq: 0, timeMs: 0, windows: operator }));
    expect(a.ok && a.value.track).toBe(LevelTrack.PassengerIn);
    expect(a.ok && a.value.windows.some((w) => w.rms > 0.3)).toBe(true);
    expect(b.ok && b.value.track).toBe(LevelTrack.OperatorIn);
    expect(b.ok && b.value.windows.every((w) => w.rms === 0 && w.max === 0 && w.min === 0)).toBe(true);
  });

  it('an empty frame is a valid heartbeat', () => {
    const decoded = decodeLevelsFrame(encodeLevelsFrame({ track: LevelTrack.PassengerIn, seq: 7, timeMs: 10, windows: [] }));
    expect(decoded).toEqual({ ok: true, value: { track: 0, seq: 7, timeMs: 10, windows: [] } });
  });

  it('decodes from a view with an odd byteOffset (as received from a socket)', () => {
    const bytes = encodeLevelsFrame(frame);
    const backing = new Uint8Array(bytes.byteLength + 1);
    backing.set(bytes, 1);
    const decoded = decodeLevelsFrame(backing.subarray(1));
    expect(decoded.ok && decoded.value.seq).toBe(4_000_000_000);
  });

  it('rejects wrong type, unknown track, short and inconsistent frames', () => {
    const good = encodeLevelsFrame(frame);
    expect(decodeLevelsFrame(good.subarray(0, 5)).ok).toBe(false);
    expect(decodeLevelsFrame(good.subarray(0, good.byteLength - 1)).ok).toBe(false);
    const wrongTrack = good.slice();
    wrongTrack[1] = 9;
    expect(decodeLevelsFrame(wrongTrack).ok).toBe(false);
    const wrongType = good.slice();
    wrongType[0] = 0x01;
    expect(decodeLevelsFrame(wrongType).ok).toBe(false);
  });

  it('refuses to encode more windows than the count byte can hold', () => {
    const windows = new Array(256).fill({ min: 0, max: 0, rms: 0 });
    expect(() => encodeLevelsFrame({ track: 0, seq: 0, timeMs: 0, windows })).toThrow(RangeError);
  });

  it('decodeBinaryFrame dispatches by type and honours the allowed list', () => {
    const levels = encodeLevelsFrame(frame);
    const voice = encodeAudioFrame(AudioFrameType.OriginalPassenger, silencePcm16(20));
    const asLevels = decodeBinaryFrame(levels, CLIENT_ACCEPTED_FRAME_TYPES);
    expect(asLevels.ok && asLevels.value.kind).toBe('levels');
    const asAudio = decodeBinaryFrame(voice, CLIENT_ACCEPTED_FRAME_TYPES);
    expect(asAudio.ok && asAudio.value.kind).toBe('audio');
    expect(decodeBinaryFrame(levels, SERVER_ACCEPTED_FRAME_TYPES).ok).toBe(false);
    expect(decodeBinaryFrame(new Uint8Array(0)).ok).toBe(false);
  });
});

describe('LevelsFrameBuilder', () => {
  const decode = (frame: Uint8Array) => {
    const result = decodeLevelsFrame(frame);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };

  it('emits one frame per 20 ms chunk with consecutive seq and call-relative times', () => {
    const builder = new LevelsFrameBuilder(LevelTrack.PassengerIn, 1000);
    const frames = [0, 1, 2].flatMap(() => builder.push(generateSinePcm16(300, 20, 0.5)));
    const decoded = frames.map(decode);
    expect(decoded.map((f) => f.seq)).toEqual([0, 1, 2]);
    expect(decoded.map((f) => f.timeMs)).toEqual([1000, 1020, 1040]);
    expect(decoded.every((f) => f.track === LevelTrack.PassengerIn && f.windows.length === 1)).toBe(true);
  });

  it('coalesces chunks smaller than a window and groups windows of big chunks', () => {
    const builder = new LevelsFrameBuilder(LevelTrack.OperatorIn);
    expect(builder.push(silencePcm16(10))).toEqual([]);
    expect(builder.push(silencePcm16(10)).map(decode)[0]!.windows).toHaveLength(1);
    const big = builder.push(silencePcm16(100)).map(decode);
    expect(big).toHaveLength(1);
    expect(big[0]!.windows).toHaveLength(5);
    expect(big[0]!.timeMs).toBe(20);
  });

  it('splits more than 255 windows into several frames', () => {
    const builder = new LevelsFrameBuilder(LevelTrack.PassengerIn);
    const frames = builder.push(silencePcm16(20 * 300)).map(decode);
    expect(frames.map((f) => f.windows.length)).toEqual([255, 45]);
    expect(frames[1]!.timeMs).toBe(255 * 20);
  });

  it('reports digital silence as flat and speech as moving, per track, independently', () => {
    const passenger = new LevelsFrameBuilder(LevelTrack.PassengerIn);
    const operator = new LevelsFrameBuilder(LevelTrack.OperatorIn);
    const spoken = passenger.push(generateSinePcm16(250, 100, 0.6)).map(decode);
    const quiet = operator.push(silencePcm16(100)).map(decode);
    expect(spoken.flatMap((f) => f.windows).some((w) => w.rms > 0.2)).toBe(true);
    expect(quiet.flatMap((f) => f.windows).every((w) => w.rms === 0 && w.min === 0 && w.max === 0)).toBe(true);
    expect(quiet.every((f) => f.track === LevelTrack.OperatorIn)).toBe(true);
  });

  it('heartbeats keep the sequence going without windows', () => {
    const builder = new LevelsFrameBuilder(LevelTrack.PassengerIn);
    builder.push(silencePcm16(20));
    const beat = decode(builder.heartbeat(5000));
    expect(beat).toEqual({ track: 0, seq: 1, timeMs: 5000, windows: [] });
    expect(builder.nextSeq).toBe(2);
  });
});

describe('HTTP API helpers', () => {
  it('builds paths and escapes ids', () => {
    expect(API_PATHS.login).toBe('/api/login');
    expect(API_PATHS.test('elevenlabs')).toBe('/api/settings/test/elevenlabs');
    expect(API_PATHS.call('a/b')).toBe('/api/calls/a%2Fb');
    expect(API_PATHS.callAudio('c1', 'mixed')).toBe('/api/calls/c1/audio/mixed');
  });

  it('keys are write-only: the request carries values, only known names are accepted', () => {
    expect(PutKeysRequestSchema.safeParse({ keys: { ELEVENLABS_API_KEY: 'sk_x', ANTHROPIC_API_KEY: null } }).success).toBe(true);
    expect(PutKeysRequestSchema.safeParse({ keys: {} }).success).toBe(true);
    expect(PutKeysRequestSchema.safeParse({ keys: { SOMETHING_ELSE: 'x' } }).success).toBe(false);
  });
});
