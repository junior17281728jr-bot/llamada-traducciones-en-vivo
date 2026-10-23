import { defineConfig } from '@playwright/test';

// Browser tests of the renderer in Chromium (not Electron). Browsers come from
// PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers in this environment); never run "playwright install".
//
// Run `npm run build` at the root first: e2e/global-setup.ts starts the BUILT server in simulated
// mode (PORT=0, temporary DATA_DIR) and `vite preview` serves the BUILT renderer.
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // One operator account: a second session of the same operator is refused, so tests run one at a time.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'off' },
  webServer: {
    command: 'npx vite preview --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
