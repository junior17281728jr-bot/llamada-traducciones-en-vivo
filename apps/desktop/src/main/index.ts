/**
 * Electron main process. UNVERIFIED: written against the Electron API but never run here,
 * because the Electron binary cannot be downloaded in the build environment. It compiles
 * (types come from the npm package) and nothing else is claimed.
 */
import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** The one page this app loads from disk (`dist/renderer/index.html`), as the URL the renderer reports. */
const rendererFileUrl = pathToFileURL(join(here, '../renderer/index.html')).href;

/** Vite dev server URL (`npm run dev:desktop` then `electron .` with TW_RENDERER_URL set). */
const rendererDevUrl = process.env['TW_RENDERER_URL'];
/** Server the renderer talks to by default. */
const serverUrl = process.env['TW_SERVER_URL'] ?? 'http://127.0.0.1:8787';

const CONFIG_CHANNEL = 'tw:get-config';

/** Only our own page gets the microphone and may be navigated to: not any `file://` URL, only `dist/renderer/index.html`. */
export function isOurRenderer(url: string): boolean {
  if (rendererDevUrl) return url.startsWith(rendererDevUrl);
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
  else void window.loadFile(join(here, '../renderer/index.html'));
}

app.whenReady().then(() => {
  // The call screen needs the microphone; grant it to our own pages only.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media' && isOurRenderer(webContents.getURL()));
  });

  ipcMain.handle(CONFIG_CHANNEL, () => ({
    serverUrl,
    platform: process.platform,
    version: app.getVersion(),
  }));

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
