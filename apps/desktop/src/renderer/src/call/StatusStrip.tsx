import type { CallClientState } from '../core/types';
import { SERVICE_STATUS_LABELS } from './labels';

const CONNECTION_TEXT: Record<CallClientState['connection'], string> = {
  disconnected: 'Sin conexión con el servidor',
  connecting: 'Conectando con el servidor…',
  connected: 'Conectado',
  reconnecting: 'Reconectando con el servidor…',
};

const SERVICES = [
  ['elevenlabs', 'Voz (ElevenLabs)'],
  ['translator', 'Traductor'],
  ['channel', 'Llamadas'],
] as const;

interface StatusStripProps {
  state: CallClientState;
  onDismissError: () => void;
}

/** Connection state, health of each service and the last error, in plain Spanish. */
export function StatusStrip({ state, onDismissError }: StatusStripProps) {
  const { connection, connectionError, systemStatus, lastError } = state;
  return (
    <div className="status-strip" data-testid="status-strip">
      {connection !== 'connected' ? (
        <p className="notice notice--warn" role="status">
          {CONNECTION_TEXT[connection]}
          {connectionError ? ` ${connectionError}` : ''}
        </p>
      ) : null}
      {systemStatus ? (
        <ul className="status-strip__services" aria-label="Estado de los servicios">
          {SERVICES.map(([key, label]) => {
            const status = systemStatus[key];
            const detail = systemStatus.detail[key];
            return (
              <li key={key} className={`chip chip--${status}`} title={detail}>
                {label}: {SERVICE_STATUS_LABELS[status]}
              </li>
            );
          })}
        </ul>
      ) : null}
      {lastError ? (
        <p className="notice notice--danger" role="alert">
          {lastError.message}{' '}
          <button type="button" className="button button--small" onClick={onDismissError}>
            Entendido
          </button>
        </p>
      ) : null}
    </div>
  );
}
