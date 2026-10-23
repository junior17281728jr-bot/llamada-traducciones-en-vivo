/**
 * Starts a REAL Telecomway server in simulated mode for the browser tests: built `packages/server/dist`,
 * `PORT=0`, a temporary `DATA_DIR`, and one operator created with the real CLI before the server boots.
 * The renderer comes from `vite preview` (see playwright.config.ts). Everything is torn down afterwards.
 *
 * Requires `npm run build` at the repository root first (server dist + renderer dist).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const serverMain = join(repoRoot, 'packages/server/dist/main.js');
const createOperatorCli = join(repoRoot, 'packages/server/dist/cli/create-operator.js');
const rendererIndex = join(here, '../dist/renderer/index.html');

/** Credentials of the throwaway operator; tests read them from the environment. */
export const E2E_OPERATOR = { username: 'ana', password: 'prueba-e2e-1234', name: 'Ana' } as const;

export const ENV_SERVER_URL = 'TW_E2E_SERVER_URL';
export const ENV_USERNAME = 'TW_E2E_USERNAME';
export const ENV_PASSWORD = 'TW_E2E_PASSWORD';

function waitForListening(server: ChildProcess, output: string[], timeoutMs: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(`El servidor no anunció su puerto en ${timeoutMs} ms:\n${output.join('')}`)), timeoutMs);
    let buffer = '';
    server.stdout?.setEncoding('utf8');
    server.stdout?.on('data', (chunk: string) => {
      output.push(chunk);
      buffer += chunk;
      const match = /escuchando en http:\/\/[^:\s]+:(\d+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
    server.stderr?.setEncoding('utf8');
    server.stderr?.on('data', (chunk: string) => output.push(chunk));
    server.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`El servidor terminó con código ${code} antes de escuchar:\n${output.join('')}`));
    });
    server.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function stop(server: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolveStop) => {
    if (server.exitCode !== null || server.signalCode !== null) {
      resolveStop();
      return;
    }
    const timer = setTimeout(() => {
      server.kill('SIGKILL');
    }, timeoutMs);
    server.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
    server.kill('SIGTERM');
  });
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  for (const file of [serverMain, createOperatorCli, rendererIndex]) {
    if (!existsSync(file)) throw new Error(`Falta ${file}. Ejecuta "npm run build" en la raíz antes de "npm run test:e2e".`);
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'telecomway-e2e-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATA_DIR: dataDir,
    // Never pick up a developer's .env: point the loader at a file that does not exist.
    TW_ENV_FILE: join(dataDir, 'sin-env'),
    PROVIDERS: 'mock',
    CHANNEL: 'mock',
    HOST: '127.0.0.1',
    PORT: '0',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'admin-e2e-1234',
    AUTO_ACCEPT: 'false',
    RECORD_CALLS: 'true',
    RING_TIMEOUT_SECONDS: '30',
    ALLOWED_ORIGINS: '',
  };

  // The operator is created with the real CLI (password through TW_NEW_PASSWORD, never an argument).
  const created = spawnSync(process.execPath, [createOperatorCli, E2E_OPERATOR.username, '--nombre', E2E_OPERATOR.name], {
    env: { ...env, TW_NEW_PASSWORD: E2E_OPERATOR.password },
    encoding: 'utf8',
  });
  if (created.status !== 0) {
    rmSync(dataDir, { recursive: true, force: true });
    throw new Error(`No se pudo crear el operador de prueba: ${created.stderr || created.stdout}`);
  }

  const output: string[] = [];
  const server = spawn(process.execPath, [serverMain], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let port: number;
  try {
    port = await waitForListening(server, output, 20_000);
  } catch (error) {
    await stop(server, 2_000);
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }

  process.env[ENV_SERVER_URL] = `http://127.0.0.1:${port}`;
  process.env[ENV_USERNAME] = E2E_OPERATOR.username;
  process.env[ENV_PASSWORD] = E2E_OPERATOR.password;

  return async () => {
    await stop(server, 5_000);
    rmSync(dataDir, { recursive: true, force: true });
  };
}
