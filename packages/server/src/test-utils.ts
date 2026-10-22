import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Fresh empty data directory for one test. The OS cleans the temp folder; tests never touch real data. */
export function tempDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tw-server-'));
}
