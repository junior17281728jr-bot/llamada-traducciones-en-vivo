import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { workspaceAliases } from '../../vitest.shared.ts';

const here = dirname(fileURLToPath(import.meta.url));

// The renderer is a plain Vite app rooted at src/renderer. `base: './'` lets Electron load it from file://.
export default defineConfig({
  root: resolve(here, 'src/renderer'),
  base: './',
  plugins: [react()],
  resolve: { alias: workspaceAliases() },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: {
    outDir: resolve(here, 'dist/renderer'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
});
