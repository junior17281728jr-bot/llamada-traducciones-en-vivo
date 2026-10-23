import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  LANGUAGE_MODES,
  LANGUAGE_MODE_LABELS_ES,
  type LanguageCode,
  type LanguageMode,
  type LanguageRole,
  type PartialLanguageSettings,
} from '@tw/shared';
import { useCall } from '../core/CallContext';
import { useLanguageCatalog, type UseLanguageCatalog } from '../core/catalog';
import type { ClientError } from '../core/types';
import { MODE_HELP } from './labels';

/** Same rule as the server's `PhoneNumberSchema`: digits, spaces, parentheses, dots and dashes, optional leading +. */
const PHONE_PATTERN = /^\+?[0-9 ()\-.]+$/;

/** Returns the problem with a dialed number, or null when it can be sent. */
export function validatePhoneNumber(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return 'Escribe el número del pasajero.';
  if (value.length < 3) return 'El número es demasiado corto.';
  if (value.length > 32) return 'El número es demasiado largo.';
  if (!PHONE_PATTERN.test(value)) return 'Usa solo dígitos, espacios, paréntesis, puntos o guiones, con el prefijo internacional (+34…).';
  if (value.replace(/\D/g, '').length < 3) return 'El número necesita al menos tres dígitos.';
  return null;
}

/** Language settings to send with `call.dial` for the chosen mode. The operator language comes from the saved preferences. */
export function dialLanguages(mode: LanguageMode, speaks: LanguageCode | null, hears: LanguageCode | null): PartialLanguageSettings {
  switch (mode) {
    case 'auto':
      return { passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'follow' } };
    case 'manual': {
      const spoken = speaks ?? hears;
      return spoken
        ? { passengerSpeaks: { mode: 'fixed', lang: spoken }, passengerHears: { mode: 'fixed', lang: hears ?? spoken } }
        : {};
    }
    case 'mixed':
      return hears ? { passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'fixed', lang: hears } } : { passengerSpeaks: { mode: 'auto' } };
  }
}

/** Specific explanations for errors the server can answer to `call.dial`. */
export function dialErrorHelp(error: ClientError, maxCalls: number | null): string | null {
  switch (error.code) {
    case 'dial_permission_required':
      return (
        'WhatsApp solo permite llamar a un pasajero que haya dado permiso antes (el pasajero debe haberlo concedido desde su WhatsApp). ' +
        'Además hay un límite de 1 llamada al día y 2 por semana por pasajero. Pide al pasajero que te llame él, o que conceda el permiso y vuelve a intentarlo.'
      );
    case 'max_calls_reached':
      return `Ya hay ${maxCalls ?? 'todas las'} llamadas en curso, el máximo del sistema. Espera a que termine alguna antes de marcar.`;
    case 'operator_busy':
      return 'Ya tienes una llamada en curso. Cuélgala antes de marcar otra.';
    case 'invalid_number':
      return 'El servidor no acepta ese número. Usa solo dígitos, espacios, paréntesis, puntos o guiones, con el prefijo internacional (+34…).';
    case 'dial_failed':
      return 'No se pudo establecer la llamada. Inténtalo de nuevo; si sigue fallando, revisa el estado de «Llamadas» en la barra superior.';
    default:
      return null;
  }
}

interface LanguageSelectProps {
  id: string;
  label: string;
  value: string;
  role: LanguageRole;
  languages: UseLanguageCatalog;
  disabled?: boolean;
  onChange: (code: LanguageCode) => void;
}

/** Offers ONLY the languages the catalogue confirms for `role`. */
function LanguageSelect({ id, label, value, role, languages, disabled, onChange }: LanguageSelectProps) {
  const options = languages.options(role);
  return (
    <label className="field" htmlFor={id}>
      <span className="field__label">{label}</span>
      <select
        id={id}
        value={value}
        disabled={disabled || options.length === 0}
        onChange={(event) => onChange(event.target.value as LanguageCode)}
      >
        {options.length === 0 ? <option value="">{languages.loading ? 'Cargando idiomas…' : 'Sin idiomas disponibles'}</option> : null}
        {options.map((option) => (
          <option key={option.code} value={option.code}>
            {option.nameEs}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Keeps a language choice inside the selectable list: English when available, else the first option. */
function useLanguageChoice(languages: UseLanguageCatalog, role: LanguageRole): [LanguageCode | null, (code: LanguageCode) => void] {
  const [choice, setChoice] = useState<LanguageCode | null>(null);
  const options = languages.options(role);
  const valid = choice !== null && options.some((option) => option.code === choice);
  const fallback = options.find((option) => option.code === 'en')?.code ?? options[0]?.code ?? null;
  useEffect(() => {
    if (!valid && fallback && choice !== fallback) setChoice(fallback);
  }, [valid, fallback, choice]);
  return [valid ? choice : fallback, setChoice];
}

/**
 * Outbound calls: number, language mode (Manual / Automático / Mixto) and the language selectors the mode
 * needs. Dialing is disabled without a server connection or while another call is in progress.
 */
export function Dialer() {
  const { state, actions } = useCall();
  const languages = useLanguageCatalog();
  const ids = { number: useId(), hint: useId(), speaks: useId(), hears: useId(), error: useId() };
  const [number, setNumber] = useState('');
  const [touched, setTouched] = useState(false);
  const [mode, setMode] = useState<LanguageMode>('auto');
  const [speaks, setSpeaks] = useLanguageChoice(languages, 'passengerSpeaks');
  const [hears, setHears] = useLanguageChoice(languages, 'passengerVoice');
  const [lastDialed, setLastDialed] = useState<string | null>(null);
  /** True from "Llamar" until the server answers with a call state or an error (a second click must not dial twice). */
  const [dialing, setDialing] = useState(false);

  const connected = state.connection === 'connected';
  const inCall = state.call !== null && state.call.state !== 'ended';
  const numberProblem = validatePhoneNumber(number);
  const needsSpoken = mode === 'manual' && speaks === null;
  const needsHeard = mode !== 'auto' && hears === null;
  const maxCalls = state.presence?.maxCalls ?? state.server?.maxCalls ?? null;
  const activeCalls = state.presence?.activeCalls ?? null;
  const allBusy = maxCalls !== null && activeCalls !== null && activeCalls >= maxCalls;

  const blockedReason = !connected
    ? 'Sin conexión con el servidor: no se puede llamar.'
    : inCall
      ? 'Ya tienes una llamada en curso. Cuélgala antes de marcar otra.'
      : allBusy
        ? `Todas las líneas están ocupadas (${activeCalls} de ${maxCalls}).`
        : null;
  const canDial = blockedReason === null && numberProblem === null && !needsSpoken && !needsHeard && !dialing;

  const error = state.lastError;
  useEffect(() => {
    if (!dialing) return undefined;
    if (inCall || error || !connected) {
      setDialing(false);
      return undefined;
    }
    // No answer at all (should not happen): do not leave the button dead for ever.
    const timer = setTimeout(() => setDialing(false), 15_000);
    return () => clearTimeout(timer);
  }, [dialing, inCall, error, connected]);

  function submit(event: FormEvent): void {
    event.preventDefault();
    setTouched(true);
    if (!canDial) return;
    const trimmed = number.trim();
    actions.dismissError?.();
    setDialing(true);
    actions.dial(trimmed, dialLanguages(mode, speaks, hears));
    setLastDialed(trimmed);
  }

  const help = error ? dialErrorHelp(error, maxCalls) : null;

  return (
    <section className="page dialer" aria-labelledby="dialer-title" data-testid="dialer">
      <header className="page__header">
        <h2 className="page__title" id="dialer-title">
          Marcador
        </h2>
        {maxCalls !== null ? (
          <p className="muted small" data-testid="dialer-presence">
            Llamadas en curso: {activeCalls ?? 0} de {maxCalls}
          </p>
        ) : null}
      </header>

      <form className="card dialer__form" onSubmit={submit} noValidate>
        <div className="field">
          <label className="field__label" htmlFor={ids.number}>
            Número del pasajero
          </label>
          <input
            id={ids.number}
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="+34 600 000 000"
            value={number}
            className="dialer__number"
            aria-invalid={touched && numberProblem !== null}
            aria-describedby={touched && numberProblem ? ids.error : ids.hint}
            onChange={(event) => setNumber(event.target.value)}
            onBlur={() => setTouched(true)}
            disabled={inCall}
          />
          {touched && numberProblem ? (
            <span id={ids.error} className="field__error" role="alert">
              {numberProblem}
            </span>
          ) : (
            <span id={ids.hint} className="field__hint">
              Con prefijo internacional. Se permiten espacios, paréntesis y guiones.
            </span>
          )}
        </div>

        <fieldset className="fieldset stack stack--tight">
          <legend>Idiomas de la llamada</legend>
          <div role="radiogroup" aria-label="Modo de idiomas" className="segmented">
            {LANGUAGE_MODES.map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="radio"
                aria-checked={mode === candidate}
                className={`segmented__option${mode === candidate ? ' segmented__option--on' : ''}`}
                onClick={() => setMode(candidate)}
              >
                {LANGUAGE_MODE_LABELS_ES[candidate]}
              </button>
            ))}
          </div>
          <p className="muted small dialer__mode-help">{MODE_HELP[mode]}</p>

          {mode !== 'auto' ? (
            <div className="form-grid">
              {mode === 'manual' ? (
                <LanguageSelect
                  id={ids.speaks}
                  label="El pasajero habla"
                  value={speaks ?? ''}
                  role="passengerSpeaks"
                  languages={languages}
                  onChange={setSpeaks}
                />
              ) : null}
              <LanguageSelect
                id={ids.hears}
                label="El pasajero te oye en"
                value={hears ?? ''}
                role="passengerVoice"
                languages={languages}
                onChange={setHears}
              />
            </div>
          ) : null}
          <p className="muted small">Tu idioma es el que tienes guardado en Ajustes. Podrás cambiar cualquier idioma durante la llamada.</p>
          {languages.error ? <p className="notice notice--warn">No se pudo cargar la lista de idiomas: {languages.error}</p> : null}
        </fieldset>

        {blockedReason ? (
          <p className="notice notice--warn" role="status" data-testid="dialer-blocked">
            {blockedReason}
          </p>
        ) : null}

        <div className="form-actions">
          <button type="submit" className="button button--ok button--large" disabled={blockedReason !== null || needsSpoken || needsHeard || dialing}>
            {dialing ? 'Llamando…' : 'Llamar'}
          </button>
          {lastDialed && inCall ? <span className="muted small">Llamando a {lastDialed}… mira la pestaña Llamada.</span> : null}
        </div>
      </form>

      {error ? (
        <div className="notice notice--danger notice--large" role="alert" data-testid="dialer-error">
          <span className="notice__title">{error.message}</span>
          {help ? <p data-testid="dialer-error-help">{help}</p> : null}
          <div className="notice__actions">
            <button type="button" className="button button--small" onClick={() => actions.dismissError?.()}>
              Entendido
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
