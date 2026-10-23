import { useEffect, useId, useState } from 'react';
import {
  LANGUAGE_MODES,
  LANGUAGE_MODE_LABELS_ES,
  type LanguageCode,
  type LanguageRole,
  type OperatorPreferences,
} from '@tw/shared';
import { asApiFailure, describeApiError, logoutIfSessionExpired } from '../app/errors';
import { formatDateTime } from '../app/format';
import { CATALOG_SOURCE_LABELS, MODE_HELP, langName } from '../app/labels';
import { useLanguageCatalog, type UseLanguageCatalog } from '../core/catalog';
import { api } from '../core/http';

interface PreferenceSelectProps {
  id: string;
  label: string;
  value: LanguageCode | null;
  role: LanguageRole;
  languages: UseLanguageCatalog;
  /** Label of the "no preference" option; omit for a required language. */
  nullLabel?: string;
  hint?: string;
  disabled?: boolean;
  onChange: (code: LanguageCode | null) => void;
}

/** Offers ONLY the languages the catalogue confirms for the role; a saved language outside it shows as unavailable. */
function PreferenceSelect({ id, label, value, role, languages, nullLabel, hint, disabled, onChange }: PreferenceSelectProps) {
  const options = languages.options(role);
  const known = value === null || options.some((option) => option.code === value);
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        value={value ?? ''}
        disabled={disabled || languages.catalog === null}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.value ? (event.target.value as LanguageCode) : null)}
      >
        {nullLabel !== undefined ? <option value="">{nullLabel}</option> : null}
        {!known && value ? (
          <option value={value} disabled>
            {langName(value)} (no disponible)
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.code} value={option.code}>
            {option.nameEs}
          </option>
        ))}
      </select>
      {hint ? (
        <span className="field__hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

interface LanguagesSectionProps {
  isAdmin: boolean;
}

/** Catalogue source and date (with the admin refresh) and the operator's language preferences. */
export function LanguagesSection({ isAdmin }: LanguagesSectionProps) {
  const languages = useLanguageCatalog();
  const ids = { operator: useId(), speaks: useId(), hears: useId(), auto: useId() };
  const [prefs, setPrefs] = useState<OperatorPreferences | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getPreferences()
      .then((response) => {
        if (!cancelled) setPrefs(response);
      })
      .catch((cause: unknown) => {
        if (cancelled || logoutIfSessionExpired(cause)) return;
        setLoadError(describeApiError(cause, 'No se pudieron cargar tus preferencias'));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(): Promise<void> {
    if (!prefs) return;
    setSaving(true);
    setMessage(null);
    try {
      const saved = await api.putPreferences(prefs);
      setPrefs(saved);
      setMessage({ tone: 'ok', text: 'Preferencias guardadas. Se aplican a partir de la próxima llamada.' });
    } catch (cause) {
      if (logoutIfSessionExpired(cause)) return;
      const failure = asApiFailure(cause);
      setMessage({
        tone: 'danger',
        text: failure.code === 'unsupported_language' ? failure.message : describeApiError(cause, 'No se pudieron guardar las preferencias'),
      });
    } finally {
      setSaving(false);
    }
  }

  async function refresh(): Promise<void> {
    setRefreshing(true);
    setRefreshMessage(null);
    try {
      const catalog = await api.refreshLanguages();
      languages.reload();
      setRefreshMessage({
        tone: 'ok',
        text:
          catalog.source === 'live'
            ? `Lista actualizada con una consulta en vivo (${formatDateTime(catalog.fetchedAt)}).`
            : 'El servidor no pudo consultar ElevenLabs (sin clave o sin respuesta) y mantiene la lista de la documentación.',
      });
    } catch (cause) {
      if (logoutIfSessionExpired(cause)) return;
      setRefreshMessage({ tone: 'danger', text: describeApiError(cause, 'No se pudo actualizar la lista') });
    } finally {
      setRefreshing(false);
    }
  }

  const catalog = languages.catalog;
  const counts = catalog
    ? {
        speaks: languages.options('passengerSpeaks').length,
        voice: languages.options('passengerVoice').length,
        operator: languages.options('operatorLanguage').length,
      }
    : null;

  return (
    <section className="card settings__section" id="ajustes-idiomas" aria-labelledby="languages-title" data-testid="languages-section">
      <header className="card__header">
        <h2 className="card__title" id="languages-title">
          Idiomas
        </h2>
      </header>

      <div className="stack stack--tight">
        <h3 className="section-title">Lista de idiomas disponibles</h3>
        {catalog ? (
          <dl className="kv" data-testid="catalog-info">
            <dt>Fuente</dt>
            <dd>
              {CATALOG_SOURCE_LABELS[catalog.source]}
              {catalog.source === 'documentation' ? <span className="chip chip--warn chip--spaced">Sin verificar</span> : null}
            </dd>
            <dt>Fecha</dt>
            <dd>{formatDateTime(catalog.fetchedAt)}</dd>
            <dt>Idiomas ofrecidos</dt>
            <dd>
              {counts!.speaks} que el pasajero puede hablar · {counts!.voice} con voz para el pasajero · {counts!.operator} para el operador
            </dd>
          </dl>
        ) : languages.error ? (
          <p className="notice notice--danger" role="alert">
            No se pudo cargar la lista de idiomas: {languages.error}
          </p>
        ) : (
          <p className="loading">Cargando la lista…</p>
        )}
        <p className="muted small">Solo se ofrecen los idiomas que la transcripción, el traductor y la voz confirman a la vez.</p>
        {isAdmin ? (
          <div className="row">
            <button type="button" className="button" onClick={() => void refresh()} disabled={refreshing} data-testid="refresh-languages">
              {refreshing ? 'Consultando…' : 'Actualizar con una consulta en vivo'}
            </button>
            <span className="muted small">Pide al servidor que consulte ElevenLabs; necesita la clave de ElevenLabs.</span>
          </div>
        ) : null}
        {refreshMessage ? (
          <p className={`notice notice--${refreshMessage.tone}`} role="status">
            {refreshMessage.text}
          </p>
        ) : null}
      </div>

      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        aria-label="Preferencias de idiomas"
      >
        <h3 className="section-title">Tus preferencias</h3>
        {loadError ? (
          <p className="notice notice--danger" role="alert">
            {loadError}
          </p>
        ) : null}
        {prefs ? (
          <>
            <div className="form-grid">
              <PreferenceSelect
                id={ids.operator}
                label="Tu idioma"
                value={prefs.operatorLang}
                role="operatorLanguage"
                languages={languages}
                hint="El idioma en que hablas y en que oyes la traducción."
                disabled={saving}
                onChange={(code) => code && setPrefs({ ...prefs, operatorLang: code })}
              />
              <div className="field">
                <span className="field__label">Modo por defecto</span>
                <div role="radiogroup" aria-label="Modo por defecto" className="segmented">
                  {LANGUAGE_MODES.map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      role="radio"
                      aria-checked={prefs.defaultMode === candidate}
                      className={`segmented__option${prefs.defaultMode === candidate ? ' segmented__option--on' : ''}`}
                      disabled={saving}
                      onClick={() => setPrefs({ ...prefs, defaultMode: candidate })}
                    >
                      {LANGUAGE_MODE_LABELS_ES[candidate]}
                    </button>
                  ))}
                </div>
                <span className="field__hint">{MODE_HELP[prefs.defaultMode]}</span>
              </div>
              <PreferenceSelect
                id={ids.speaks}
                label="Idioma del pasajero por defecto"
                value={prefs.defaultPassengerSpeaks}
                role="passengerSpeaks"
                languages={languages}
                nullLabel="Sin preferencia (se usa inglés)"
                hint="Se usa en el modo Manual."
                disabled={saving}
                onChange={(code) => setPrefs({ ...prefs, defaultPassengerSpeaks: code })}
              />
              <PreferenceSelect
                id={ids.hears}
                label="Idioma de la voz por defecto"
                value={prefs.defaultPassengerHears}
                role="passengerVoice"
                languages={languages}
                nullLabel="Igual que el idioma que habla"
                hint="Idioma en que el pasajero te oye en los modos Manual y Mixto."
                disabled={saving}
                onChange={(code) => setPrefs({ ...prefs, defaultPassengerHears: code })}
              />
            </div>
            <label className="field field--check" htmlFor={ids.auto}>
              <input
                id={ids.auto}
                type="checkbox"
                checked={prefs.autoAccept}
                disabled={saving}
                onChange={(event) => setPrefs({ ...prefs, autoAccept: event.target.checked })}
              />
              <span>Contestar automáticamente las llamadas entrantes</span>
            </label>
            {message ? (
              <p className={`notice notice--${message.tone}`} role={message.tone === 'danger' ? 'alert' : 'status'} data-testid="preferences-message">
                {message.text}
              </p>
            ) : null}
            <div className="form-actions">
              <button type="submit" className="button button--primary" disabled={saving}>
                {saving ? 'Guardando…' : 'Guardar preferencias'}
              </button>
            </div>
          </>
        ) : !loadError ? (
          <p className="loading">Cargando tus preferencias…</p>
        ) : null}
      </form>
    </section>
  );
}
