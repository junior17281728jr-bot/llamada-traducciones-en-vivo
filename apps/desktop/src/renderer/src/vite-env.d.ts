/// <reference types="vite/client" />

import type { DesktopConfig } from './core/session';

declare global {
  interface Window {
    /** Present only inside Electron (exposed by the preload); absent in a plain browser. */
    telecomway?: {
      getConfig(): Promise<DesktopConfig>;
    };
  }
}
