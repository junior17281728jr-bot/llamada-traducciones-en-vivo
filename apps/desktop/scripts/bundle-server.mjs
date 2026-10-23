// Bundles @tw/server (with @tw/pipeline and @tw/shared) into one CommonJS file the Electron main process
// loads to run the server inside the app. No node_modules are shipped: everything is inlined here.
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const pkg = (name) => resolve(root, 'packages', name, 'src', 'index.ts');

await build({
  entryPoints: [pkg('server')],
  outfile: resolve(here, '../dist/embedded/server.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  logLevel: 'warning',
  alias: { '@tw/shared': pkg('shared'), '@tw/pipeline': pkg('pipeline'), '@tw/server': pkg('server') },
  // Optional native accelerators of `ws`; it falls back to pure JS when they are missing.
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: '/* Telecomway: servidor integrado en la app (generado por scripts/bundle-server.mjs). */' },
});
console.log('Servidor integrado generado en dist/embedded/server.cjs');
