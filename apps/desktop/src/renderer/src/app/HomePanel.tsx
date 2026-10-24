import { useState } from 'react';
import type { ServiceStatus } from '@tw/shared';
import { LocalCallStart } from '../call';
import { useCall } from '../core/CallContext';
import { canSimulateCall, requestSimulatedCall, type SimulatedCallResult } from '../core/session';
import type { CallClientState, WatchStatus } from '../core/types';

/** Where the home screen can send the operator. */
export type SettingsTarget = 'ajustes-claves' | 'ajustes-voz' | 'ajustes-audio';

interface HomePanelProps {
  state: CallClientState;
  onOpenSettings: (target: SettingsTarget) => void;
}

const WATCH_TEXT: Record<WatchStatus, { title: string; text: string }> = {
  listening: {
    title: 'Esperando llamadas de WhatsApp',
    text: 'Cuando te llamen (o llames tú) por WhatsApp en este ordenador, la llamada entra sola aquí y se traduce.',
  },
  arming: {
    title: 'Esperando a que termine la llamada anterior',
    text: 'En cuanto WhatsApp quede en silencio unos segundos, la app vuelve a esperar llamadas.',
  },
  starting: { title: 'Entrando la llamada…', text: 'Preparando la traducción.' },
  in_call: { title: 'En llamada', text: 'La traducción está en marcha.' },
  off: { title: 'Entrada automática apagada', text: 'Actívala para que las llamadas de WhatsApp entren solas.' },
  needs_setup: { title: 'Falta conectar WhatsApp', text: 'Elige los dos cables de audio en Ajustes. Son 5 minutos y la guía te lo explica.' },
  waiting_connection: { title: 'Arrancando…', text: 'Conectando con el traductor de este ordenador.' },
  unsupported: { title: 'WhatsApp del PC no disponible', text: 'Este servidor no admite el modo audio del PC.' },
  error: { title: 'No se puede escuchar a WhatsApp', text: 'Revisa los cables en Ajustes > Audio y WhatsApp.' },
};

const keyReady = (status: ServiceStatus | undefined): boolean => status === 'configured' || status === 'ok' || status === 'degraded';

function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" width="40" height="40" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1L6.6 10.8Z"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z" />
    </svg>
  );
}

/** The big WhatsApp card: what the automatic entry is doing right now, with its switch and a live meter of cable A. */
function WhatsAppCard({ state, onOpenSettings }: HomePanelProps) {
  const { actions } = useCall();
  const watch = state.watch;
  const copy = WATCH_TEXT[watch.status];
  const listening = watch.status === 'listening' || watch.status === 'arming';
  const meter = Math.min(100, Math.round(watch.level * 400));
  return (
    <section className={`hero hero--${watch.status}`} aria-labelledby="hero-title" data-testid="whatsapp-card" data-status={watch.status}>
      <div className="hero__icon" aria-hidden="true">
        <span className="hero__ring" />
        <PhoneIcon />
      </div>
      <div className="hero__body">
        <p className="hero__eyebrow">WhatsApp en este ordenador</p>
        <h2 className="hero__title" id="hero-title" aria-live="polite">
          {copy.title}
        </h2>
        <p className="hero__text">{watch.status === 'error' && watch.message ? watch.message : copy.text}</p>
        {listening ? (
          <div className="hero__meter" aria-label="Sonido que llega de WhatsApp" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={meter}>
            <span style={{ width: `${meter}%` }} />
          </div>
        ) : null}
        <div className="hero__actions">
          {watch.status === 'needs_setup' || watch.status === 'error' ? (
            <button type="button" className="button button--primary button--large" onClick={() => onOpenSettings('ajustes-audio')}>
              Conectar WhatsApp
            </button>
          ) : null}
          <label className="switch switch--light">
            <input
              type="checkbox"
              role="switch"
              checked={watch.enabled}
              onChange={(event) => actions.setAutoWhatsapp?.(event.target.checked)}
              data-testid="home-auto-switch"
            />
            <span className="switch__track" aria-hidden="true" />
            <span className="switch__text">
              <strong>Entrada automática</strong>
            </span>
          </label>
        </div>
      </div>
    </section>
  );
}

/** Three steps, ticked as they get done. Hidden once everything is ready (a single green line stays). */
function SetupGuide({ state, onOpenSettings }: HomePanelProps) {
  const { actions } = useCall();
  const status = state.systemStatus;
  const keysOk = keyReady(status?.elevenlabs) && keyReady(status?.translator);
  const keysDown = status?.elevenlabs === 'down' || status?.translator === 'down';
  const cablesOk = state.watch.status !== 'needs_setup';
  const autoOk = state.watch.enabled;
  const steps = [
    {
      done: keysOk && !keysDown,
      title: 'Pon tus claves de ElevenLabs y Anthropic',
      text: keysDown
        ? 'Una clave falló al probarla. Revísala en Ajustes.'
        : keysOk
          ? 'Claves guardadas.'
          : 'Sin ellas no se puede traducir: oirías la voz original sin traducir.',
      action: { label: keysOk ? 'Revisar' : 'Poner claves', run: () => onOpenSettings('ajustes-claves') },
    },
    {
      done: cablesOk,
      title: 'Conecta WhatsApp con los dos cables de audio',
      text: cablesOk ? 'Cables elegidos.' : 'La guía de Ajustes te dice qué instalar y qué elegir en WhatsApp.',
      action: { label: cablesOk ? 'Revisar' : 'Conectar', run: () => onOpenSettings('ajustes-audio') },
    },
    {
      done: autoOk,
      title: 'Deja activada la entrada automática',
      text: autoOk ? 'Las llamadas de WhatsApp entran solas.' : 'Así no tienes que pulsar nada cuando te llamen.',
      action: autoOk ? null : { label: 'Activar', run: () => actions.setAutoWhatsapp?.(true) },
    },
  ];
  const remaining = steps.filter((step) => !step.done).length;
  if (remaining === 0) {
    return (
      <p className="ready-line" data-testid="setup-ready">
        <CheckIcon /> Todo listo. Usa auriculares y contesta en WhatsApp como siempre.
      </p>
    );
  }
  return (
    <section className="card setup" aria-labelledby="setup-title" data-testid="setup-guide">
      <header className="card__header">
        <div>
          <h2 className="card__title" id="setup-title">
            Empezar en 3 pasos
          </h2>
          <p className="card__subtitle">{remaining === 1 ? 'Te falta 1 paso.' : `Te faltan ${remaining} pasos.`}</p>
        </div>
      </header>
      <ol className="setup__steps">
        {steps.map((step, index) => (
          <li key={step.title} className={`setup__step${step.done ? ' setup__step--done' : ''}`} data-done={step.done}>
            <span className="setup__badge" aria-hidden="true">
              {step.done ? <CheckIcon /> : index + 1}
            </span>
            <span className="setup__text">
              <strong>{step.title}</strong>
              <span className="muted small">{step.text}</span>
            </span>
            {step.action ? (
              <button type="button" className={`button button--small${step.done ? ' button--ghost' : ' button--primary'}`} onClick={step.action.run}>
                {step.action.label}
              </button>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

const TEST_CALL_OUTCOMES: Record<SimulatedCallResult['outcome'], string> = {
  completed: 'La llamada de prueba ha terminado. Puedes verla en el historial.',
  not_answered: 'Nadie contestó la llamada de prueba.',
  rejected: 'La llamada de prueba se rechazó (todas las líneas ocupadas o ningún operador libre).',
  ended_early: 'La llamada de prueba terminó antes de tiempo.',
  unsupported: 'La llamada de prueba no está disponible.',
};

/** Embedded server only: a simulated English-speaking passenger calls, to see the screens with no phone at all. */
export function TestCallCard() {
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function start(): Promise<void> {
    setRunning(true);
    setMessage(null);
    const result = await requestSimulatedCall();
    setRunning(false);
    if (result) setMessage(result.message ?? TEST_CALL_OUTCOMES[result.outcome]);
  }
  return (
    <div className="card mini-card" data-testid="test-call-card">
      <div className="mini-card__text">
        <h2 className="card__title">
          Ver cómo funciona <span className="badge badge--simulated">Simulado</span>
        </h2>
        <p className="muted small">Un pasajero de prueba llama en inglés y verás la traducción en pantalla. No usa tus claves ni WhatsApp.</p>
      </div>
      <button type="button" className="button" disabled={running} onClick={() => void start()}>
        {running ? 'Llamada en curso…' : 'Recibir llamada de prueba'}
      </button>
      {message ? (
        <p className="notice notice--info" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

/** Desktop app home: what WhatsApp is doing, the setup steps, a test call and the manual start. */
export function HomePanel(props: HomePanelProps) {
  const { state } = props;
  const connected = state.connection === 'connected';
  return (
    <section className="page home" aria-label="Inicio" data-testid="idle-panel">
      <WhatsAppCard {...props} />
      <SetupGuide {...props} />
      <div className="home__grid">
        {connected && canSimulateCall() ? <TestCallCard /> : null}
        {state.server?.localAudio ? (
          <details className="card manual-start">
            <summary>
              <strong>Empezar la traducción a mano</strong>
              <span className="muted small"> · si la entrada automática está apagada</span>
            </summary>
            <LocalCallStart />
          </details>
        ) : null}
      </div>
    </section>
  );
}
