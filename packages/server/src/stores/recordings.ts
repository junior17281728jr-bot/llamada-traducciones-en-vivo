import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  INTERNAL_BYTES_PER_SECOND,
  mixPcm16,
  pcm16ToWav,
  wavHeader,
  type CallId,
  type RecordingInfo,
  type RecordingLeg,
  type RecordingStore,
  type RecordingWriter,
  type Speaker,
} from '@tw/shared';
import { assertSafeId, readJsonFile, writePrivateFile } from '../files.js';

interface Meta {
  durationMs: number;
  bytes: number;
  createdAt: number;
  /** Bytes thrown away because the disk could not keep up (see `maxPendingBytes`). Absent when none. */
  droppedBytes?: number;
}

/** A recording leg as a WAV byte source that can be read piecewise (HTTP ranges) without loading it whole. */
export interface LegStream {
  byteLength: number;
  /** Bytes `start`..`end` (inclusive) of the WAV file. */
  stream(start: number, end: number): Readable;
}

const WAV_HEADER_BYTES = 44;
/** Piece size when streaming or mixing legs from disk. */
const CHUNK_BYTES = 64 * 1024;

export interface FileRecordingStoreOptions {
  /**
   * Audio waiting to be written per leg before new audio is dropped instead of queued in memory (a stalled
   * disk, or audio arriving faster than real time). Default 8 MB (~4 minutes of audio).
   */
  maxPendingBytes?: number;
}

/**
 * Original audio of each leg as raw PCM16 16 kHz files (`recordings/<id>/passenger.pcm` and
 * `operator.pcm`), served as WAV. The mixed leg sums both files from their start: legs are written
 * in order of arrival, so if one speaker's audio stops for a while the legs can drift apart.
 * Recording calls needs a legal basis and notice: see docs/ESTADO.md.
 */
export class FileRecordingStore implements RecordingStore {
  private readonly dir: string;
  private readonly maxPendingBytes: number;

  constructor(dataDir: string, options: FileRecordingStoreOptions = {}) {
    this.dir = join(dataDir, 'recordings');
    this.maxPendingBytes = options.maxPendingBytes ?? 8 * 1024 * 1024;
  }

  async open(callId: CallId): Promise<RecordingWriter> {
    assertSafeId(callId);
    const folder = join(this.dir, callId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const streams: Record<Speaker, WriteStream> = {
      passenger: createWriteStream(join(folder, 'passenger.pcm'), { flags: 'a', mode: 0o600 }),
      operator: createWriteStream(join(folder, 'operator.pcm'), { flags: 'a', mode: 0o600 }),
    };
    const bytes: Record<Speaker, number> = { passenger: 0, operator: 0 };
    let dropped = 0;
    const createdAt = Date.now();
    let closed = false;
    const maxPending = this.maxPendingBytes;

    return {
      write(speaker, pcm) {
        if (closed) return;
        // Back-pressure: never let a slow disk (or a flood of frames) pile audio up in memory without limit.
        if (streams[speaker].writableLength > maxPending) {
          dropped += pcm.byteLength;
          return;
        }
        bytes[speaker] += pcm.byteLength;
        streams[speaker].write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      },
      async close() {
        closed = true;
        await Promise.all(
          Object.values(streams).map((stream) => new Promise<void>((resolve) => stream.end(resolve))),
        );
        const meta: Meta = {
          durationMs: Math.round((Math.max(bytes.passenger, bytes.operator) / INTERNAL_BYTES_PER_SECOND) * 1000),
          bytes: bytes.passenger + bytes.operator,
          createdAt,
          ...(dropped > 0 ? { droppedBytes: dropped } : {}),
        };
        await writePrivateFile(join(folder, 'meta.json'), JSON.stringify(meta));
        return { callId, location: folder, durationMs: meta.durationMs, bytes: meta.bytes, createdAt };
      },
    };
  }

  async get(callId: CallId): Promise<RecordingInfo | null> {
    assertSafeId(callId);
    const folder = join(this.dir, callId);
    const meta = await readJsonFile<Meta>(join(folder, 'meta.json'));
    return meta ? { callId, location: folder, durationMs: meta.durationMs, bytes: meta.bytes, createdAt: meta.createdAt } : null;
  }

  /** Whole WAV in memory (small legs, tests). The API serves legs with `openLeg` instead. */
  async read(callId: CallId, leg: RecordingLeg): Promise<Uint8Array | null> {
    assertSafeId(callId);
    const folder = join(this.dir, callId);
    const load = async (name: string): Promise<Uint8Array | null> => {
      try {
        return new Uint8Array(await readFile(join(folder, name)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    };
    if (leg === 'mixed') {
      const [passenger, operator] = await Promise.all([load('passenger.pcm'), load('operator.pcm')]);
      if (!passenger && !operator) return null;
      return pcm16ToWav(mixPcm16(passenger ?? new Uint8Array(0), operator ?? new Uint8Array(0)));
    }
    const pcm = await load(`${leg}.pcm`);
    return pcm ? pcm16ToWav(pcm) : null;
  }

  /**
   * The leg as a WAV byte source read from disk piece by piece: the 44-byte header is built from the file
   * sizes and the samples come straight from the `.pcm` files (`mixed` sums both files chunk by chunk).
   */
  async openLeg(callId: CallId, leg: RecordingLeg): Promise<LegStream | null> {
    assertSafeId(callId);
    const folder = join(this.dir, callId);
    const sizeOf = async (name: string): Promise<number | null> => {
      try {
        return (await stat(join(folder, name))).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    };
    const paths = leg === 'mixed' ? ['passenger.pcm', 'operator.pcm'] : [`${leg}.pcm`];
    const sizes = await Promise.all(paths.map(sizeOf));
    if (sizes.every((size) => size === null)) return null;
    // Whole samples only: mixing works on 16-bit pairs and an odd trailing byte would corrupt the WAV.
    const dataBytes = Math.max(...sizes.map((size) => size ?? 0)) & ~1;
    const header = wavHeader(dataBytes);
    const byteLength = header.byteLength + dataBytes;
    const sources = paths.filter((_, index) => sizes[index] !== null).map((name) => join(folder, name));
    return {
      byteLength,
      stream: (start, end) => wavSlice(header, dataBytes, sources, start, end),
    };
  }

  async deleteOlderThan(timestamp: number): Promise<number> {
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    let removed = 0;
    for (const name of names) {
      const meta = await readJsonFile<Meta>(join(this.dir, name, 'meta.json')).catch(() => null);
      if (!meta || meta.createdAt >= timestamp) continue;
      await rm(join(this.dir, name), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }
}

/** Bytes `start`..`end` of "header + samples", where the samples are the (mixed) contents of `sources`. */
function wavSlice(header: Uint8Array, dataBytes: number, sources: string[], start: number, end: number): Readable {
  const last = Math.min(end, header.byteLength + dataBytes - 1);
  async function* pieces(): AsyncGenerator<Buffer> {
    if (start <= last && start < header.byteLength) {
      yield Buffer.from(header.subarray(start, Math.min(last + 1, header.byteLength)));
    }
    const dataStart = Math.max(0, start - header.byteLength);
    const dataEnd = last - header.byteLength;
    if (dataEnd < dataStart) return;
    if (sources.length === 1) {
      yield* createReadStream(sources[0]!, { start: dataStart, end: dataEnd, highWaterMark: CHUNK_BYTES }) as AsyncIterable<Buffer>;
      return;
    }
    // Mixed: read both legs in lockstep (a missing tail of one leg counts as silence) and sum each piece.
    // The work is done on a sample-aligned range (even start, odd end) and trimmed to the bytes asked for,
    // so no 16-bit value is ever split and the promised length is always delivered.
    const evenStart = dataStart & ~1;
    const evenEnd = dataEnd | 1;
    let offset = evenStart;
    const readers = sources.map((path) => createReadStream(path, { start: evenStart, end: evenEnd, highWaterMark: CHUNK_BYTES })[Symbol.asyncIterator]());
    const pending: Buffer[] = sources.map(() => Buffer.alloc(0));
    const done: boolean[] = sources.map(() => false);
    try {
      while (offset <= evenEnd) {
        const want = Math.min(CHUNK_BYTES, evenEnd - offset + 1);
        for (let i = 0; i < readers.length; i++) {
          while (!done[i] && pending[i]!.byteLength < want) {
            const next = await readers[i]!.next();
            if (next.done) done[i] = true;
            else pending[i] = Buffer.concat([pending[i]!, next.value as Buffer]);
          }
        }
        const parts = pending.map((buffer) => buffer.subarray(0, Math.min(want, buffer.byteLength)));
        for (let i = 0; i < pending.length; i++) pending[i] = pending[i]!.subarray(parts[i]!.byteLength);
        let mixed = Buffer.from(mixPcm16(parts[0]!, parts[1] ?? new Uint8Array(0)));
        // A file shorter than its size said (changed underneath): silence keeps the length promised in the headers.
        if (mixed.byteLength < want) mixed = Buffer.concat([mixed, Buffer.alloc(want - mixed.byteLength)]);
        const from = offset < dataStart ? dataStart - offset : 0;
        const to = want - (offset + want - 1 > dataEnd ? offset + want - 1 - dataEnd : 0);
        yield mixed.subarray(from, to);
        offset += want;
      }
    } finally {
      for (const reader of readers) await reader.return?.();
    }
  }
  return Readable.from(pieces());
}
