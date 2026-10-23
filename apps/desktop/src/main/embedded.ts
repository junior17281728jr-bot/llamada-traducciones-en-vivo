/**
 * The server inside the desktop app. `dist/embedded/server.cjs` is @tw/server bundled by
 * scripts/bundle-server.mjs, so the packaged app needs no Node installation and no terminal:
 * double-click, and the app talks to its own server on 127.0.0.1 in simulated mode.
 * UNVERIFIED inside a real Electron build (Electron does not run in the build environment); the
 * bundle itself is exercised by tests and by a Node smoke run.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface EmbeddedCredentials {
  username: string;
  password: string;
}

interface SimulatedCallOutcome {
  outcome: string;
  callId?: string | null;
  reason?: string;
  message?: string;
}

interface EmbeddedModule {
  startEmbeddedServer(options: {
    dataDir: string;
    adminUsername?: string;
    adminPassword: string;
    staticDir?: string;
    port?: number;
    recordCalls?: boolean;
  }): Promise<{ app: unknown; port: number; serverUrl: string; stop(): Promise<void> }>;
  simulatePassengerCall(app: unknown, options?: object): Promise<SimulatedCallOutcome>;
}

export interface EmbeddedRuntime {
  serverUrl: string;
  credentials: EmbeddedCredentials;
  simulateCall(): Promise<SimulatedCallOutcome>;
  stop(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));

/** One local login per computer, generated the first time and kept next to the data (owner-only file). */
export async function loadOrCreateCredentials(userDataDir: string): Promise<EmbeddedCredentials> {
  const file = join(userDataDir, 'acceso-local.json');
  try {
    const saved = JSON.parse(await readFile(file, 'utf8')) as Partial<EmbeddedCredentials>;
    if (saved.username && saved.password) return { username: saved.username, password: saved.password };
  } catch {
    /* first run */
  }
  const credentials: EmbeddedCredentials = { username: 'admin', password: randomBytes(12).toString('base64url') };
  await mkdir(userDataDir, { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  return credentials;
}

/** Starts the bundled server with the app's data folder and serves the compiled page from it. */
export async function startEmbeddedRuntime(userDataDir: string): Promise<EmbeddedRuntime> {
  const require = createRequire(import.meta.url);
  const server = require(join(here, '../embedded/server.cjs')) as EmbeddedModule;
  const credentials = await loadOrCreateCredentials(userDataDir);
  const running = await server.startEmbeddedServer({
    dataDir: join(userDataDir, 'datos'),
    adminUsername: credentials.username,
    adminPassword: credentials.password,
    staticDir: join(here, '../renderer'),
    port: 0,
    recordCalls: true,
  });
  let busy = false;
  return {
    serverUrl: running.serverUrl,
    credentials,
    async simulateCall() {
      if (busy) return { outcome: 'unsupported', message: 'Ya hay una llamada de prueba en curso.' };
      busy = true;
      try {
        return await server.simulatePassengerCall(running.app);
      } finally {
        busy = false;
      }
    },
    stop: () => running.stop(),
  };
}
