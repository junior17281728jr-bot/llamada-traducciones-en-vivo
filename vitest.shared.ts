import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(fileURLToPath(import.meta.url));

/**
 * Maps every `@tw/*` workspace package that has a `src/index.ts` to that file,
 * so tests and Vite builds run against sources without a prior `npm run build`.
 * Convention: each package exposes a single entry point (no sub-path imports).
 */
export function workspaceAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const group of ['packages', 'apps', 'tools']) {
    const groupDir = join(repoRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const name of readdirSync(groupDir)) {
      const manifest = join(groupDir, name, 'package.json');
      const entry = join(groupDir, name, 'src', 'index.ts');
      if (!existsSync(manifest) || !existsSync(entry)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
      if (pkg.name) aliases[pkg.name] = entry;
    }
  }
  return aliases;
}

/** Defaults shared by every workspace: bounded timeouts, colocated `*.test.ts(x)` files. */
export const baseTestOptions: {
  include: string[];
  testTimeout: number;
  hookTimeout: number;
  teardownTimeout: number;
} = {
  include: ['src/**/*.test.{ts,tsx}'],
  testTimeout: 10_000,
  hookTimeout: 10_000,
  teardownTimeout: 5_000,
};
