import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CallId, CallRecord, ListCallsQuery, TranscriptSegment, TranscriptStore } from '@tw/shared';
import { assertSafeId, readJsonFile, writePrivateFile } from '../files.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * Call history in plain files: `calls/<id>.json` (summary) and `calls/<id>.segments.jsonl` (one line
 * per saved segment; a later line with the same id replaces an earlier one). Enough for a few
 * thousand calls; move to a database before running at a larger scale.
 */
export class FileTranscriptStore implements TranscriptStore {
  private readonly dir: string;
  private cache: Map<CallId, CallRecord> | null = null;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'calls');
  }

  async saveCall(record: CallRecord): Promise<void> {
    assertSafeId(record.id);
    const cache = await this.records();
    await writePrivateFile(this.recordPath(record.id), JSON.stringify(record, null, 2));
    cache.set(record.id, record);
  }

  async getCall(id: CallId): Promise<CallRecord | null> {
    return (await this.records()).get(id) ?? null;
  }

  async listCalls(query: ListCallsQuery = {}): Promise<CallRecord[]> {
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)));
    return [...(await this.records()).values()]
      .filter((call) => (query.before === undefined || call.createdAt < query.before) &&
        (query.operatorId === undefined || call.operatorId === query.operatorId) &&
        (query.direction === undefined || call.direction === query.direction))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  async saveSegment(segment: TranscriptSegment): Promise<void> {
    assertSafeId(segment.callId);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await appendFile(this.segmentsPath(segment.callId), `${JSON.stringify(segment)}\n`, { mode: 0o600 });
  }

  async getSegments(callId: CallId): Promise<TranscriptSegment[]> {
    assertSafeId(callId);
    let raw: string;
    try {
      raw = await readFile(this.segmentsPath(callId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const byId = new Map<string, TranscriptSegment>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const segment = JSON.parse(line) as TranscriptSegment;
        byId.set(segment.id, segment);
      } catch {
        // A torn last line (crash while writing) is ignored.
      }
    }
    return [...byId.values()].sort((a, b) => a.startMs - b.startMs || a.createdAt - b.createdAt);
  }

  async deleteOlderThan(timestamp: number): Promise<number> {
    const cache = await this.records();
    let removed = 0;
    for (const [id, record] of [...cache]) {
      if (record.createdAt >= timestamp) continue;
      await rm(this.recordPath(id), { force: true });
      await rm(this.segmentsPath(id), { force: true });
      cache.delete(id);
      removed += 1;
    }
    return removed;
  }

  private recordPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private segmentsPath(id: string): string {
    return join(this.dir, `${id}.segments.jsonl`);
  }

  private async records(): Promise<Map<CallId, CallRecord>> {
    if (this.cache) return this.cache;
    const cache = new Map<CallId, CallRecord>();
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const record = await readJsonFile<CallRecord>(join(this.dir, name)).catch(() => null);
      if (record?.id) cache.set(record.id, record);
    }
    this.cache = cache;
    return cache;
  }
}
