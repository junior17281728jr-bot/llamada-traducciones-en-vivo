import { useEffect, useState } from 'react';
import type { CallActions, IncomingCall } from '../core/types';
import { langName } from './labels';

interface IncomingBannerProps {
  incoming: IncomingCall;
  actions: CallActions;
}

/** Seconds left before the offer times out (null when the server set no limit). */
export function ringSecondsLeft(incoming: IncomingCall, now: number): number | null {
  if (incoming.ringTimeoutSeconds === null) return null;
  const elapsed = (now - incoming.receivedAt) / 1000;
  return Math.max(0, Math.ceil(incoming.ringTimeoutSeconds - elapsed));
}

/**
 * Global incoming-call alert: visible on every tab while an offer is pending. Shows the caller, the
 * language hint when the channel gave one, a countdown and the Contestar / Rechazar buttons.
 */
export function IncomingBanner({ incoming, actions }: IncomingBannerProps) {
  const [now, setNow] = useState(() => Date.now());
  /** Which button was pressed for this offer: both are disabled afterwards (a second click must not answer twice). */
  const [pressed, setPressed] = useState<'accept' | 'reject' | null>(null);
  useEffect(() => {
    setNow(Date.now());
    setPressed(null);
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [incoming.callId]);

  const left = ringSecondsLeft(incoming, now);
  const hint = incoming.langHint ? langName(incoming.langHint) : null;

  return (
    <section className="incoming" role="region" aria-live="assertive" aria-label="Llamada entrante" data-testid="incoming-banner">
      <div className="incoming__text">
        <p className="incoming__title">
          <span className="incoming__pulse" aria-hidden="true" />
          Llamada entrante
        </p>
        <p className="incoming__from">
          <strong className="mono" data-testid="incoming-from">
            {incoming.from}
          </strong>
          {hint ? <span className="chip chip--accent chip--large">Idioma: {hint}</span> : null}
        </p>
        <p className="incoming__meta muted small">
          {left !== null ? (
            <span data-testid="incoming-countdown">{left > 0 ? `Quedan ${left} s para contestar` : 'Se acaba el tiempo…'}</span>
          ) : (
            <span>Sin límite de tiempo</span>
          )}
          {incoming.autoAccept ? <span data-testid="incoming-auto"> · Se contestará automáticamente</span> : null}
        </p>
      </div>
      <div className="incoming__actions">
        <button
          type="button"
          className="button button--ok button--large"
          disabled={pressed !== null}
          onClick={() => {
            setPressed('accept');
            actions.accept(incoming.callId);
          }}
        >
          {pressed === 'accept' ? 'Contestando…' : incoming.autoAccept ? 'Contestar ya' : 'Contestar'}
        </button>
        <button
          type="button"
          className="button button--danger button--large"
          disabled={pressed !== null}
          onClick={() => {
            setPressed('reject');
            actions.reject(incoming.callId);
          }}
        >
          Rechazar
        </button>
      </div>
    </section>
  );
}
