import { CallProvider } from './core/CallContext';
import { AppShell } from './app';
import { createCallClient } from './call';

export function App() {
  return (
    <CallProvider factory={createCallClient}>
      <AppShell />
    </CallProvider>
  );
}
