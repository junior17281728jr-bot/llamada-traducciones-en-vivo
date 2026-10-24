import { useEffect, useState } from 'react';
import type { ConnectionTestResult, KeysResponse, MaskedSecret, SecretKeyName, TestService } from '@tw/shared';
import { describeApiError, logoutIfSessionExpired } from '../app/errors';
import { formatDateTime, formatTime } from '../app/format';
import { CONNECTION_TEST_LABELS, SIMULATED_TEST_WARNING } from '../app/labels';
import { api } from '../core/http';

interface KeyField {
  name: SecretKeyName;
  label: string;
  hint?: string;
}

interface ServiceKeys {
  service: TestService;
  title: string;
  description: string;
  /** Where to get the key, in plain words. */
  help?: string;
  fields: KeyField[];
}

export const SERVICE_KEYS: ServiceKeys[] = [
  {
    service: 'elevenlabs',
    title: 'ElevenLabs',
    description: 'Escucha y habla (voz a texto y texto a voz).',
    help: 'Consíguela en elevenlabs.io: entra en tu cuenta > Developers > API Keys > Create. Dale permiso de voz a texto y texto a voz.',
    fields: [{ name: 'ELEVENLABS_API_KEY', label: 'Clave de API' }],
  },
  {
    service: 'anthropic',
    title: 'Anthropic',
    description: 'Traduce (Claude).',
    help: 'Consíguela en console.anthropic.com: API Keys > Create Key. Necesita saldo en la cuenta.',
    fields: [{ name: 'ANTHROPIC_API_KEY', label: 'Clave de API' }],
  },
  {
    service: 'twilio',
    title: 'Twilio',
    description: 'Llamadas telefónicas.',
    fields: [
      { name: 'TWILIO_ACCOUNT_SID', label: 'Account SID' },
      { name: 'TWILIO_AUTH_TOKEN', label: 'Auth token' },
    ],
  },
  {
    service: 'whatsapp',
    title: 'Meta (WhatsApp)',
    description: 'Llamadas por WhatsApp Business.',
    fields: [
      { name: 'META_ACCESS_TOKEN', label: 'Token de acceso' },
      { name: 'META_PHONE_NUMBER_ID', label: 'Phone number ID', hint: 'Identificador del número de WhatsApp Business (no es el número de teléfono).' },
    ],
  },
];

/** What the screen says about a stored secret. Never includes the value: only the last 4 characters the server reveals. */
export function maskedSecretText(secret: MaskedSecret | undefined): string {
  if (!secret || !secret.configured) return 'Sin configurar';
  if (secret.source === 'env') return secret.last4 ? `Desde variable de entorno (····${secret.last4})` : 'Desde variable de entorno';
  const tail = secret.last4 ? ` ····${secret.last4}` : '';
  const when = secret.savedAt ? `, guardada el ${formatDateTime(secret.savedAt)}` : '';
  return `Configurada${tail}${when}`;
}

type TestState = { kind: 'running' } | { kind: 'done'; result: ConnectionTestResult } | { kind: 'error'; message: string };

interface TestResultViewProps {
  state: TestState;
}

/** The `ConnectionTestResult` as the server sent it; `simulated` carries the literal warning that nothing real was contacted. */
function TestResultView({ state }: TestResultViewProps) {
  if (state.kind === 'running') return <p className="loading">Probando la conexión…</p>;
  if (state.kind === 'error') {
    return (
      <p className="notice notice--danger" role="alert">
        No se pudo ejecutar la prueba: {state.message}
      </p>
    );
  }
  const { result } = state;
  const tone = result.status === 'ok' ? 'ok' : result.status === 'fail' ? 'danger' : result.status === 'simulated' ? 'simulated' : 'warn';
  return (
    <div className={`notice notice--${tone} test-result`} role="status" data-testid={`test-result-${result.service}`} data-status={result.status}>
      <span className="notice__title">
        <span className={`chip chip--${tone === 'danger' ? 'down' : tone === 'ok' ? 'ok' : tone === 'simulated' ? 'simulated' : 'warn'}`}>
          {CONNECTION_TEST_LABELS[result.status]}
        </span>{' '}
        {result.status === 'ok' && result.latencyMs !== null ? <span className="mono">{Math.round(result.latencyMs)} ms</span> : null}
      </span>
      {result.status === 'simulated' ? <p>{SIMULATED_TEST_WARNING}</p> : null}
      <p>{result.message}</p>
      <p className="muted small">
        {result.contactedRealService ? 'Se contactó el servicio real.' : 'No se contactó ningún servicio real.'} Probado a las {formatTime(result.testedAt)}.
      </p>
    </div>
  );
}

/**
 * Admin only. Write-only secrets: the inputs start empty, nothing typed is ever echoed back and the
 * server only returns a mask (last 4 characters and date). "Guardar" sends the filled fields only;
 * "Borrar" sends an explicit null for one key.
 */
export function KeysSection({ services }: { services?: readonly TestService[] } = {}) {
  const groups = services ? SERVICE_KEYS.filter((group) => services.includes(group.service)) : SERVICE_KEYS;
  const [masks, setMasks] = useState<KeysResponse['keys'] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<SecretKeyName, string>>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger' | 'info'; text: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SecretKeyName | null>(null);
  const [tests, setTests] = useState<Partial<Record<TestService, TestState>>>({});

  useEffect(() => {
    let cancelled = false;
    api
      .getKeys()
      .then((response) => {
        if (!cancelled) setMasks(response.keys);
      })
      .catch((cause: unknown) => {
        if (cancelled || logoutIfSessionExpired(cause)) return;
        setLoadError(describeApiError(cause, 'No se pudo consultar el estado de las claves'));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filled = Object.entries(drafts).filter(([, value]) => value && value.trim().length > 0) as [SecretKeyName, string][];

  async function save(): Promise<void> {
    if (filled.length === 0) {
      setMessage({ tone: 'info', text: 'No has escrito ninguna clave nueva. Los campos vacíos no cambian nada.' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const response = await api.putKeys({ keys: Object.fromEntries(filled.map(([name, value]) => [name, value.trim()])) });
      setMasks(response.keys);
      setDrafts({});
      setMessage({ tone: 'ok', text: `Guardadas ${filled.length} clave(s). El valor no se vuelve a mostrar.` });
    } catch (cause) {
      if (logoutIfSessionExpired(cause)) return;
      setMessage({ tone: 'danger', text: describeApiError(cause, 'No se pudieron guardar las claves') });
    } finally {
      setSaving(false);
    }
  }

  async function remove(name: SecretKeyName): Promise<void> {
    setSaving(true);
    setMessage(null);
    try {
      const response = await api.putKeys({ keys: { [name]: null } });
      setMasks(response.keys);
      setDrafts((current) => ({ ...current, [name]: '' }));
      setMessage({ tone: 'ok', text: `Clave ${name} borrada del servidor.` });
    } catch (cause) {
      if (logoutIfSessionExpired(cause)) return;
      setMessage({ tone: 'danger', text: describeApiError(cause, 'No se pudo borrar la clave') });
    } finally {
      setSaving(false);
      setPendingDelete(null);
    }
  }

  async function test(service: TestService): Promise<void> {
    setTests((current) => ({ ...current, [service]: { kind: 'running' } }));
    try {
      const result = await api.testService(service);
      setTests((current) => ({ ...current, [service]: { kind: 'done', result } }));
    } catch (cause) {
      if (logoutIfSessionExpired(cause)) return;
      setTests((current) => ({ ...current, [service]: { kind: 'error', message: describeApiError(cause, 'error desconocido') } }));
    }
  }

  return (
    <section className="card settings__section" id="ajustes-claves" aria-labelledby="keys-title" data-testid="keys-section">
      <header className="card__header">
        <div>
          <h2 className="card__title" id="keys-title">
            Claves de los servicios
          </h2>
          <p className="card__subtitle">
            Solo escritura: se envían al servidor, se guardan cifradas y nunca se vuelven a mostrar. Un campo vacío no cambia nada. La clave guardada aquí
            tiene prioridad sobre la variable de entorno.
          </p>
        </div>
      </header>

      {loadError ? (
        <p className="notice notice--danger" role="alert">
          {loadError}
        </p>
      ) : null}

      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        autoComplete="off"
      >
        {groups.map((group) => {
          const testState = tests[group.service];
          return (
            <fieldset key={group.service} className="fieldset stack stack--tight" data-testid={`keys-${group.service}`}>
              <legend>
                {group.title} · {group.description}
              </legend>
              {group.help ? <p className="muted small key-help">{group.help}</p> : null}
              <div className="form-grid">
                {group.fields.map((field) => {
                  const mask = masks?.[field.name];
                  const inputId = `key-${field.name}`;
                  return (
                    <div key={field.name} className="field">
                      <label className="field__label" htmlFor={inputId}>
                        {field.label} <span className="mono muted">({field.name})</span>
                      </label>
                      <input
                        id={inputId}
                        type="password"
                        autoComplete="new-password"
                        spellCheck={false}
                        placeholder={mask?.configured ? 'Escribe un valor nuevo para sustituirla' : 'Sin configurar: escribe el valor'}
                        value={drafts[field.name] ?? ''}
                        onChange={(event) => setDrafts((current) => ({ ...current, [field.name]: event.target.value }))}
                        disabled={saving}
                      />
                      <span className="field__hint" data-testid={`mask-${field.name}`}>
                        {masks ? maskedSecretText(mask) : loadError ? 'Estado desconocido (no se pudo consultar)' : 'Consultando…'}
                      </span>
                      {field.hint ? <span className="field__hint">{field.hint}</span> : null}
                      {mask?.configured && mask.source === 'settings' ? (
                        pendingDelete === field.name ? (
                          <span className="row">
                            <span className="small">¿Borrar la clave guardada?</span>
                            <button type="button" className="button button--small button--danger" onClick={() => void remove(field.name)} disabled={saving}>
                              Sí, borrar
                            </button>
                            <button type="button" className="button button--small" onClick={() => setPendingDelete(null)}>
                              Cancelar
                            </button>
                          </span>
                        ) : (
                          <span>
                            <button type="button" className="button button--small button--ghost" onClick={() => setPendingDelete(field.name)} disabled={saving}>
                              Borrar
                            </button>
                          </span>
                        )
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <div className="row">
                <button
                  type="button"
                  className="button button--small"
                  onClick={() => void test(group.service)}
                  disabled={testState?.kind === 'running'}
                  data-testid={`test-${group.service}`}
                >
                  Probar conexión
                </button>
                <span className="muted small">La prueba usa lo que el servidor tiene ahora (incluida una clave recién guardada).</span>
              </div>
              {testState ? <TestResultView state={testState} /> : null}
            </fieldset>
          );
        })}

        {message ? (
          <p className={`notice notice--${message.tone}`} role={message.tone === 'danger' ? 'alert' : 'status'} data-testid="keys-message">
            {message.text}
          </p>
        ) : null}

        <div className="form-actions">
          <button type="submit" className="button button--primary" disabled={saving}>
            {saving ? 'Guardando…' : filled.length > 0 ? `Guardar ${filled.length} clave(s)` : 'Guardar'}
          </button>
          {filled.length > 0 ? (
            <button type="button" className="button button--ghost" onClick={() => setDrafts({})} disabled={saving}>
              Descartar lo escrito
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
