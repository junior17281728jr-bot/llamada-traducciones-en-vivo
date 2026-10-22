import { defineConfig } from '@playwright/test';

// Browser tests of the renderer in Chromium (not Electron). Browsers come from
// PLAYWRIGHT_BROWSERS_PATH (/opt/pw-browsers in this environment); never run "playwright install".
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'off' },
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 5173 --strictPort',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
