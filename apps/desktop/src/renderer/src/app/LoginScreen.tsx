import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { api } from '../core/http';
import {
  FALLBACK_SERVER_URL,
  defaultServerUrl,
  normalizeServerUrl,
  readDesktopConfig,
  setSession,
  type DesktopConfig,
} from '../core/session';
import { describeLoginError } from './errors';

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const PLATFORM_LABELS: Record<string, string> = { win32: 'Windows', darwin: 'Mac', linux: 'Linux' };

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Plain `http://` to another machine: passwords, tokens, transcripts and audio would cross the network unencrypted. */
export function isInsecureRemoteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Login form: server URL (last used, else the one the Electron shell reports, else the local default),
 * user and password. On success the session is stored and the shell takes over.
 */
export function LoginScreen() {
  const ids = { server: useId(), hint: useId(), user: useId(), password: useId(), error: useId() };
  const [serverUrl, setServerUrl] = useState(() => defaultServerUrl());
  /** True once the user typed in the server field: the desktop config must not overwrite it. */
  const serverEdited = useRef(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [desktop, setDesktop] = useState<DesktopConfig | null>(null);

  const [autoLogin, setAutoLogin] = useState(false);
  const autoTried = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void readDesktopConfig().then(async (config) => {
      if (cancelled || !config) return;
      setDesktop(config);
      // The app's own embedded server: sign in with the local login it created, no typing needed.
      if (config.embedded && !autoTried.current) {
        autoTried.current = true;
        setAutoLogin(true);
        const url = normalizeServerUrl(config.serverUrl);
        try {
          const response = await api.login(url, config.embedded);
          if (!cancelled) setSession({ serverUrl: url, token: response.token, expiresAt: response.expiresAt, operator: response.operator });
        } catch (cause) {
          if (!cancelled) setError(describeLoginError(cause, url));
        } finally {
          if (!cancelled) setAutoLogin(false);
        }
        return;
      }
      // The shell's URL (TW_SERVER_URL) beats the built-in default, never a URL the user typed or used before.
      setServerUrl((current) =>
        !serverEdited.current && current === FALLBACK_SERVER_URL && config.serverUrl ? normalizeServerUrl(config.serverUrl) : current,
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmedUrl = normalizeServerUrl(serverUrl);
  const urlValid = isHttpUrl(trimmedUrl);
  const insecure = urlValid && isInsecureRemoteUrl(trimmedUrl);
  const canSubmit = !busy && urlValid && username.trim().length > 0 && password.length > 0;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit) {
      if (!urlValid) setError('La dirección del servidor debe empezar por http:// o https://');
      else setError('Escribe el usuario y la contraseña.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await api.login(trimmedUrl, { username: username.trim(), password });
      setSession({ serverUrl: trimmedUrl, token: response.token, expiresAt: response.expiresAt, operator: response.operator });
    } catch (cause) {
      setError(describeLoginError(cause, trimmedUrl));
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login" data-testid="login-screen">
      <form className="login__card card" onSubmit={(event) => void submit(event)} noValidate aria-busy={busy || autoLogin}>
        <header className="login__header">
          <h1 className="login__title">Telecomway</h1>
          <p className="login__subtitle">Traducción de voz en vivo para llamadas con pasajeros</p>
        </header>
        {autoLogin ? (
          <p className="notice notice--info" role="status" data-testid="auto-login">
            Entrando en el modo local de esta aplicación…
          </p>
        ) : null}

        <div className="field">
          <label className="field__label" htmlFor={ids.server}>
            Servidor
          </label>
          <input
            id={ids.server}
            type="url"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            value={serverUrl}
            aria-invalid={serverUrl.length > 0 && !urlValid}
            aria-describedby={error ? `${ids.hint} ${ids.error}` : ids.hint}
            onChange={(event) => {
              serverEdited.current = true;
              setServerUrl(event.target.value);
            }}
            disabled={busy}
          />
          <span className="field__hint" id={ids.hint}>
            Dirección del servidor Telecomway, por ejemplo http://127.0.0.1:8787
          </span>
          {insecure ? (
            <p className="notice notice--warn" role="status" data-testid="login-insecure-warning">
              <strong>Conexión sin cifrar.</strong> El servidor no está en este equipo y la dirección empieza por http://: la contraseña, las
              transcripciones y el audio viajarían por la red sin cifrar. Pon el servidor detrás de un proxy TLS y usa https://.
            </p>
          ) : null}
        </div>

        <label className="field" htmlFor={ids.user}>
          <span className="field__label">Usuario</span>
          <input
            id={ids.user}
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            disabled={busy}
            autoFocus
          />
        </label>

        <label className="field" htmlFor={ids.password}>
          <span className="field__label">Contraseña</span>
          <input
            id={ids.password}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
          />
        </label>

        {error ? (
          <p id={ids.error} className="notice notice--danger" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" className="button button--primary button--large button--block" disabled={busy}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>

        <p className="login__footer muted small">
          {desktop
            ? `Versión ${desktop.version} · ${PLATFORM_LABELS[desktop.platform] ?? desktop.platform}`
            : 'Ejecutándose en un navegador (sin la aplicación de escritorio)'}
        </p>
      </form>
    </main>
  );
}
