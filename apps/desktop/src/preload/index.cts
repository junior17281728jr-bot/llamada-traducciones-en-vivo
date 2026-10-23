/** Preload (CommonJS so it can run sandboxed). Exposes a minimal bridge to the renderer. */
import electron = require('electron');

const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld('telecomway', {
  getConfig: (): Promise<unknown> => ipcRenderer.invoke('tw:get-config'),
  /** Only with the embedded server: a simulated passenger calls the app. */
  simulateCall: (): Promise<unknown> => ipcRenderer.invoke('tw:simulate-call'),
});
