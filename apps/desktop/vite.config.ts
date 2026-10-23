import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { workspaceAliases } from '../../vitest.shared.ts';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Content Security Policy of the built page (Electron loads it from disk; `vite preview` and the browser tests
 * serve the same file). Scripts, styles, the audio worklet and fonts only from the app itself; the server the
 * operator types at login may be any http(s)/ws(s) origin; recordings play from blob: URLs. Not applied to the
 * dev server, whose hot reload injects inline scripts and styles.
 */
export const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self' http: https: ws: wss:",
  "font-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'telecomway-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: RENDERER_CSP }, injectTo: 'head-prepend' }],
  };
}

// The renderer is a plain Vite app rooted at src/renderer. `base: './'` lets Electron load it from file://.
export default defineConfig({
  root: resolve(here, 'src/renderer'),
  base: './',
  plugins: [react(), cspPlugin()],
  resolve: { alias: workspaceAliases() },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: {
    outDir: resolve(here, 'dist/renderer'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
});
