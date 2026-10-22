import { defineConfig } from 'vitest/config';

// Each workspace owns its own vitest.config.ts; the root run aggregates them.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'tools/*'],
  },
});
