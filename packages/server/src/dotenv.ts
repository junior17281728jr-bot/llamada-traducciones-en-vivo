/**
 * Minimal `.env` loader with no dependencies.
 *
 * Format: one `KEY=value` per line, `#` comments, optional `export ` prefix, single or double quotes
 * (double quotes understand `\n`). Variables already present in the environment always win, so
 * `PORT=0 npm run dev:server` overrides the file. Values are never logged: the file may hold API keys.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Files/folders that mark the root of a project: the search for `.env` never goes above the first one found. */
const PROJECT_ROOT_MARKERS = ['.git', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Environment variable that points at an explicit file instead of searching for `.env`. */
export const ENV_FILE_VARIABLE = 'TW_ENV_FILE';

export function parseDotEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separator = withoutExport.indexOf('=');
    if (separator <= 0) continue;
    const key = withoutExport.slice(0, separator).trim();
    if (!KEY_PATTERN.test(key)) continue;
    let value = withoutExport.slice(separator + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n');
    } else {
      // Unquoted: an inline comment starts at " #".
      const comment = value.search(/\s#/);
      if (comment >= 0) value = value.slice(0, comment).trim();
    }
    values[key] = value;
  }
  return values;
}

/** Copies the parsed values into `env` without overwriting anything already set. Returns the names applied. */
export function applyDotEnv(values: Record<string, string>, env: Record<string, string | undefined> = process.env): string[] {
  const applied: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (env[key] !== undefined && env[key] !== '') continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

export interface LoadDotEnvOptions {
  /**
   * Explicit file; otherwise `TW_ENV_FILE`, then `.env` in `INIT_CWD` (where `npm run` was typed), `cwd` and its
   * parents up to the project root (the first folder with `.git` or a lock file): a `.env` of some OTHER project
   * further up (with its own API keys) is never loaded by accident.
   */
  path?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export interface LoadDotEnvResult {
  /** Absolute path of the file read, or null when none exists. */
  path: string | null;
  applied: string[];
}

function candidates(options: LoadDotEnvOptions, env: Record<string, string | undefined>): string[] {
  if (options.path) return [resolve(options.path)];
  const explicit = env[ENV_FILE_VARIABLE]?.trim();
  if (explicit) return [resolve(explicit)];
  const list: string[] = [];
  const initCwd = env['INIT_CWD']?.trim();
  if (initCwd) list.push(resolve(initCwd, '.env'));
  let dir = resolve(options.cwd ?? process.cwd());
  for (;;) {
    list.push(resolve(dir, '.env'));
    if (PROJECT_ROOT_MARKERS.some((marker) => existsSync(join(dir, marker)))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return list;
}

/** Finds and applies the first `.env` that exists. A missing file is not an error. */
export function loadDotEnv(options: LoadDotEnvOptions = {}): LoadDotEnvResult {
  const env = options.env ?? process.env;
  for (const candidate of candidates(options, env)) {
    if (!existsSync(candidate)) continue;
    const applied = applyDotEnv(parseDotEnv(readFileSync(candidate, 'utf8')), env);
    return { path: candidate, applied };
  }
  return { path: null, applied: [] };
}
