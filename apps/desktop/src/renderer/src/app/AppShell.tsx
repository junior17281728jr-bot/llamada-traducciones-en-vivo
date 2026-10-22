import { useCall } from '../core/CallContext';
import { useSession } from '../core/session';
import { CallScreen } from '../call';

/** Placeholder shell: the app team replaces it with login, dialer, history, settings and routing. */
export function AppShell() {
  const session = useSession();
  const { state } = useCall();
  return (
    <main className="app-shell">
      <h1>Telecomway</h1>
      <p>{session ? `Sesión de ${session.operator.name}` : 'Sin sesión iniciada'}</p>
      <p>Conexión: {state.connection}</p>
      <CallScreen />
    </main>
  );
}
