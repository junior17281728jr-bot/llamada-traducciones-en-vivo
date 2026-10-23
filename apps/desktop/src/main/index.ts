/**
 * Electron main process. UNVERIFIED: written against the Electron API but never run here,
 * because the Electron binary cannot be downloaded in the build environment. It compiles
 * (types come from the npm package) and nothing else is claimed.
 */
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startEmbeddedRuntime, type EmbeddedRuntime } from './embedded.js';

const here = dirname(fileURLToPath(import.meta.url));
/** The one page this app loads from disk (`dist/renderer/index.html`), as the URL the renderer reports. */
const rendererFileUrl = pathToFileURL(join(here, '../renderer/index.html')).href;

/** Vite dev server URL (`npm run dev:desktop` then `electron .` with TW_RENDERER_URL set). */
const rendererDevUrl = process.env['TW_RENDERER_URL'];
/**
 * Server the renderer talks to. With TW_SERVER_URL the app is a thin client of an external server;
 * otherwise it starts its own (simulated) server and serves the page from it, so nothing else is needed.
 */
const externalServerUrl = process.env['TW_SERVER_URL'];
let embedded: EmbeddedRuntime | null = null;

const CONFIG_CHANNEL = 'tw:get-config';
const SIMULATE_CHANNEL = 'tw:simulate-call';

/** Only our own page gets the microphone and may be navigated to: the dev server, our embedded server, or exactly `dist/renderer/index.html`. */
export function isOurRenderer(url: string): boolean {
  if (rendererDevUrl) return url.startsWith(rendererDevUrl);
  if (embedded) return url.startsWith(`${embedded.serverUrl}/`) || url === embedded.serverUrl;
  const withoutFragment = url.split('#')[0]!.split('?')[0]!;
  return withoutFragment === rendererFileUrl;
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 360,
    minHeight: 520,
    show: false,
    backgroundColor: '#0b1220',
    webPreferences: {
      // The preload is CommonJS (.cts) so it can run in a sandboxed renderer.
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // The window never navigates away from our page (a link, a dropped file, a crafted URL) and never embeds a webview.
  window.webContents.on('will-navigate', (event, url) => {
    if (!isOurRenderer(url)) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());

  if (rendererDevUrl) void window.loadURL(rendererDevUrl);
  else if (embedded) void window.loadURL(`${embedded.serverUrl}/`);
  else void window.loadFile(join(here, '../renderer/index.html'));
}

app.whenReady().then(async () => {
  // The call screen needs the microphone; grant it to our own pages only.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media' && isOurRenderer(webContents.getURL()));
  });

  if (!externalServerUrl && !rendererDevUrl) {
    try {
      embedded = await startEmbeddedRuntime(app.getPath('userData'));
    } catch (error) {
      dialog.showErrorBox('Telecomway', `No se pudo iniciar el servidor integrado:\n${error instanceof Error ? error.message : String(error)}`);
      app.exit(1);
      return;
    }
  }

  ipcMain.handle(CONFIG_CHANNEL, () => ({
    serverUrl: embedded?.serverUrl ?? externalServerUrl ?? 'http://127.0.0.1:8787',
    platform: process.platform,
    version: app.getVersion(),
    embedded: embedded ? { username: embedded.credentials.username, password: embedded.credentials.password } : null,
  }));
  ipcMain.handle(SIMULATE_CHANNEL, async () => {
    if (!embedded) return { outcome: 'unsupported', message: 'La llamada de prueba solo existe con el servidor integrado.' };
    return embedded.simulateCall();
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error: unknown) => {
  console.error('No se pudo iniciar la aplicación', error);
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let stopping = false;
app.on('before-quit', (event) => {
  if (!embedded || stopping) return;
  stopping = true;
  event.preventDefault();
  void embedded.stop().finally(() => app.quit());
});
