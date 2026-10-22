import { describe, expect, it } from 'vitest';
import {
  EnvelopeMeter,
  FrameChunker,
  INTERNAL_SAMPLE_RATE,
  InternalToWire,
  Resampler,
  WireToInternal,
  alawToPcm16,
  base64ToPcm16,
  computeEnvelope,
  concatPcm,
  float32ToPcm16,
  generateSinePcm16,
  int16ToPcm16,
  mixPcm16,
  mulawToPcm16,
  parseWav,
  pcm16Dbfs,
  pcm16Rms,
  pcm16ToAlaw,
  pcm16ToBase64,
  pcm16ToFloat32,
  pcm16ToInt16,
  pcm16ToMulaw,
  pcm16ToWav,
  pcmDurationMs,
  resamplePcm16,
  silencePcm16,
  speechSignalDurationMs,
  splitFrames,
  synthesizeSpeechSignal,
} from './audio.js';

function samples(values: number[]): Uint8Array {
  return int16ToPcm16(Int16Array.from(values));
}

describe('base64', () => {
  it('round-trips PCM16 bytes', () => {
    const pcm = samples([0, 1, -1, 32767, -32768, 1234]);
    expect(base64ToPcm16(pcm16ToBase64(pcm))).toEqual(pcm);
  });

  it('works on a view with an odd byteOffset', () => {
    const backing = new Uint8Array([9, 1, 0, 2, 0, 3, 0]);
    const view = backing.subarray(1);
    expect(pcm16ToInt16(base64ToPcm16(pcm16ToBase64(view)))).toEqual(Int16Array.from([1, 2, 3]));
  });

  it('rejects invalid base64', () => {
    expect(() => base64ToPcm16('not*base64')).toThrow();
  });
});

describe('Resampler', () => {
  it('doubles the sample count 8 kHz -> 16 kHz and keeps a DC level', () => {
    const out = pcm16ToInt16(resamplePcm16(samples(new Array(80).fill(1000)), 8000, 16000));
    expect(out.length).toBeGreaterThanOrEqual(158);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(new Set(out)).toEqual(new Set([1000]));
  });

  it('halves the sample count 48 kHz -> 16 kHz', () => {
    const out = resamplePcm16(generateSinePcm16(440, 100, 0.3, 48000), 48000, 16000);
    expect(pcmDurationMs(out)).toBeGreaterThan(98);
    expect(pcmDurationMs(out)).toBeLessThanOrEqual(100);
  });

  it('streaming output matches the one-shot result, whatever the chunking', () => {
    const input = generateSinePcm16(300, 200, 0.5, 24000);
    const oneShot = resamplePcm16(input, 24000, 16000);
    const resampler = new Resampler(24000, 16000);
    const parts: Uint8Array[] = [];
    // Chunk sizes include odd byte counts on purpose.
    for (let offset = 0, size = 7; offset < input.length; offset += size, size = size === 7 ? 1001 : 7) {
      parts.push(resampler.process(input.subarray(offset, offset + size)));
    }
    parts.push(resampler.flush());
    expect(concatPcm(parts)).toEqual(oneShot);
  });
});

describe('G.711', () => {
  it('mu-law decodes the reference values', () => {
    const decoded = pcm16ToInt16(mulawToPcm16(Uint8Array.from([0xff, 0x7f, 0x00, 0x80])));
    expect(Array.from(decoded)).toEqual([0, 0, -32124, 32124]);
  });

  it('A-law decodes the reference values', () => {
    const decoded = pcm16ToInt16(alawToPcm16(Uint8Array.from([0xd5, 0x55, 0xaa, 0x2a])));
    expect(Array.from(decoded)).toEqual([8, -8, 32256, -32256]);
  });

  it('encode/decode round-trip stays within the companding error', () => {
    const original = Int16Array.from([0, 100, -100, 1000, -1000, 8000, -8000, 20000, -20000]);
    const pcm = int16ToPcm16(original);
    for (const [encode, decode] of [
      [pcm16ToMulaw, mulawToPcm16],
      [pcm16ToAlaw, alawToPcm16],
    ] as const) {
      const back = pcm16ToInt16(decode(encode(pcm)));
      back.forEach((value, i) => {
        const o = original[i]!;
        expect(Math.abs(value - o)).toBeLessThanOrEqual(Math.max(40, Math.abs(o) * 0.04));
      });
    }
  });
});

describe('wire format converters', () => {
  it('converts mu-law 8 kHz telephony audio to the internal format', () => {
    const toInternal = new WireToInternal('ulaw_8000');
    const out = toInternal.push(pcm16ToMulaw(generateSinePcm16(500, 100, 0.4, 8000)));
    expect(pcmDurationMs(out, INTERNAL_SAMPLE_RATE)).toBeGreaterThan(98);
    expect(pcm16Rms(out)).toBeGreaterThan(0.2);
  });

  it('converts the internal format to mu-law 8 kHz and back', () => {
    const toWire = new InternalToWire('ulaw_8000');
    const wire = toWire.push(generateSinePcm16(500, 100, 0.4));
    expect(wire.byteLength).toBeGreaterThanOrEqual(798);
    expect(wire.byteLength).toBeLessThanOrEqual(800);
  });

  it.each(['pcm_16000', 'pcm_22050', 'pcm_24000', 'pcm_44100'])('accepts %s', (format) => {
    expect(new WireToInternal(format).format.codec).toBe('pcm');
  });

  it('rejects formats it cannot decode', () => {
    expect(() => new WireToInternal('mp3_44100_128')).toThrow(/Unsupported/);
  });
});

describe('framing', () => {
  it('splits into frames of N ms and returns the remainder', () => {
    const pcm = silencePcm16(70); // 1120 samples
    const { frames, remainder } = splitFrames(pcm, 20);
    expect(frames).toHaveLength(3);
    expect(frames.every((frame) => pcmDurationMs(frame) === 20)).toBe(true);
    expect(pcmDurationMs(remainder)).toBe(10);
  });

  it('FrameChunker re-frames arbitrary chunks without losing bytes', () => {
    const chunker = new FrameChunker(20);
    const input = generateSinePcm16(200, 100);
    const frames: Uint8Array[] = [];
    for (let offset = 0; offset < input.length; offset += 333) frames.push(...chunker.push(input.subarray(offset, offset + 333)));
    const tail = chunker.flush();
    expect(frames).toHaveLength(5);
    expect(tail).toBeNull();
    expect(concatPcm(frames)).toEqual(input);
  });
});

describe('level metering', () => {
  it('measures RMS and dBFS', () => {
    expect(pcm16Rms(silencePcm16(20))).toBe(0);
    expect(pcm16Dbfs(silencePcm16(20))).toBe(-120);
    const square = samples(new Array(100).fill(16384));
    expect(pcm16Rms(square)).toBeCloseTo(0.5, 5);
    expect(pcm16Dbfs(square)).toBeCloseTo(-6.02, 1);
  });
});

describe('computeEnvelope', () => {
  it('returns min, max and rms per 20 ms window of the real samples', () => {
    const pcm = concatPcm([
      samples(new Array(320).fill(16384)), // 20 ms at +0.5
      samples(new Array(320).fill(-8192)), // 20 ms at -0.25
    ]);
    const windows = computeEnvelope(pcm, 16000, 20);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toEqual({ min: 0.5, max: 0.5, rms: 0.5 });
    expect(windows[1]).toEqual({ min: -0.25, max: -0.25, rms: 0.25 });
  });

  it('captures the peaks of a sine and an rms near amplitude / sqrt(2)', () => {
    const [window] = computeEnvelope(generateSinePcm16(100, 20, 0.5), 16000, 20);
    expect(window!.max).toBeGreaterThan(0.49);
    expect(window!.min).toBeLessThan(-0.49);
    expect(window!.rms).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it('digital silence is exactly flat and empty input gives no windows', () => {
    expect(computeEnvelope(silencePcm16(60), 16000, 20)).toEqual(new Array(3).fill({ min: 0, max: 0, rms: 0 }));
    expect(computeEnvelope(new Uint8Array(0), 16000, 20)).toEqual([]);
  });

  it('keeps a shorter final window', () => {
    expect(computeEnvelope(silencePcm16(50), 16000, 20)).toHaveLength(3);
  });

  it('works for other sample rates and rejects impossible windows', () => {
    expect(computeEnvelope(generateSinePcm16(200, 40, 0.3, 8000), 8000, 20)).toHaveLength(2);
    expect(() => computeEnvelope(silencePcm16(20), 16000, 0)).toThrow(RangeError);
  });

  it('is independent of what came before: a window depends only on its own samples', () => {
    const loud = generateSinePcm16(300, 20, 0.8);
    const quiet = silencePcm16(20);
    expect(computeEnvelope(concatPcm([quiet, loud]), 16000, 20)[1]).toEqual(computeEnvelope(loud, 16000, 20)[0]);
  });
});

describe('EnvelopeMeter', () => {
  it('streaming windows equal the one-shot envelope for any chunking, odd bytes included', () => {
    const input = concatPcm([generateSinePcm16(220, 90, 0.6), silencePcm16(50), generateSinePcm16(330, 70, 0.2)]);
    const expected = computeEnvelope(input, 16000, 20);

    const meter = new EnvelopeMeter(16000, 20);
    const got = [];
    for (let offset = 0, size = 13; offset < input.length; offset += size, size = size === 13 ? 997 : 13) {
      got.push(...meter.push(input.subarray(offset, offset + size)));
    }
    got.push(...meter.flush());
    expect(got).toEqual(expected);
    expect(meter.windowsEmitted).toBe(expected.length);
  });

  it('emits nothing for an incomplete window until it fills', () => {
    const meter = new EnvelopeMeter(16000, 20);
    expect(meter.push(silencePcm16(10))).toEqual([]);
    expect(meter.pendingSamples).toBe(160);
    expect(meter.push(silencePcm16(10))).toHaveLength(1);
    expect(meter.pendingSamples).toBe(0);
  });

  it('two meters do not influence each other', () => {
    const a = new EnvelopeMeter();
    const b = new EnvelopeMeter();
    a.push(generateSinePcm16(300, 40, 0.9));
    expect(b.push(silencePcm16(40)).every((window) => window.rms === 0 && window.max === 0)).toBe(true);
  });
});

describe('WAV', () => {
  it('wraps PCM and parses it back', () => {
    const pcm = generateSinePcm16(440, 50);
    const wav = pcm16ToWav(pcm);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
    expect(wav.byteLength).toBe(44 + pcm.byteLength);
    const parsed = parseWav(wav);
    expect(parsed).toMatchObject({ sampleRate: 16000, channels: 1, bitsPerSample: 16 });
    expect(parsed.pcm).toEqual(pcm);
  });

  it('refuses data that is not WAV', () => {
    expect(() => parseWav(new Uint8Array(64))).toThrow(/Not a WAV/);
  });
});

describe('mix and conversions', () => {
  it('mixes with clipping and zero-pads the shorter side', () => {
    const mixed = pcm16ToInt16(mixPcm16(samples([30000, 100]), samples([10000])));
    expect(Array.from(mixed)).toEqual([32767, 100]);
  });

  it('float32 <-> pcm16 round-trip', () => {
    const back = pcm16ToFloat32(float32ToPcm16(Float32Array.from([0, 0.5, -0.5, 1, -1])));
    expect(back[1]).toBeCloseTo(0.5, 3);
    expect(back[2]).toBeCloseTo(-0.5, 3);
    expect(back[3]).toBeGreaterThan(0.999);
    expect(back[4]).toBe(-1);
  });
});

describe('speech-like signal', () => {
  it('is deterministic and has the length announced for the text', () => {
    const a = synthesizeSpeechSignal('Hello, how can I help you?');
    const b = synthesizeSpeechSignal('Hello, how can I help you?');
    expect(a).toEqual(b);
    expect(pcmDurationMs(a)).toBeCloseTo(speechSignalDurationMs('Hello, how can I help you?'), 0);
  });

  it('longer text lasts longer and empty text is empty', () => {
    expect(speechSignalDurationMs('one two three four five six')).toBeGreaterThan(speechSignalDurationMs('one two'));
    expect(synthesizeSpeechSignal('   ...   ').byteLength).toBe(0);
  });

  it('has voiced stretches and digital silence between words', () => {
    const windows = computeEnvelope(synthesizeSpeechSignal('hola mundo'), 16000, 20);
    expect(windows.some((window) => window.rms > 0.05)).toBe(true);
    expect(windows.some((window) => window.rms === 0)).toBe(true);
  });

  it('different pitches give different signals', () => {
    expect(synthesizeSpeechSignal('hola', { pitchHz: 110 })).not.toEqual(synthesizeSpeechSignal('hola', { pitchHz: 220 }));
  });
});
