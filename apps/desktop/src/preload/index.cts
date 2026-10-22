/** Preload (CommonJS so it can run sandboxed). Exposes a minimal, read-only bridge to the renderer. */
import electron = require('electron');

const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld('telecomway', {
  getConfig: (): Promise<unknown> => ipcRenderer.invoke('tw:get-config'),
});
