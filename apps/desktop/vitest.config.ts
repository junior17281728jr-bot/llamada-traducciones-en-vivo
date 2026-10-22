import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { baseTestOptions, workspaceAliases } from '../../vitest.shared.ts';

// jsdom for renderer tests. A test of Electron main-process code should opt out with
// `// @vitest-environment node`.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: workspaceAliases() },
  test: {
    ...baseTestOptions,
    name: '@tw/desktop',
    environment: 'jsdom',
    setupFiles: ['./src/renderer/src/test-setup.ts'],
  },
});
