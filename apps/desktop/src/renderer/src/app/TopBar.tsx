import type { Session } from '../core/session';
import type { CallClientState, WatchStatus } from '../core/types';
import type { ServiceStatus } from '@tw/shared';
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
const WATCH_CHIP: Record<WatchStatus, { tone: string; text: string }> = {
  listening: { tone: 'ok', text: 'Esperando llamadas' },
  arming: { tone: 'ok', text: 'Esperando silencio' },
  starting: { tone: 'ok', text: 'Entrando llamada' },
  in_call: { tone: 'ok', text: 'En llamada' },
  off: { tone: 'warn', text: 'Entrada automática apagada' },
  needs_setup: { tone: 'warn', text: 'Falta conectar' },
  waiting_connection: { tone: 'warn', text: 'Arrancando' },
  unsupported: { tone: 'down', text: 'No disponible' },
  error: { tone: 'down', text: 'Revisa los cables' },
};

/** One word for the real translation: ready, a key missing, or a key that failed its test. */
function translationChip(elevenlabs: ServiceStatus | undefined, translator: ServiceStatus | undefined): { tone: string; text: string; title: string } {
  const statuses = [elevenlabs, translator];
  if (statuses.some((status) => status === 'down')) return { tone: 'down', text: 'Revisa tus claves', title: 'Una clave falló al probarla.' };
  if (statuses.some((status) => status === undefined || status === 'unconfigured')) {
    return { tone: 'warn', text: 'Faltan claves', title: 'Sin las claves de ElevenLabs y Anthropic se oye la voz original sin traducir.' };
  }
  if (statuses.every((status) => status === 'ok')) return { tone: 'ok', text: 'Lista y comprobada', title: 'Claves comprobadas.' };
  return { tone: 'ok', text: 'Lista', title: 'Claves guardadas. Puedes comprobarlas en Ajustes > Claves.' };
}

function BrandMark() {
  return (
    <svg className="topbar__mark" viewBox="0 0 32 32" width="30" height="30" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="9" fill="url(#tw-brand)" />
      <path d="M9 11.5h9a3 3 0 0 1 3 3v2a3 3 0 0 1-3 3h-4l-3 2.5V19.5H9a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" fill="#fff" opacity="0.95" />
      <path d="M23 9.5h-7a2 2 0 0 0-2 2v.2h4a4.8 4.8 0 0 1 4.8 4.8v1.2l1.7 1.3V17a2 2 0 0 0 .5-1.3v-4.2a2 2 0 0 0-2-2Z" fill="#fff" opacity="0.6" />
      <defs>
        <linearGradient id="tw-brand" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1f5fd6" />
          <stop offset="1" stopColor="#38bdf8" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function TopBar({ session, state, loggingOut, onLogout }: TopBarProps) {
  // The server's roster is more current than the login response (status, autoAccept).
  const operator = state.operator ?? session.operator;
  if (state.server?.providers === 'auto') return <DesktopTopBar state={state} />;
  const simulated = state.server ? state.server.providers === 'mock' || state.server.channel === 'mock' : false;
  const simulatedParts = [
    state.server?.providers === 'mock' ? 'voz y traducción simuladas' : null,
    state.server?.channel === 'mock' ? 'teléfono simulado' : null,
  ].filter(Boolean);

  return (
    <header className="topbar" data-testid="topbar">
      <div className="topbar__brand">
        <BrandMark />
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

/** The desktop app: brand, whether the real translation is ready and what WhatsApp is doing. Nothing else. */
function DesktopTopBar({ state }: { state: CallClientState }) {
  const translation = translationChip(state.systemStatus?.elevenlabs, state.systemStatus?.translator);
  const watch = WATCH_CHIP[state.watch.status];
  return (
    <header className="topbar topbar--desktop" data-testid="topbar">
      <div className="topbar__brand">
        <BrandMark />
        <span className="topbar__app">
          Telecomway <span className="topbar__app-sub">Traductor</span>
        </span>
      </div>
      <ul className="topbar__services" aria-label="Estado">
        <li className={`chip chip--${translation.tone}`} title={translation.title} data-testid="service-translation">
          Traducción: {translation.text}
        </li>
        <li className={`chip chip--${watch.tone}`} data-testid="service-whatsapp">
          WhatsApp: {watch.text}
        </li>
      </ul>
      {state.connection !== 'connected' ? (
        <p className={`topbar__connection topbar__connection--${state.connection}`} role="status" data-testid="connection-status">
          <span className={`dot dot--${state.connection}`} aria-hidden="true" />
          {CONNECTION_LABELS[state.connection]}
        </p>
      ) : null}
    </header>
  );
}
