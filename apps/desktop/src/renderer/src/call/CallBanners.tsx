import { useEffect, useState } from 'react';
import type { DirectionFallback } from '@tw/shared';
import type { ActiveCall, CallActions } from '../core/types';

function useSecondsLeft(until: number | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : null;
}

/** One line per direction in plan B, said from the operator's side. */
export function fallbackLines(passenger: DirectionFallback, operator: DirectionFallback): string[] {
  const lines: string[] = [];
  if (passenger.originalVoice) lines.push('Oyes la voz original del pasajero, sin traducir.');
  else if (passenger.systemVoice) lines.push('La traducción que oyes la lee la voz del ordenador.');
  if (operator.originalVoice) lines.push('El pasajero oye tu voz original, sin traducir.');
  else if (operator.systemVoice) lines.push('El pasajero oye la traducción con la voz del ordenador.');
  return lines;
}

interface CallBannersProps {
  call: ActiveCall;
  actions: CallActions;
}

/**
 * Two things the operator must see at once during a call: the plan B in use (ElevenLabs failed) and the
 * countdown that closes a local call whose WhatsApp side has gone silent.
 */
export function CallBanners({ call, actions }: CallBannersProps) {
  const secondsLeft = useSecondsLeft(call.state === 'active' ? call.autoEndAt : null);
  const fallback = call.state === 'active' ? call.fallback : null;
  const lines = fallback ? fallbackLines(fallback.passengerToOperator, fallback.operatorToPassenger) : [];
  const detail = fallback ? (fallback.passengerToOperator.detail ?? fallback.operatorToPassenger.detail) : null;
  return (
    <>
      {secondsLeft !== null ? (
        <div className="banner banner--countdown" role="alert" data-testid="auto-end-banner">
          <div className="banner__text">
            <strong>WhatsApp lleva un rato en silencio. ¿Terminó la llamada?</strong>
            <span>La traducción se cerrará en {secondsLeft} s.</span>
          </div>
          <div className="banner__actions">
            <button type="button" className="button button--primary" onClick={() => actions.keepCall?.()}>
              Sigo en la llamada
            </button>
            <button type="button" className="button" onClick={() => actions.hangup()}>
              Terminar ya
            </button>
          </div>
        </div>
      ) : null}
      {lines.length > 0 ? (
        <div className="banner banner--planb" role="status" data-testid="fallback-banner">
          <div className="banner__text">
            <strong>Plan B activo: ElevenLabs o la traducción no responden</strong>
            {lines.map((line) => (
              <span key={line}>{line}</span>
            ))}
            {detail ? <span className="small muted">{detail} Vuelve sola cuando el servicio responde.</span> : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
