import {
  LANGUAGE_MODES,
  LANGUAGE_MODE_LABELS_ES,
  type LanguageCode,
  type LanguageMode,
  type LanguageRole,
} from '@tw/shared';
import type { UseLanguageCatalog } from '../core/catalog';
import type { ActiveCall, CallActions } from '../core/types';
import { langName, passengerHearsLabel, passengerLanguageLabel } from './labels';

const AUTO = 'auto';
const FOLLOW = 'follow';

const MODE_HELP: Record<LanguageMode, string> = {
  manual: 'Tú eliges los dos idiomas.',
  auto: 'Se detecta el idioma del pasajero y se le responde en ese idioma.',
  mixed: 'Se detecta lo que habla el pasajero, pero tú eliges el idioma en que te oye.',
};

interface LanguageSelectProps {
  id: string;
  label: string;
  value: string;
  /** Extra first option such as "Detección automática". */
  special?: { value: string; label: string };
  role: LanguageRole;
  languages: UseLanguageCatalog;
  onChange: (value: string) => void;
}

function LanguageSelect({ id, label, value, special, role, languages, onChange }: LanguageSelectProps) {
  const options = languages.options(role);
  const known = value === special?.value || options.some((option) => option.code === value);
  return (
    <label className="field" htmlFor={id}>
      <span className="field__label">{label}</span>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={languages.catalog === null}>
        {special ? <option value={special.value}>{special.label}</option> : null}
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
    </label>
  );
}

interface LanguagePanelProps {
  call: ActiveCall;
  actions: CallActions;
  languages: UseLanguageCatalog;
}

/**
 * Mode selector (Manual / Automático / Mixto), live language selectors and the warnings about the
 * detected language. Only languages the catalogue confirms are offered. Every change goes to the server
 * at once and applies to the NEXT phrases; the screen shows what the server confirms.
 */
export function LanguagePanel({ call, actions, languages }: LanguagePanelProps) {
  const { settings, mode, notice } = call;
  const ended = call.state === 'ended';
  const speaksValue = settings?.passengerSpeaks.mode === 'fixed' ? settings.passengerSpeaks.lang : AUTO;
  const hearsValue = settings?.passengerHears.mode === 'fixed' ? settings.passengerHears.lang : FOLLOW;
  const selectableSpoken = new Set(languages.options('passengerSpeaks').map((language) => language.code as string));

  const chooseSpoken = (code: string): void => {
    if (code === AUTO) actions.setLanguages({ passengerSpeaks: { mode: 'auto' } });
    else actions.setLanguages({ passengerSpeaks: { mode: 'fixed', lang: code as LanguageCode } });
  };
  const chooseHeard = (code: string): void => {
    if (code === FOLLOW) actions.setLanguages({ passengerHears: { mode: 'follow' } });
    else actions.setLanguages({ passengerHears: { mode: 'fixed', lang: code as LanguageCode } });
  };

  return (
    <section className="languages" aria-label="Idiomas de la llamada">
      <div className="languages__row">
        <div role="radiogroup" aria-label="Modo de idiomas" className="segmented">
          {LANGUAGE_MODES.map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-checked={mode === candidate}
              className={`segmented__option${mode === candidate ? ' segmented__option--on' : ''}`}
              disabled={ended || !settings}
              onClick={() => actions.setMode(candidate)}
            >
              {LANGUAGE_MODE_LABELS_ES[candidate]}
            </button>
          ))}
        </div>
        <p className="languages__help">{mode ? MODE_HELP[mode] : 'Esperando la configuración de idiomas…'}</p>
      </div>

      {settings ? (
        <div className="languages__selects">
          <LanguageSelect
            id="lang-operator"
            label="Tu idioma"
            value={settings.operatorLang}
            role="operatorLanguage"
            languages={languages}
            onChange={(code) => actions.setLanguages({ operatorLang: code as LanguageCode })}
          />
          <LanguageSelect
            id="lang-speaks"
            label="El pasajero habla"
            value={speaksValue}
            special={{ value: AUTO, label: 'Detección automática' }}
            role="passengerSpeaks"
            languages={languages}
            onChange={chooseSpoken}
          />
          <LanguageSelect
            id="lang-hears"
            label="El pasajero te oye en"
            value={hearsValue}
            special={{ value: FOLLOW, label: 'Su mismo idioma' }}
            role="passengerVoice"
            languages={languages}
            onChange={chooseHeard}
          />
        </div>
      ) : null}

      {settings ? (
        <p className="languages__summary" data-testid="language-summary">
          Pasajero: <strong>{passengerLanguageLabel(call)}</strong> · Tu voz: <strong>{langName(settings.operatorLang)}</strong> · Tu voz se traduce a:{' '}
          <strong>{passengerHearsLabel(call)}</strong>
        </p>
      ) : null}

      {languages.error ? <p className="notice notice--warn">No se pudo cargar la lista de idiomas: {languages.error}</p> : null}

      {notice?.kind === 'uncertain' ? (
        <div className="notice notice--warn" role="alert" data-testid="uncertain-notice">
          <p>
            <strong>No estoy seguro del idioma del pasajero.</strong> Elígelo para que la traducción siga bien.
          </p>
          <div className="notice__actions">
            {[...new Set([notice.candidates.stt, notice.candidates.translator, notice.lang])]
              .filter((code): code is string => Boolean(code) && selectableSpoken.has(code as string))
              .map((code) => (
                <button key={code} type="button" className="button button--small" onClick={() => chooseSpoken(code)}>
                  Es {langName(code)}
                </button>
              ))}
          </div>
        </div>
      ) : null}
      {notice?.kind === 'changed' ? (
        <p className="notice notice--info" role="status">
          El pasajero ha cambiado a <strong>{langName(notice.lang)}</strong>. Tus respuestas siguen ese idioma.
        </p>
      ) : null}
      {notice?.kind === 'fallback_used' ? (
        <p className="notice notice--warn" role="status">
          Aún no se conocía el idioma del pasajero y se ha usado <strong>{langName(notice.lang)}</strong>. Elígelo arriba si no es el correcto.
        </p>
      ) : null}
    </section>
  );
}
