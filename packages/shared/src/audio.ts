/**
 * Audio helpers.
 *
 * Internal format everywhere: PCM16 mono little-endian at 16000 Hz. Anything that
 * enters or leaves a call channel or a provider is converted at that edge.
 *
 * This module is isomorphic (Node, Electron renderer, workers): it uses only
 * Uint8Array/DataView and never the Node-only `Buffer` type. A Node `Buffer` is a
 * `Uint8Array`, so it can be passed to any function here; results are plain
 * `Uint8Array`s (wrap with `Buffer.from(u.buffer, u.byteOffset, u.byteLength)` if
 * a `Buffer` is needed).
 */

export const INTERNAL_SAMPLE_RATE = 16_000;
export const INTERNAL_CHANNELS = 1;
export const BYTES_PER_SAMPLE = 2;
export const INTERNAL_BYTES_PER_SECOND = INTERNAL_SAMPLE_RATE * INTERNAL_CHANNELS * BYTES_PER_SAMPLE;

/** Raw PCM16 little-endian bytes (mono unless stated otherwise). */
export type PcmBytes = Uint8Array;

/** Digital silence floor returned by {@link pcm16Dbfs}. */
export const SILENCE_DBFS = -120;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function clampInt16(value: number): number {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value;
}

function assertRate(rate: number, name: string): void {
  if (!Number.isInteger(rate) || rate <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${rate}`);
  }
}

// ---------------------------------------------------------------------------
// Basic format utilities
// ---------------------------------------------------------------------------

/** Number of PCM16 samples in a buffer (a dangling odd byte is ignored). */
export function sampleCount(pcm: PcmBytes): number {
  return pcm.byteLength >> 1;
}

/** Bytes needed for `ms` milliseconds of mono PCM16 (rounded to whole samples). */
export function msToBytes(ms: number, sampleRate: number = INTERNAL_SAMPLE_RATE): number {
  return Math.round((ms * sampleRate) / 1000) * BYTES_PER_SAMPLE;
}

/** Duration in ms of `bytes` bytes of mono PCM16. */
export function bytesToMs(bytes: number, sampleRate: number = INTERNAL_SAMPLE_RATE): number {
  return (bytes / BYTES_PER_SAMPLE / sampleRate) * 1000;
}

/** Duration in ms of a mono PCM16 buffer. */
export function pcmDurationMs(pcm: PcmBytes, sampleRate: number = INTERNAL_SAMPLE_RATE): number {
  return bytesToMs(pcm.byteLength, sampleRate);
}

/** True when the buffer holds a whole number of PCM16 samples. */
export function isWholePcm16(pcm: PcmBytes): boolean {
  return (pcm.byteLength & 1) === 0;
}

/** `ms` milliseconds of digital silence. */
export function silencePcm16(ms: number, sampleRate: number = INTERNAL_SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  return new Uint8Array(msToBytes(ms, sampleRate));
}

/** Sine tone, handy for tests and simulators. `amplitude` is 0..1 of full scale. */
export function generateSinePcm16(
  frequencyHz: number,
  ms: number,
  amplitude = 0.3,
  sampleRate: number = INTERNAL_SAMPLE_RATE,
): Uint8Array<ArrayBuffer> {
  const samples = msToBytes(ms, sampleRate) / BYTES_PER_SAMPLE;
  const out = new Uint8Array(samples * BYTES_PER_SAMPLE);
  const dv = view(out);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate));
    dv.setInt16(i * 2, clampInt16(value), true);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Base64
// ---------------------------------------------------------------------------

interface NodeBufferStatic {
  from(data: ArrayBufferLike, byteOffset: number, length: number): { toString(encoding: 'base64'): string };
  from(data: string, encoding: 'base64'): Uint8Array;
}

interface GlobalCodecs {
  Buffer?: NodeBufferStatic;
  btoa?: (data: string) => string;
  atob?: (data: string) => string;
}

const codecs = globalThis as unknown as GlobalCodecs;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** PCM16 bytes to a base64 string. */
export function pcm16ToBase64(pcm: PcmBytes): string {
  if (codecs.Buffer) {
    return codecs.Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
  }
  if (!codecs.btoa) throw new Error('No base64 encoder available in this runtime');
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < pcm.length; i += step) {
    binary += String.fromCharCode(...pcm.subarray(i, i + step));
  }
  return codecs.btoa(binary);
}

/** Base64 string to PCM16 bytes (always a fresh, standalone Uint8Array). */
export function base64ToPcm16(base64: string): Uint8Array<ArrayBuffer> {
  const clean = base64.replace(/\s+/g, '');
  if (!BASE64_PATTERN.test(clean)) throw new Error('Invalid base64 audio payload');
  if (codecs.Buffer) return new Uint8Array(codecs.Buffer.from(clean, 'base64'));
  if (!codecs.atob) throw new Error('No base64 decoder available in this runtime');
  const binary = codecs.atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Sample-type conversions (alignment-safe: Node Buffers often have odd offsets)
// ---------------------------------------------------------------------------

/** PCM16 LE bytes to an Int16Array (copy). */
export function pcm16ToInt16(pcm: PcmBytes): Int16Array<ArrayBuffer> {
  const n = pcm.byteLength >> 1;
  const out = new Int16Array(n);
  const dv = view(pcm);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true);
  return out;
}

/** Int16Array to PCM16 LE bytes (copy). */
export function int16ToPcm16(samples: Int16Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(samples.length * 2);
  const dv = view(out);
  for (let i = 0; i < samples.length; i++) dv.setInt16(i * 2, samples[i]!, true);
  return out;
}

/** PCM16 to Float32 in [-1, 1) (what Web Audio expects). */
export function pcm16ToFloat32(pcm: PcmBytes): Float32Array<ArrayBuffer> {
  const n = pcm.byteLength >> 1;
  const out = new Float32Array(n);
  const dv = view(pcm);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true) / 32768;
  return out;
}

/** Float32 in [-1, 1] to PCM16 (values are clamped). */
export function float32ToPcm16(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(samples.length * 2);
  const dv = view(out);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    dv.setInt16(i * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resampling (linear interpolation)
// ---------------------------------------------------------------------------

/**
 * Streaming linear resampler for mono PCM16. It keeps state across `process`
 * calls, so chunks of any size (even odd byte counts) can be fed in order and
 * the concatenated output matches a one-shot conversion.
 *
 * Limitation: plain linear interpolation, no anti-aliasing low-pass filter.
 * Fine for speech going 8k -> 16k or 24k/44.1k/48k -> 16k; not hi-fi.
 */
export class Resampler {
  readonly fromRate: number;
  readonly toRate: number;
  private danglingByte: number | null = null;
  private carry: Int16Array = new Int16Array(0);
  private consumed = 0;
  private produced = 0;

  constructor(fromRate: number, toRate: number) {
    assertRate(fromRate, 'fromRate');
    assertRate(toRate, 'toRate');
    this.fromRate = fromRate;
    this.toRate = toRate;
  }

  /** Feed PCM16 bytes at `fromRate`; returns the PCM16 bytes available at `toRate`. */
  process(pcm: PcmBytes): Uint8Array<ArrayBuffer> {
    let bytes = pcm;
    if (this.danglingByte !== null) {
      const joined = new Uint8Array(pcm.byteLength + 1);
      joined[0] = this.danglingByte;
      joined.set(pcm, 1);
      bytes = joined;
      this.danglingByte = null;
    }
    if (bytes.byteLength & 1) {
      this.danglingByte = bytes[bytes.byteLength - 1]!;
      bytes = bytes.subarray(0, bytes.byteLength - 1);
    }
    const samples = pcm16ToInt16(bytes);
    if (this.fromRate === this.toRate) return int16ToPcm16(samples);

    const input = new Int16Array(this.carry.length + samples.length);
    input.set(this.carry, 0);
    input.set(samples, this.carry.length);
    const base = this.consumed;
    const { fromRate, toRate } = this;
    const out = new Int16Array(Math.ceil((input.length * toRate) / fromRate) + 2);
    let count = 0;
    let k = this.produced;
    for (;;) {
      const num = k * fromRate;
      const rem = num % toRate;
      const i = (num - rem) / toRate - base;
      if (i + 1 >= input.length) break;
      const a = input[i]!;
      const b = input[i + 1]!;
      out[count++] = Math.round(a + ((b - a) * rem) / toRate);
      k++;
    }
    this.produced = k;
    const nextNum = k * fromRate;
    const nextIndex = (nextNum - (nextNum % toRate)) / toRate;
    const keep = Math.min(Math.max(nextIndex - base, 0), input.length);
    this.carry = input.slice(keep);
    this.consumed = base + keep;
    return int16ToPcm16(out.subarray(0, count));
  }

  /**
   * Emits the final sample when an output position lands exactly on the last
   * input sample. Only needed to make a one-shot conversion exact; streaming
   * callers can ignore it.
   */
  flush(): Uint8Array<ArrayBuffer> {
    if (this.fromRate === this.toRate || this.carry.length === 0) return new Uint8Array(0);
    const num = this.produced * this.fromRate;
    const rem = num % this.toRate;
    const index = (num - rem) / this.toRate;
    const lastGlobal = this.consumed + this.carry.length - 1;
    if (rem !== 0 || index !== lastGlobal) return new Uint8Array(0);
    this.produced++;
    return int16ToPcm16(this.carry.subarray(this.carry.length - 1));
  }

  reset(): void {
    this.danglingByte = null;
    this.carry = new Int16Array(0);
    this.consumed = 0;
    this.produced = 0;
  }
}

/** One-shot linear resample of a complete PCM16 mono buffer. */
export function resamplePcm16(pcm: PcmBytes, fromRate: number, toRate: number): Uint8Array<ArrayBuffer> {
  const resampler = new Resampler(fromRate, toRate);
  return concatPcm([resampler.process(pcm), resampler.flush()]);
}

// ---------------------------------------------------------------------------
// G.711 (mu-law and A-law), ITU-T reference algorithm
// ---------------------------------------------------------------------------

const ULAW_BIAS = 0x84;
const ULAW_CLIP = 8159;
const SEG_UEND = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff] as const;
const SEG_AEND = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff] as const;

function segmentSearch(value: number, ends: readonly number[]): number {
  for (let i = 0; i < ends.length; i++) if (value <= ends[i]!) return i;
  return ends.length;
}

function ulawDecodeSample(code: number): number {
  const u = ~code & 0xff;
  let t = ((u & 0x0f) << 3) + ULAW_BIAS;
  t <<= (u & 0x70) >> 4;
  return u & 0x80 ? ULAW_BIAS - t : t - ULAW_BIAS;
}

function ulawEncodeSample(sample: number): number {
  let pcm = sample >> 2;
  let mask: number;
  if (pcm < 0) {
    pcm = -pcm;
    mask = 0x7f;
  } else {
    mask = 0xff;
  }
  if (pcm > ULAW_CLIP) pcm = ULAW_CLIP;
  pcm += ULAW_BIAS >> 2;
  const seg = segmentSearch(pcm, SEG_UEND);
  if (seg >= 8) return 0x7f ^ mask;
  return (((seg << 4) | ((pcm >> (seg + 1)) & 0x0f)) ^ mask) & 0xff;
}

function alawDecodeSample(code: number): number {
  const a = (code ^ 0x55) & 0xff;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) {
    t += 8;
  } else {
    t += 0x108;
    if (seg > 1) t <<= seg - 1;
  }
  return a & 0x80 ? t : -t;
}

function alawEncodeSample(sample: number): number {
  let pcm = sample >> 3;
  let mask: number;
  if (pcm >= 0) {
    mask = 0xd5;
  } else {
    mask = 0x55;
    pcm = -pcm - 1;
  }
  const seg = segmentSearch(pcm, SEG_AEND);
  if (seg >= 8) return 0x7f ^ mask;
  let value = seg << 4;
  value |= seg < 2 ? (pcm >> 1) & 0x0f : (pcm >> seg) & 0x0f;
  return (value ^ mask) & 0xff;
}

function buildDecodeTable(decode: (code: number) => number): Int16Array {
  const table = new Int16Array(256);
  for (let code = 0; code < 256; code++) table[code] = decode(code);
  return table;
}

let ulawTable: Int16Array | undefined;
let alawTable: Int16Array | undefined;

function decodeWithTable(data: Uint8Array, table: Int16Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(data.length * 2);
  const dv = view(out);
  for (let i = 0; i < data.length; i++) dv.setInt16(i * 2, table[data[i]!]!, true);
  return out;
}

/** G.711 mu-law bytes (8 kHz telephony) to PCM16 at the same sample rate. */
export function mulawToPcm16(data: Uint8Array): Uint8Array<ArrayBuffer> {
  ulawTable ??= buildDecodeTable(ulawDecodeSample);
  return decodeWithTable(data, ulawTable);
}

/** G.711 A-law bytes to PCM16 at the same sample rate. */
export function alawToPcm16(data: Uint8Array): Uint8Array<ArrayBuffer> {
  alawTable ??= buildDecodeTable(alawDecodeSample);
  return decodeWithTable(data, alawTable);
}

/** PCM16 to G.711 mu-law bytes (same sample rate). */
export function pcm16ToMulaw(pcm: PcmBytes): Uint8Array<ArrayBuffer> {
  const n = pcm.byteLength >> 1;
  const out = new Uint8Array(n);
  const dv = view(pcm);
  for (let i = 0; i < n; i++) out[i] = ulawEncodeSample(dv.getInt16(i * 2, true));
  return out;
}

/** PCM16 to G.711 A-law bytes (same sample rate). */
export function pcm16ToAlaw(pcm: PcmBytes): Uint8Array<ArrayBuffer> {
  const n = pcm.byteLength >> 1;
  const out = new Uint8Array(n);
  const dv = view(pcm);
  for (let i = 0; i < n; i++) out[i] = alawEncodeSample(dv.getInt16(i * 2, true));
  return out;
}

// ---------------------------------------------------------------------------
// Wire formats (provider / channel edge <-> internal format)
// ---------------------------------------------------------------------------

export type WireCodec = 'pcm' | 'ulaw' | 'alaw';

/** Formats the edge converters understand, named like the ElevenLabs `output_format` values. */
export type WireAudioFormat =
  | 'pcm_8000'
  | 'pcm_16000'
  | 'pcm_22050'
  | 'pcm_24000'
  | 'pcm_44100'
  | 'pcm_48000'
  | 'ulaw_8000'
  | 'alaw_8000';

export interface ParsedAudioFormat {
  codec: WireCodec;
  sampleRate: number;
}

const PCM_RATES: readonly number[] = [8000, 16000, 22050, 24000, 44100, 48000];

/** Parses names such as `pcm_24000` or `ulaw_8000`. Throws for anything else (e.g. mp3). */
export function parseAudioFormat(format: string): ParsedAudioFormat {
  const match = /^(pcm|ulaw|alaw)_(\d+)$/.exec(format);
  if (match) {
    const codec = match[1] as WireCodec;
    const sampleRate = Number(match[2]);
    if (codec === 'pcm' ? PCM_RATES.includes(sampleRate) : sampleRate === 8000) {
      return { codec, sampleRate };
    }
  }
  throw new Error(`Unsupported audio format: ${format}`);
}

/**
 * Stateful converter from a wire format to the internal format (PCM16 mono 16 kHz).
 * Keep one instance per audio stream: it carries resampler and odd-byte state.
 */
export class WireToInternal {
  readonly format: ParsedAudioFormat;
  private readonly resampler: Resampler;

  constructor(format: string) {
    this.format = parseAudioFormat(format);
    this.resampler = new Resampler(this.format.sampleRate, INTERNAL_SAMPLE_RATE);
  }

  push(chunk: Uint8Array): Uint8Array<ArrayBuffer> {
    switch (this.format.codec) {
      case 'ulaw':
        return this.resampler.process(mulawToPcm16(chunk));
      case 'alaw':
        return this.resampler.process(alawToPcm16(chunk));
      case 'pcm':
        return this.resampler.process(chunk);
    }
  }

  reset(): void {
    this.resampler.reset();
  }
}

/**
 * Stateful converter from the internal format to a wire format (e.g. mu-law 8 kHz
 * for a telephone channel). Keep one instance per audio stream.
 */
export class InternalToWire {
  readonly format: ParsedAudioFormat;
  private readonly resampler: Resampler;

  constructor(format: string) {
    this.format = parseAudioFormat(format);
    this.resampler = new Resampler(INTERNAL_SAMPLE_RATE, this.format.sampleRate);
  }

  push(pcm: PcmBytes): Uint8Array<ArrayBuffer> {
    const resampled = this.resampler.process(pcm);
    switch (this.format.codec) {
      case 'ulaw':
        return pcm16ToMulaw(resampled);
      case 'alaw':
        return pcm16ToAlaw(resampled);
      case 'pcm':
        return resampled;
    }
  }

  reset(): void {
    this.resampler.reset();
  }
}

// ---------------------------------------------------------------------------
// Concatenation, framing, mixing
// ---------------------------------------------------------------------------

/** Concatenates byte chunks into one fresh buffer. */
export function concatPcm(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function frameBytes(frameMs: number, sampleRate: number): number {
  const bytes = msToBytes(frameMs, sampleRate);
  if (bytes <= 0) throw new RangeError(`Frame of ${frameMs} ms is too short at ${sampleRate} Hz`);
  return bytes;
}

/**
 * Splits a buffer into frames of `frameMs`. Frames are views into `pcm` (no copy);
 * the incomplete tail, if any, is returned as `remainder`.
 */
export function splitFrames(
  pcm: PcmBytes,
  frameMs: number,
  sampleRate: number = INTERNAL_SAMPLE_RATE,
): { frames: Uint8Array[]; remainder: Uint8Array } {
  const size = frameBytes(frameMs, sampleRate);
  const frames: Uint8Array[] = [];
  let offset = 0;
  for (; offset + size <= pcm.byteLength; offset += size) frames.push(pcm.subarray(offset, offset + size));
  return { frames, remainder: pcm.subarray(offset) };
}

/** Accumulates arbitrary chunks and emits fixed-size frames (copies, safe to keep). */
export class FrameChunker {
  private readonly size: number;
  private pending: Uint8Array = new Uint8Array(0);

  constructor(frameMs: number, sampleRate: number = INTERNAL_SAMPLE_RATE) {
    this.size = frameBytes(frameMs, sampleRate);
  }

  get bufferedBytes(): number {
    return this.pending.byteLength;
  }

  push(pcm: PcmBytes): Uint8Array[] {
    const data = this.pending.byteLength ? concatPcm([this.pending, pcm]) : pcm;
    const frames: Uint8Array[] = [];
    let offset = 0;
    for (; offset + this.size <= data.byteLength; offset += this.size) {
      frames.push(data.slice(offset, offset + this.size));
    }
    this.pending = data.slice(offset);
    return frames;
  }

  /** Returns the buffered tail (zero-padded to a full frame when `padToFrame`), or null if empty. */
  flush(padToFrame = false): Uint8Array | null {
    if (this.pending.byteLength === 0) return null;
    let tail: Uint8Array = this.pending;
    if (padToFrame && tail.byteLength < this.size) {
      const padded = new Uint8Array(this.size);
      padded.set(tail, 0);
      tail = padded;
    }
    this.pending = new Uint8Array(0);
    return tail;
  }
}

/** Sample-wise sum of two mono buffers with clipping; the shorter one is zero-padded. */
export function mixPcm16(a: PcmBytes, b: PcmBytes): Uint8Array<ArrayBuffer> {
  const n = Math.max(a.byteLength, b.byteLength) >> 1;
  const out = new Uint8Array(n * 2);
  const dvA = view(a);
  const dvB = view(b);
  const dvOut = view(out);
  const nA = a.byteLength >> 1;
  const nB = b.byteLength >> 1;
  for (let i = 0; i < n; i++) {
    const sa = i < nA ? dvA.getInt16(i * 2, true) : 0;
    const sb = i < nB ? dvB.getInt16(i * 2, true) : 0;
    dvOut.setInt16(i * 2, clampInt16(sa + sb), true);
  }
  return out;
}

/** Interleaves two mono buffers into one stereo buffer (L R L R ...); shorter side is zero-padded. */
export function interleaveStereo(left: PcmBytes, right: PcmBytes): Uint8Array<ArrayBuffer> {
  const n = Math.max(left.byteLength, right.byteLength) >> 1;
  const out = new Uint8Array(n * 4);
  const dvL = view(left);
  const dvR = view(right);
  const dvOut = view(out);
  const nL = left.byteLength >> 1;
  const nR = right.byteLength >> 1;
  for (let i = 0; i < n; i++) {
    dvOut.setInt16(i * 4, i < nL ? dvL.getInt16(i * 2, true) : 0, true);
    dvOut.setInt16(i * 4 + 2, i < nR ? dvR.getInt16(i * 2, true) : 0, true);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Level metering
// ---------------------------------------------------------------------------

/** Root-mean-square level of a mono PCM16 buffer, normalised to 0..1 (0 for empty input). */
export function pcm16Rms(pcm: PcmBytes): number {
  const n = pcm.byteLength >> 1;
  if (n === 0) return 0;
  const dv = view(pcm);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = dv.getInt16(i * 2, true) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/** Level in dB relative to full scale; never below {@link SILENCE_DBFS}. */
export function pcm16Dbfs(pcm: PcmBytes): number {
  const rms = pcm16Rms(pcm);
  if (rms <= 0) return SILENCE_DBFS;
  return Math.max(SILENCE_DBFS, 20 * Math.log10(rms));
}

// ---------------------------------------------------------------------------
// Waveform envelope (what the call screen draws)
// ---------------------------------------------------------------------------

/**
 * Summary of one short window of REAL samples, normalised to full scale:
 * `min`/`max` in [-1, 1] and `rms` in [0, 1]. Digital silence is exactly `{0, 0, 0}`.
 */
export interface EnvelopeWindow {
  min: number;
  max: number;
  rms: number;
}

function windowSamples(windowMs: number, sampleRate: number): number {
  assertRate(sampleRate, 'sampleRate');
  const samples = Math.round((windowMs * sampleRate) / 1000);
  if (!(samples >= 1)) throw new RangeError(`Window of ${windowMs} ms is too short at ${sampleRate} Hz`);
  return samples;
}

/**
 * Min/max/RMS per window of `windowMs`, computed over the samples of `pcm` (mono PCM16 LE).
 * The last window may be shorter than the others. Empty input gives an empty array.
 */
export function computeEnvelope(
  pcm: PcmBytes,
  sampleRate: number = INTERNAL_SAMPLE_RATE,
  windowMs = 20,
): EnvelopeWindow[] {
  const size = windowSamples(windowMs, sampleRate);
  const total = pcm.byteLength >> 1;
  const dv = view(pcm);
  const windows: EnvelopeWindow[] = [];
  for (let start = 0; start < total; start += size) {
    const end = Math.min(start + size, total);
    let min = 32767;
    let max = -32768;
    let sumSquares = 0;
    for (let i = start; i < end; i++) {
      const sample = dv.getInt16(i * 2, true);
      if (sample < min) min = sample;
      if (sample > max) max = sample;
      sumSquares += sample * sample;
    }
    windows.push({ min: min / 32768, max: max / 32768, rms: Math.sqrt(sumSquares / (end - start)) / 32768 });
  }
  return windows;
}

/**
 * Streaming version of {@link computeEnvelope}: feed chunks of any size (odd byte counts
 * included) and get back only the COMPLETE windows. The concatenation of everything returned,
 * plus `flush()`, equals the one-shot result. One meter per audio stream.
 */
export class EnvelopeMeter {
  readonly sampleRate: number;
  readonly windowMs: number;
  private readonly size: number;
  private danglingByte: number | null = null;
  private count = 0;
  private min = 32767;
  private max = -32768;
  private sumSquares = 0;
  private emitted = 0;

  constructor(sampleRate: number = INTERNAL_SAMPLE_RATE, windowMs = 20) {
    this.size = windowSamples(windowMs, sampleRate);
    this.sampleRate = sampleRate;
    this.windowMs = windowMs;
  }

  /** Complete windows emitted so far (also the index of the next one). */
  get windowsEmitted(): number {
    return this.emitted;
  }

  /** Samples waiting for the current window to fill. */
  get pendingSamples(): number {
    return this.count;
  }

  push(pcm: PcmBytes): EnvelopeWindow[] {
    let bytes = pcm;
    if (this.danglingByte !== null) {
      const joined = new Uint8Array(pcm.byteLength + 1);
      joined[0] = this.danglingByte;
      joined.set(pcm, 1);
      bytes = joined;
      this.danglingByte = null;
    }
    if (bytes.byteLength & 1) {
      this.danglingByte = bytes[bytes.byteLength - 1]!;
      bytes = bytes.subarray(0, bytes.byteLength - 1);
    }
    const dv = view(bytes);
    const out: EnvelopeWindow[] = [];
    for (let i = 0; i < bytes.byteLength >> 1; i++) {
      const sample = dv.getInt16(i * 2, true);
      if (sample < this.min) this.min = sample;
      if (sample > this.max) this.max = sample;
      this.sumSquares += sample * sample;
      if (++this.count === this.size) out.push(this.closeWindow());
    }
    return out;
  }

  /** Emits the partially filled window, if any, and resets it. */
  flush(): EnvelopeWindow[] {
    return this.count > 0 ? [this.closeWindow()] : [];
  }

  reset(): void {
    this.danglingByte = null;
    this.count = 0;
    this.min = 32767;
    this.max = -32768;
    this.sumSquares = 0;
    this.emitted = 0;
  }

  private closeWindow(): EnvelopeWindow {
    const window: EnvelopeWindow = {
      min: this.min / 32768,
      max: this.max / 32768,
      rms: Math.sqrt(this.sumSquares / this.count) / 32768,
    };
    this.count = 0;
    this.min = 32767;
    this.max = -32768;
    this.sumSquares = 0;
    this.emitted++;
    return window;
  }
}

// ---------------------------------------------------------------------------
// Speech-like test signal (simulator and mock providers)
// ---------------------------------------------------------------------------

export interface SpeechSignalOptions {
  sampleRate?: number;
  /** Fundamental frequency; use different values to tell two simulated voices apart. */
  pitchHz?: number;
  /** Duration of one voiced character. */
  msPerChar?: number;
  /** 0..1 of full scale. */
  amplitude?: number;
}

const SPEECH_DEFAULTS = { sampleRate: INTERNAL_SAMPLE_RATE, pitchHz: 140, msPerChar: 65, amplitude: 0.35 } as const;
const WORD_GAP_MS = 70;
const PUNCTUATION_PAUSE_MS = 180;
const SYLLABLE_RATE_HZ = 4.5;
const EDGE_RAMP_MS = 12;

/** Voiced stretches (word) and silent stretches (gap) of the signal for `text`, in ms. */
function speechPlan(text: string, msPerChar: number): { voicedMs: number; silentMs: number }[] {
  const plan: { voicedMs: number; silentMs: number }[] = [];
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  for (const word of words) {
    const letters = word.replace(/[^\p{L}\p{N}]/gu, '').length;
    const punctuated = /[.,;:!?¿¡]/.test(word);
    if (letters === 0) continue;
    plan.push({
      voicedMs: Math.max(60, letters * msPerChar),
      silentMs: WORD_GAP_MS + (punctuated ? PUNCTUATION_PAUSE_MS : 0),
    });
  }
  return plan;
}

/** Duration in ms of {@link synthesizeSpeechSignal} for `text` (zero when there is nothing to say). */
export function speechSignalDurationMs(text: string, options: SpeechSignalOptions = {}): number {
  const msPerChar = options.msPerChar ?? SPEECH_DEFAULTS.msPerChar;
  return speechPlan(text, msPerChar).reduce((total, item) => total + item.voicedMs + item.silentMs, 0);
}

/**
 * Deterministic speech-LIKE signal for tests and the simulator: voiced words (a harmonic
 * stack at `pitchHz`, amplitude-modulated at syllable rate) separated by digital silence, with a
 * duration that follows the text length. It is NOT speech: no STT can recognise it, which is
 * why simulated providers carry the text out of band. Same input always gives the same bytes.
 */
export function synthesizeSpeechSignal(text: string, options: SpeechSignalOptions = {}): Uint8Array<ArrayBuffer> {
  const sampleRate = options.sampleRate ?? SPEECH_DEFAULTS.sampleRate;
  const pitchHz = options.pitchHz ?? SPEECH_DEFAULTS.pitchHz;
  const msPerChar = options.msPerChar ?? SPEECH_DEFAULTS.msPerChar;
  const amplitude = Math.min(1, Math.max(0, options.amplitude ?? SPEECH_DEFAULTS.amplitude));
  assertRate(sampleRate, 'sampleRate');

  const plan = speechPlan(text, msPerChar);
  const harmonics = [1, 2, 3, 4] as const;
  const harmonicGain = [1, 0.5, 0.33, 0.2] as const;
  const gainSum = harmonicGain.reduce((a, b) => a + b, 0);
  const rampSamples = Math.max(1, Math.round((EDGE_RAMP_MS * sampleRate) / 1000));

  const parts: Uint8Array[] = [];
  let wordIndex = 0;
  for (const item of plan) {
    const voicedSamples = Math.round((item.voicedMs * sampleRate) / 1000);
    const word = new Uint8Array(voicedSamples * 2);
    const dv = view(word);
    // Each word gets its own slight pitch offset so consecutive words are not identical.
    const wordPitch = pitchHz * (1 + 0.04 * Math.sin(wordIndex * 1.7));
    for (let i = 0; i < voicedSamples; i++) {
      const t = i / sampleRate;
      let carrier = 0;
      for (let h = 0; h < harmonics.length; h++) {
        carrier += harmonicGain[h]! * Math.sin(2 * Math.PI * wordPitch * harmonics[h]! * t);
      }
      carrier /= gainSum;
      const syllable = 0.6 + 0.4 * Math.sin(2 * Math.PI * SYLLABLE_RATE_HZ * t + wordIndex);
      const ramp = Math.min(1, i / rampSamples, (voicedSamples - 1 - i) / rampSamples);
      dv.setInt16(i * 2, clampInt16(Math.round(amplitude * 32767 * carrier * syllable * ramp)), true);
    }
    parts.push(word, new Uint8Array(Math.round((item.silentMs * sampleRate) / 1000) * 2));
    wordIndex++;
  }
  return concatPcm(parts);
}

// ---------------------------------------------------------------------------
// WAV container
// ---------------------------------------------------------------------------

const WAV_HEADER_BYTES = 44;

function writeAscii(dv: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) dv.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * 44-byte canonical WAV header for `dataBytes` bytes of PCM. A streaming recorder can
 * write it with a placeholder length and patch it again when the call ends.
 */
export function wavHeader(
  dataBytes: number,
  sampleRate: number = INTERNAL_SAMPLE_RATE,
  channels: number = INTERNAL_CHANNELS,
  bitsPerSample = 16,
): Uint8Array<ArrayBuffer> {
  assertRate(sampleRate, 'sampleRate');
  if (dataBytes < 0 || dataBytes > 0xffffffff - 36) throw new RangeError('WAV data length out of range');
  const blockAlign = (channels * bitsPerSample) / 8;
  const out = new Uint8Array(WAV_HEADER_BYTES);
  const dv = view(out);
  writeAscii(dv, 0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  writeAscii(dv, 8, 'WAVE');
  writeAscii(dv, 12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitsPerSample, true);
  writeAscii(dv, 36, 'data');
  dv.setUint32(40, dataBytes, true);
  return out;
}

/** Wraps PCM16 bytes into a WAV file. For stereo, pass interleaved data and `channels = 2`. */
export function pcm16ToWav(
  pcm: PcmBytes,
  sampleRate: number = INTERNAL_SAMPLE_RATE,
  channels: number = INTERNAL_CHANNELS,
): Uint8Array<ArrayBuffer> {
  return concatPcm([wavHeader(pcm.byteLength, sampleRate, channels), pcm]);
}

export interface ParsedWav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** PCM payload (a view into the input). */
  pcm: Uint8Array;
}

/** Minimal WAV reader: integer PCM only. Tolerates streaming headers whose length is wrong. */
export function parseWav(wav: Uint8Array): ParsedWav {
  const dv = view(wav);
  const tag = (offset: number): string =>
    String.fromCharCode(dv.getUint8(offset), dv.getUint8(offset + 1), dv.getUint8(offset + 2), dv.getUint8(offset + 3));
  if (wav.byteLength < WAV_HEADER_BYTES || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }
  let format: { sampleRate: number; channels: number; bitsPerSample: number } | undefined;
  let offset = 12;
  while (offset + 8 <= wav.byteLength) {
    const id = tag(offset);
    const declared = dv.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (dv.getUint16(body, true) !== 1) throw new Error('Only integer PCM WAV is supported');
      format = {
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bitsPerSample: dv.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!format) throw new Error('WAV data chunk before fmt chunk');
      const length = Math.min(declared, wav.byteLength - body);
      return { ...format, pcm: wav.subarray(body, body + length) };
    }
    offset = body + declared + (declared & 1);
  }
  throw new Error('WAV has no data chunk');
}
