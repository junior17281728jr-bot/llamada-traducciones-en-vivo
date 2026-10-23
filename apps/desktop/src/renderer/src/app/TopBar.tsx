import type { Session } from '../core/session';
import type { CallClientState } from '../core/types';
import { CONNECTION_LABELS, ROLE_LABELS, SERVICES, SERVICE_STATUS_LABELS } from './labels';

interface TopBarProps {
  session: Session;
  state: CallClientState;
  loggingOut: boolean;
  onLogout: () => void;
}

/**
 * Operator name and role, WebSocket connection state (text plus a dot), service health chips and the
 * logout button. "Simulado" appears whenever the server runs mock providers or the mock telephone.
 */
export function TopBar({ session, state, loggingOut, onLogout }: TopBarProps) {
  // The server's roster is more current than the login response (status, autoAccept).
  const operator = state.operator ?? session.operator;
  const simulated = state.server ? state.server.providers === 'mock' || state.server.channel === 'mock' : false;
  const simulatedParts = [
    state.server?.providers === 'mock' ? 'voz y traducción simuladas' : null,
    state.server?.channel === 'mock' ? 'teléfono simulado' : null,
  ].filter(Boolean);

  return (
    <header className="topbar" data-testid="topbar">
      <div className="topbar__brand">
        <span className="topbar__logo" aria-hidden="true">
          ◐◑
        </span>
        <span className="topbar__app">Telecomway</span>
      </div>

      <div className="topbar__who">
        <strong data-testid="topbar-name">{operator.name}</strong>
        <span className="badge badge--role" data-testid="topbar-role">
          {ROLE_LABELS[operator.role]}
        </span>
        {operator.autoAccept ? (
          <span className="chip chip--accent" title="Las llamadas entrantes se contestan solas">
            Contestar automáticamente
          </span>
        ) : null}
      </div>

      <p className={`topbar__connection topbar__connection--${state.connection}`} role="status" data-testid="connection-status">
        <span className={`dot dot--${state.connection}`} aria-hidden="true" />
        {CONNECTION_LABELS[state.connection]}
      </p>

      {state.systemStatus ? (
        <ul className="topbar__services" aria-label="Estado de los servicios">
          {SERVICES.map(([key, label]) => {
            const status = state.systemStatus![key];
            const detail = state.systemStatus!.detail[key];
            return (
              <li key={key} className={`chip chip--${status}`} title={detail} data-testid={`service-${key}`}>
                {label}: {SERVICE_STATUS_LABELS[status]}
              </li>
            );
          })}
        </ul>
      ) : null}

      {simulated ? (
        <span className="badge badge--simulated" title={`Este servidor usa ${simulatedParts.join(' y ')}.`}>
          Simulado
        </span>
      ) : null}

      <button type="button" className="button button--small topbar__logout" onClick={onLogout} disabled={loggingOut}>
        {loggingOut ? 'Saliendo…' : 'Salir'}
      </button>
    </header>
  );
}
