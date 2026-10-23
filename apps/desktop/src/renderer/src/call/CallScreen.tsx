import './call.css';
import { useEffect, useState } from 'react';
import { useCall } from '../core/CallContext';
import { useLanguageCatalog } from '../core/catalog';
import type { ActiveCall } from '../core/types';
import { DebugSay } from './DebugSay';
import { Lane } from './Lane';
import { LanguagePanel } from './LanguagePanel';
import { StatusStrip } from './StatusStrip';
import { END_REASON_LABELS, formatDuration, langName, passengerHearsLabel, passengerLanguageLabel } from './labels';

function useElapsedSeconds(call: ActiveCall): number | null {
  const [now, setNow] = useState(() => Date.now());
  const running = call.answeredAt !== null && call.state === 'active';
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return call.answeredAt === null ? null : Math.max(0, (now - call.answeredAt) / 1000);
}

const STATE_TEXT: Record<ActiveCall['state'], string> = {
  queued: 'En cola',
  ringing: 'Sonando…',
  dialing: 'Marcando…',
  active: 'En llamada',
  ended: 'Llamada terminada',
};

const MIC_WARNING: Partial<Record<ActiveCall['mic'], string>> = {
  denied: 'No hay permiso para usar el micrófono. Permítelo en los ajustes del sistema.',
  unavailable: 'No se encuentra ningún micrófono.',
  requesting: 'Esperando permiso para usar el micrófono…',
};

/**
 * The call: top bar, language panel and the two lanes (Pasajero, Operador) that are always visible. Both
 * lanes show REAL audio only. In simulated mode the screen says "Simulado" and offers a box to speak.
 */
export function CallScreen() {
  const { state, levels, actions } = useCall();
  const languages = useLanguageCatalog();
  const call = state.call;
  const elapsed = useElapsedSeconds(call ?? ({ answeredAt: null, state: 'ended' } as ActiveCall));
  if (!call) {
    return (
      <section aria-label="Llamada" className="call call--empty" data-testid="call-screen-empty">
        <p>No hay ninguna llamada ahora mismo.</p>
      </section>
    );
  }

  const ended = call.state === 'ended';
  const settings = call.settings;
  return (
    <section className="call" aria-label="Llamada" data-testid="call-screen" data-state={call.state}>
      <header className="call__bar">
        <div className="call__who">
          <span className={`pill pill--${call.state}`}>{STATE_TEXT[call.state]}</span>
          <strong className="call__number">{call.remoteNumber}</strong>
          <span className="call__direction">{call.direction === 'inbound' ? 'Llamada entrante' : 'Llamada saliente'}</span>
          {elapsed !== null ? <span className="call__timer" aria-label="Duración">{formatDuration(elapsed)}</span> : null}
          {call.simulated ? <span className="badge badge--simulated">Simulado</span> : null}
        </div>
        <div className="call__actions">
          {!ended ? (
            <>
              <button type="button" className="button" aria-pressed={call.muted} onClick={() => actions.mute(!call.muted)}>
                {call.muted ? 'Quitar silencio' : 'Silenciar micrófono'}
              </button>
              <button type="button" className="button button--danger" onClick={() => actions.hangup()}>
                Colgar
              </button>
            </>
          ) : (
            <button type="button" className="button" onClick={() => actions.dismissEndedCall()}>
              Cerrar
            </button>
          )}
        </div>
      </header>

      {ended && call.endedReason ? (
        <p className="notice notice--info" role="status">
          {END_REASON_LABELS[call.endedReason]}. Puedes ver la transcripción abajo o en el historial.
        </p>
      ) : null}

      <StatusStrip state={state} onDismissError={() => actions.dismissError?.()} />
      <LanguagePanel call={call} actions={actions} languages={languages} />

      <div className="lanes">
        <Lane
          speaker="passenger"
          name="Pasajero"
          call={call}
          source={levels.passenger}
          colorToken="--color-passenger"
          subtitle={<span data-testid="passenger-language">{passengerLanguageLabel(call)}</span>}
        />
        <Lane
          speaker="operator"
          name="Operador"
          call={call}
          source={levels.operator}
          colorToken="--color-operator"
          subtitle={
            settings ? (
              <span data-testid="operator-language">
                Hablas en {langName(settings.operatorLang)} · el pasajero te oye en {passengerHearsLabel(call)}
              </span>
            ) : null
          }
          warning={call.muted && !ended ? 'Micrófono silenciado: nada de lo que digas se traduce.' : (MIC_WARNING[call.mic] ?? null)}
        />
      </div>

      {state.server?.debug && !ended ? (
        <DebugSay languages={languages} onSay={(text, lang, as) => actions.debugSay(text, lang, as)} />
      ) : null}
    </section>
  );
}
