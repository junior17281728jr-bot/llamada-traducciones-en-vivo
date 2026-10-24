import './call.css';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type { LanguageCode, PartialLanguageSettings } from '@tw/shared';
import { readAudioPref } from '../core/audio-prefs';
import { useCall } from '../core/CallContext';
import { useLanguageCatalog } from '../core/catalog';

const AUTO = 'auto';
export const DEFAULT_LOCAL_LABEL = 'WhatsApp';
/** Kept for the documentation: the cable path has only been exercised with synthetic audio, never with real WhatsApp. */
export const LOCAL_MODE_UNVERIFIED_WARNING = 'Este modo no está probado todavía con WhatsApp real ni con cables de audio reales.';

type DeviceKind = 'audioinput' | 'audiooutput';

interface DeviceDescription {
  state: 'missing' | 'found' | 'absent' | 'unknown';
  text: string;
}

/** What the card says about one saved device, honestly: chosen or not, connected or not, name known or not. */
export function describeDevice(savedId: string | null, kind: DeviceKind, devices: readonly MediaDeviceInfo[] | null): DeviceDescription {
  if (!savedId) return { state: 'missing', text: 'Sin elegir' };
  if (devices === null) return { state: 'unknown', text: 'Dispositivo guardado (este entorno no permite comprobar su nombre)' };
  const device = devices.find((candidate) => candidate.kind === kind && candidate.deviceId === savedId);
  if (!device) return { state: 'absent', text: 'Dispositivo guardado no conectado ahora' };
  return { state: 'found', text: device.label || 'Dispositivo sin nombre (permite el micrófono en Ajustes > Audio para verlo)' };
}

/** Language settings sent with `call.startLocal`: detection, or one language fixed for both senses (like the Marcador). */
export function localCallOptions(lang: string): { langHint?: string; languages: PartialLanguageSettings } {
  if (lang === AUTO) return { languages: { passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'follow' } } };
  const code = lang as LanguageCode;
  return { langHint: code, languages: { passengerSpeaks: { mode: 'fixed', lang: code }, passengerHears: { mode: 'fixed', lang: code } } };
}

/** Audio devices of this computer, or null when they cannot be listed. Re-read when devices change. */
function useAudioDevices(): MediaDeviceInfo[] | null {
  const [devices, setDevices] = useState<MediaDeviceInfo[] | null>(null);
  const refresh = useCallback((): void => {
    const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!media || typeof media.enumerateDevices !== 'function') {
      setDevices(null);
      return;
    }
    media
      .enumerateDevices()
      .then((list) => setDevices(list.filter((device) => device.kind === 'audioinput' || device.kind === 'audiooutput')))
      .catch(() => setDevices(null));
  }, []);
  useEffect(() => {
    refresh();
    const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!media || typeof media.addEventListener !== 'function') return undefined;
    media.addEventListener('devicechange', refresh);
    return () => media.removeEventListener('devicechange', refresh);
  }, [refresh]);
  return devices;
}

/** The two saved cable devices; re-read when the window regains focus (Settings may have changed them). */
function useCablePrefs(): { input: string | null; output: string | null } {
  const read = () => ({ input: readAudioPref('passengerInput'), output: readAudioPref('passengerOutput') });
  const [prefs, setPrefs] = useState(read);
  useEffect(() => {
    const refresh = (): void => setPrefs(read());
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return prefs;
}

/**
 * "Modo audio del PC": starts a translated session for a call the operator already has in another program
 * (WhatsApp Desktop or any other), using the two virtual-cable devices chosen in Ajustes > Audio. The server
 * never sees that call enter or end: the operator answers and hangs up in the other program.
 */
export function LocalCallStart() {
  const { state, actions } = useCall();
  const languages = useLanguageCatalog();
  const ids = { label: useId(), lang: useId() };
  const [label, setLabel] = useState(DEFAULT_LOCAL_LABEL);
  const [lang, setLang] = useState(AUTO);
  const prefs = useCablePrefs();
  const devices = useAudioDevices();

  const connected = state.connection === 'connected';
  const supported = state.server?.localAudio === true && actions.startLocal !== undefined;
  const inCall = state.call !== null && state.call.state !== 'ended';
  const input = describeDevice(prefs.input, 'audioinput', devices);
  const output = describeDevice(prefs.output, 'audiooutput', devices);
  const devicesMissing = input.state === 'missing' || output.state === 'missing';
  const blocked = !connected
    ? 'Sin conexión con el servidor: no se puede empezar la traducción.'
    : !supported
      ? 'Este servidor no admite el modo audio del PC.'
      : devicesMissing
        ? 'Faltan los dispositivos de los cables. Elígelos en Ajustes > Audio.'
        : inCall
          ? 'Ya tienes una llamada en curso. Termínala antes de empezar otra.'
          : state.watch.status === 'starting'
            ? 'La llamada de WhatsApp ya está entrando sola.'
            : null;
  const canStart = blocked === null && label.trim().length > 0;
  const options = languages.options('passengerSpeaks');
  const error = state.lastError;

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!canStart) return;
    actions.dismissError?.();
    actions.startLocal?.(label.trim(), localCallOptions(lang));
  }

  return (
    <form className="card local-start" aria-labelledby="local-start-title" data-testid="local-call-start" onSubmit={submit} noValidate>
      <header className="card__header">
        <div>
          <h2 className="card__title" id="local-start-title">
            Modo audio del PC
          </h2>
          <p className="card__subtitle">Traduce una llamada que ya tienes en otro programa, sin la API de WhatsApp.</p>
        </div>
      </header>

      <ol className="local-start__steps">
        <li>Contesta o haz la llamada en WhatsApp Desktop (o el programa que uses); el otro programa envía su sonido al cable A.</li>
        <li>Pulsa «Empezar traducción»: lo que diga el pasajero por el cable A se traduce y lo oyes en tus auriculares.</li>
        <li>Habla por tu micrófono normal: tu voz traducida sale por el cable B, que el otro programa usa como micrófono.</li>
      </ol>

      <p className="notice notice--info" role="note" data-testid="local-unverified">
        Usa auriculares: con altavoces la traducción vuelve a entrar por el micrófono.
      </p>

      <dl className="kv local-start__devices" data-testid="local-devices">
        <dt>Entrada con la voz del pasajero (cable A)</dt>
        <dd className={`local-start__device local-start__device--${input.state}`} data-testid="local-device-input">
          {input.text}
        </dd>
        <dt>Salida hacia el micrófono del otro programa (cable B)</dt>
        <dd className={`local-start__device local-start__device--${output.state}`} data-testid="local-device-output">
          {output.text}
        </dd>
      </dl>
      {devicesMissing ? (
        <p className="notice notice--warn" role="status" data-testid="local-devices-missing">
          Faltan dispositivos. Elígelos en Ajustes &gt; Audio.
        </p>
      ) : null}

      <div className="form-grid">
        <label className="field" htmlFor={ids.label}>
          <span className="field__label">Etiqueta (aparece en el historial)</span>
          <input id={ids.label} value={label} maxLength={64} onChange={(event) => setLabel(event.target.value)} disabled={inCall} />
        </label>
        <label className="field" htmlFor={ids.lang}>
          <span className="field__label">Idioma del pasajero</span>
          <select id={ids.lang} value={lang} onChange={(event) => setLang(event.target.value)} disabled={inCall}>
            <option value={AUTO}>Detección automática</option>
            {options.map((option) => (
              <option key={option.code} value={option.code}>
                {option.nameEs}
              </option>
            ))}
          </select>
        </label>
      </div>
      {languages.error ? <p className="notice notice--warn">No se pudo cargar la lista de idiomas: {languages.error}</p> : null}

      {blocked ? (
        <p className="notice notice--info" role="status" data-testid="local-blocked">
          {blocked}
        </p>
      ) : null}

      <div className="form-actions">
        <button type="submit" className="button button--ok button--large" disabled={!canStart}>
          Empezar traducción
        </button>
      </div>

      {error ? (
        <p className="notice notice--danger" role="alert" data-testid="local-error">
          {error.message}{' '}
          <button type="button" className="button button--small" onClick={() => actions.dismissError?.()}>
            Entendido
          </button>
        </p>
      ) : null}
    </form>
  );
}
