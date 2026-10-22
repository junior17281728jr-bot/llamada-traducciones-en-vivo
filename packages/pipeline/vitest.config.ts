import { defineConfig } from 'vitest/config';
import { baseTestOptions, workspaceAliases } from '../../vitest.shared.ts';

export default defineConfig({
  resolve: { alias: workspaceAliases() },
  test: { ...baseTestOptions, name: '@tw/pipeline', environment: 'node' },
});
