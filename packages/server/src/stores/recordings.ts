import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  INTERNAL_BYTES_PER_SECOND,
  mixPcm16,
  pcm16ToWav,
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
}

/**
 * Original audio of each leg as raw PCM16 16 kHz files (`recordings/<id>/passenger.pcm` and
 * `operator.pcm`), served as WAV. The mixed leg sums both files from their start: legs are written
 * in order of arrival, so if one speaker's audio stops for a while the legs can drift apart.
 * Recording calls needs a legal basis and notice: see docs/ESTADO.md.
 */
export class FileRecordingStore implements RecordingStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'recordings');
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
    const createdAt = Date.now();
    let closed = false;

    return {
      write(speaker, pcm) {
        if (closed) return;
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
        };
        await writePrivateFile(join(folder, 'meta.json'), JSON.stringify(meta));
        return { callId, location: folder, ...meta };
      },
    };
  }

  async get(callId: CallId): Promise<RecordingInfo | null> {
    assertSafeId(callId);
    const folder = join(this.dir, callId);
    const meta = await readJsonFile<Meta>(join(folder, 'meta.json'));
    return meta ? { callId, location: folder, ...meta } : null;
  }

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
