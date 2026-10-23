/// <reference types="vite/client" />

import type { DesktopConfig, SimulatedCallResult } from './core/session';

declare global {
  interface Window {
    /** Present only inside Electron (exposed by the preload); absent in a plain browser. */
    telecomway?: {
      getConfig(): Promise<DesktopConfig>;
      /** Embedded server only: a simulated passenger calls the app. */
      simulateCall?(): Promise<SimulatedCallResult>;
    };
  }
}
