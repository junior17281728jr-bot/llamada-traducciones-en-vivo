import { CallProvider } from './core/CallContext';
// Explicit index: on case-insensitive file systems (Windows, macOS) './app' would resolve to this very file (App.tsx).
import { AppShell } from './app/index';
import { createCallClient } from './call';

export function App() {
  return (
    <CallProvider factory={createCallClient}>
      <AppShell />
    </CallProvider>
  );
}
