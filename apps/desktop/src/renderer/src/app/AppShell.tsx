import './app.css';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CallScreen, LocalCallStart } from '../call';
import { useCall } from '../core/CallContext';
import { api } from '../core/http';
import { clearSession, useSession, type Session } from '../core/session';
import type { CallClientState } from '../core/types';
import { HistoryPage } from '../history';
import { SettingsPage } from '../settings';
import { Dialer } from './Dialer';
import { IncomingBanner } from './IncomingBanner';
import { LoginScreen } from './LoginScreen';
import { TopBar } from './TopBar';
import { OPERATOR_STATUS_LABELS } from './labels';

export const TABS = [
  ['call', 'Llamada'],
  ['dialer', 'Marcador'],
  ['history', 'Historial'],
  ['settings', 'Ajustes'],
] as const;
export type TabId = (typeof TABS)[number][0];

/** Login screen without a session; the operator shell with one. */
export function AppShell() {
  const session = useSession();
  return session ? <Shell session={session} /> : <LoginScreen />;
}

interface IdleCallPanelProps {
  state: CallClientState;
}

/** The Llamada tab while no call is on screen: connection, presence and the "modo audio del PC" starter. */
function IdleCallPanel({ state }: IdleCallPanelProps) {
  const connected = state.connection === 'connected';
  const presence = state.presence;
  return (
    <section className="page idle" aria-label="Sin llamada" data-testid="idle-panel">
      <div className="card idle__card">
        <h2 className="card__title">{connected ? 'Esperando llamadas' : 'Sin conexión con el servidor'}</h2>
        <p className="muted">
          {connected
            ? 'Cuando entre una llamada aparecerá un aviso arriba para contestarla. Para llamar tú a un pasajero usa la pestaña Marcador.'
            : (state.connectionError ?? 'Hasta que vuelva la conexión no se pueden recibir ni hacer llamadas.')}
        </p>
        {presence ? (
          <dl className="kv" data-testid="presence">
            <dt>Llamadas en curso</dt>
            <dd>
              {presence.activeCalls} de {presence.maxCalls}
            </dd>
            <dt>Operadores conectados</dt>
            <dd>
              {presence.operators.length === 0 ? (
                'Ninguno'
              ) : (
                <ul className="idle__operators">
                  {presence.operators.map((operator) => (
                    <li key={operator.id}>
                      {operator.name} <span className="muted">· {OPERATOR_STATUS_LABELS[operator.status]}</span>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </dl>
        ) : null}
      </div>
      {state.server?.localAudio ? <LocalCallStart /> : null}
    </section>
  );
}

interface ShellProps {
  session: Session;
}

function Shell({ session }: ShellProps) {
  const { state, actions } = useCall();
  const [tab, setTab] = useState<TabId>('call');
  const [loggingOut, setLoggingOut] = useState(false);
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});

  // A new call (answered, dialed or started locally) always brings the Llamada tab to the front.
  const callId = state.call?.callId ?? null;
  const previousCallId = useRef<string | null>(null);
  useEffect(() => {
    if (callId && callId !== previousCallId.current) setTab('call');
    previousCallId.current = callId;
  }, [callId]);

  async function logout(): Promise<void> {
    setLoggingOut(true);
    try {
      await api.logout();
    } catch {
      /* the token is forgotten locally anyway */
    } finally {
      clearSession();
    }
  }

  function onTabKey(event: KeyboardEvent<HTMLDivElement>): void {
    const index = TABS.findIndex(([id]) => id === tab);
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    if (next === null) return;
    event.preventDefault();
    const id = TABS[next]![0];
    setTab(id);
    tabRefs.current[id]?.focus();
  }

  const activeCall = state.call !== null && state.call.state !== 'ended';
  const showGlobalError = state.lastError !== null && tab !== 'call' && tab !== 'dialer';
  const showConnectionNotice = state.connection !== 'connected' && !state.call;

  return (
    <div className="app-shell" data-testid="app-shell">
      <TopBar session={session} state={state} loggingOut={loggingOut} onLogout={() => void logout()} />

      {state.incoming ? <IncomingBanner incoming={state.incoming} actions={actions} /> : null}

      {showConnectionNotice && state.connectionError ? (
        <p className="notice notice--warn" role="status" data-testid="connection-notice">
          {state.connectionError}
        </p>
      ) : null}

      <div className="tabs" role="tablist" aria-label="Secciones" onKeyDown={onTabKey}>
        {TABS.map(([id, label]) => (
          <button
            key={id}
            ref={(element) => {
              tabRefs.current[id] = element;
            }}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className="tab"
            onClick={() => setTab(id)}
          >
            {label}
            {id === 'call' && activeCall ? (
              <span className="tab__count" aria-label="llamada en curso">
                ●
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {showGlobalError && state.lastError ? (
        <p className="notice notice--danger" role="alert" data-testid="global-error">
          {state.lastError.message}{' '}
          <button type="button" className="button button--small" onClick={() => actions.dismissError?.()}>
            Entendido
          </button>
        </p>
      ) : null}

      <div className="tabpanel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'call' ? state.call ? <CallScreen /> : <IdleCallPanel state={state} /> : null}
        {tab === 'dialer' ? <Dialer /> : null}
        {tab === 'history' ? <HistoryPage /> : null}
        {tab === 'settings' ? <SettingsPage /> : null}
      </div>
    </div>
  );
}
