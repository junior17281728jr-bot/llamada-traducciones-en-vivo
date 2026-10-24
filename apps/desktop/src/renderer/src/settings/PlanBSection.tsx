import { useEffect, useId, useState } from 'react';
import { DEFAULT_APP_SETTINGS, type AppSettings, type ConnectionTestResult, type VoicesResponse } from '@tw/shared';
import { describeApiError, logoutIfSessionExpired } from '../app/errors';
import { api } from '../core/http';

const DEFAULT_VOICE = '';

/**
 * Admin only. The ElevenLabs voice that reads the translations, and the plan B for when ElevenLabs fails:
 * the computer's own voice reads the translation, or the original voice is passed through untranslated.
 */
export function PlanBSection() {
  const ids = { voice: useId(), system: useId(), original: useId() };
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [voices, setVoices] = useState<VoicesResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [test, setTest] = useState<{ running: boolean; result: ConnectionTestResult | null; error: string | null }>({ running: false, result: null, error: null });

  const loadVoices = (): void => {
    setVoices(null);
    api
      .listVoices()
      .then(setVoices)
      .catch((cause: unknown) => {
        if (logoutIfSessionExpired(cause)) return;
        setVoices({ source: 'unavailable', voices: [], message: describeApiError(cause, 'No se pudo pedir la lista de voces') });
      });
  };

  useEffect(() => {
    let cancelled = false;
    api
      .getAppSettings()
      .then((value) => {
        if (!cancelled) setSettings(value);
      })
      .catch((cause: unknown) => {
        if (cancelled || logoutIfSessionExpired(cause)) return;
        setLoadError(describeApiError(cause, 'No se pudieron cargar los ajustes de voz'));
        setSettings({ ...DEFAULT_APP_SETTINGS });
      });
    loadVoices();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(next: AppSettings): Promise<void> {
    setSettings(next);
    setSaving(true);
    setMessage(null);
    try {
      setSettings(await api.putAppSettings(next));
      setMessage({ tone: 'ok', text: 'Guardado. Se aplica desde la próxima llamada.' });
    } catch (cause) {
      if (logoutIfSessionExpired(cause)) return;
      setMessage({ tone: 'danger', text: describeApiError(cause, 'No se pudo guardar') });
    } finally {
      setSaving(false);
    }
  }

  async function testSystemVoice(): Promise<void> {
    setTest({ running: true, result: null, error: null });
    try {
      setTest({ running: false, result: await api.testService('system-voice'), error: null });
    } catch (cause) {
      if (logoutIfSessionExpired(cause)) return;
      setTest({ running: false, result: null, error: describeApiError(cause, 'No se pudo probar la voz del ordenador') });
    }
  }

  const current = settings ?? DEFAULT_APP_SETTINGS;
  const selected = current.voiceId ?? DEFAULT_VOICE;
  const listed = voices?.voices ?? [];
  const unknownSaved = current.voiceId !== null && voices?.source === 'elevenlabs' && !listed.some((voice) => voice.id === current.voiceId);

  return (
    <section className="card settings__section" id="ajustes-voz" aria-labelledby="planb-title" data-testid="planb-section">
      <header className="card__header">
        <div>
          <h2 className="card__title" id="planb-title">
            Voz y plan B
          </h2>
          <p className="card__subtitle">Qué voz lee las traducciones y qué hacer si ElevenLabs falla en mitad de una llamada.</p>
        </div>
      </header>

      {loadError ? (
        <p className="notice notice--danger" role="alert">
          {loadError}
        </p>
      ) : null}

      <div className="field">
        <label className="field__label" htmlFor={ids.voice}>
          Voz de ElevenLabs
        </label>
        <select
          id={ids.voice}
          value={selected}
          disabled={!settings || saving}
          onChange={(event) => void save({ ...current, voiceId: event.target.value === DEFAULT_VOICE ? null : event.target.value })}
          data-testid="voice-select"
        >
          <option value={DEFAULT_VOICE}>Voz por defecto (George, multilingüe)</option>
          {unknownSaved && current.voiceId ? <option value={current.voiceId}>Voz guardada ({current.voiceId})</option> : null}
          {listed.map((voice) => (
            <option key={voice.id} value={voice.id}>
              {voice.name}
              {voice.description ? ` · ${voice.description}` : ''}
            </option>
          ))}
        </select>
        <span className="field__hint">
          {voices === null
            ? 'Buscando las voces de tu cuenta…'
            : voices.source === 'elevenlabs'
              ? `${listed.length} voces de tu cuenta. La misma voz habla todos los idiomas.`
              : (voices.message ?? 'No se pudo ver la lista de voces.')}{' '}
          <button type="button" className="link-button" onClick={loadVoices}>
            Volver a buscar
          </button>
        </span>
      </div>

      <div className="switch-list">
        <label className="switch" htmlFor={ids.system}>
          <input
            id={ids.system}
            type="checkbox"
            role="switch"
            checked={current.fallbackSystemVoice}
            disabled={!settings || saving}
            onChange={(event) => void save({ ...current, fallbackSystemVoice: event.target.checked })}
            data-testid="planb-system-voice"
          />
          <span className="switch__track" aria-hidden="true" />
          <span className="switch__text">
            <strong>Si falla la voz de ElevenLabs, que lea la voz del ordenador</strong>
            <span className="muted small">La voz de Mac o Windows lee la traducción. Funciona sin internet y sin clave.</span>
          </span>
        </label>
        <label className="switch" htmlFor={ids.original}>
          <input
            id={ids.original}
            type="checkbox"
            role="switch"
            checked={current.fallbackOriginalVoice}
            disabled={!settings || saving}
            onChange={(event) => void save({ ...current, fallbackOriginalVoice: event.target.checked })}
            data-testid="planb-original-voice"
          />
          <span className="switch__track" aria-hidden="true" />
          <span className="switch__text">
            <strong>Si no se puede traducir, pasar la voz original</strong>
            <span className="muted small">Mientras la transcripción o la traducción no respondan, os oís directamente, sin traducir. Vuelve sola cuando el servicio responde.</span>
          </span>
        </label>
      </div>

      <div className="row">
        <button type="button" className="button button--small" onClick={() => void testSystemVoice()} disabled={test.running} data-testid="test-system-voice">
          {test.running ? 'Probando…' : 'Probar la voz del ordenador'}
        </button>
        <span className="muted small">Genera una frase en español con la voz de este ordenador (no suena: solo comprueba que funciona).</span>
      </div>
      {test.result ? (
        <p className={`notice notice--${test.result.status === 'ok' ? 'ok' : test.result.status === 'fail' ? 'danger' : 'warn'}`} role="status" data-testid="test-result-system-voice">
          {test.result.message}
        </p>
      ) : null}
      {test.error ? (
        <p className="notice notice--danger" role="alert">
          {test.error}
        </p>
      ) : null}
      {message ? (
        <p className={`notice notice--${message.tone}`} role={message.tone === 'danger' ? 'alert' : 'status'} data-testid="planb-message">
          {message.text}
        </p>
      ) : null}
    </section>
  );
}
