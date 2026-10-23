import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDotEnv, loadDotEnv, parseDotEnv } from './dotenv.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tw-dotenv-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseDotEnv', () => {
  it('reads keys, ignores comments and blanks, strips quotes and inline comments', () => {
    const parsed = parseDotEnv([
      '# comentario',
      '',
      'PORT=8787',
      'export HOST = 127.0.0.1',
      'NAME="con espacios\\ny salto"',
      "SINGLE='a # no es comentario'",
      'INLINE=valor # comentario',
      'URL=http://x/#ancla',
      'EMPTY=',
      '=sin clave',
      'mal formado',
      '1BAD=x',
    ].join('\n'));
    expect(parsed).toEqual({
      PORT: '8787',
      HOST: '127.0.0.1',
      NAME: 'con espacios\ny salto',
      SINGLE: 'a # no es comentario',
      INLINE: 'valor',
      URL: 'http://x/#ancla',
      EMPTY: '',
    });
  });
});

describe('applyDotEnv', () => {
  it('never overwrites a variable that is already set', () => {
    const env: Record<string, string | undefined> = { PORT: '0', BLANK: '' };
    const applied = applyDotEnv({ PORT: '8787', BLANK: 'x', NEW: 'y' }, env);
    expect(env).toEqual({ PORT: '0', BLANK: 'x', NEW: 'y' });
    expect(applied.sort()).toEqual(['BLANK', 'NEW']);
  });
});

describe('loadDotEnv', () => {
  it('prefers TW_ENV_FILE, then INIT_CWD, then the cwd and its parents up to the project root; a missing file is fine', () => {
    const root = tempDir();
    const nested = join(root, 'packages', 'server');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, 'package-lock.json'), '{}');
    writeFileSync(join(root, '.env'), 'FROM=root\n');

    const env1: Record<string, string | undefined> = {};
    expect(loadDotEnv({ cwd: nested, env: env1 })).toEqual({ path: join(root, '.env'), applied: ['FROM'] });
    expect(env1['FROM']).toBe('root');

    const other = tempDir();
    writeFileSync(join(other, '.env'), 'FROM=init\n');
    const env2: Record<string, string | undefined> = { INIT_CWD: other };
    expect(loadDotEnv({ cwd: nested, env: env2 }).path).toBe(join(other, '.env'));
    expect(env2['FROM']).toBe('init');

    const explicit = join(other, 'custom.env');
    writeFileSync(explicit, 'FROM=explicit\n');
    const env3: Record<string, string | undefined> = { TW_ENV_FILE: explicit, INIT_CWD: other };
    expect(loadDotEnv({ cwd: nested, env: env3 }).path).toBe(explicit);
    expect(env3['FROM']).toBe('explicit');

    const empty = tempDir();
    const env4: Record<string, string | undefined> = {};
    expect(loadDotEnv({ cwd: join(empty, 'x', 'y'), env: env4 })).toEqual({ path: null, applied: [] });
  });

  it('never climbs above the project root: a .env of another project further up is not loaded', () => {
    const outer = tempDir();
    writeFileSync(join(outer, '.env'), 'ELEVENLABS_API_KEY=clave-de-otro-proyecto\n');
    const repo = join(outer, 'telecomway');
    const nested = join(repo, 'packages', 'server');
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(repo, '.git'));
    const env: Record<string, string | undefined> = {};
    expect(loadDotEnv({ cwd: nested, env })).toEqual({ path: null, applied: [] });
    expect(env['ELEVENLABS_API_KEY']).toBeUndefined();
    // The repository's own .env is still found from any folder inside it.
    writeFileSync(join(repo, '.env'), 'FROM=repo\n');
    expect(loadDotEnv({ cwd: nested, env }).path).toBe(join(repo, '.env'));
    // Without any marker the search stops at the root of the file system, as before, but only when nothing marks a project.
    const loose = tempDir();
    writeFileSync(join(loose, '.env'), 'FROM=loose\n');
    const deep = join(loose, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    const env2: Record<string, string | undefined> = {};
    expect(loadDotEnv({ cwd: deep, env: env2 }).path).toBe(join(loose, '.env'));
  });
});
