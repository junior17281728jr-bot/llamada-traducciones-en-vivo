import { useEffect, useState } from 'react';
import { api } from '../core/http';
import { clearSession, readDesktopConfig, type DesktopConfig, type Session } from '../core/session';

interface ServerSectionProps {
  session: Session;
}

/** Current server URL and the "change server" action, which logs out so the login form can take a new URL. */
export function ServerSection({ session }: ServerSectionProps) {
  const [desktop, setDesktop] = useState<DesktopConfig | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readDesktopConfig().then((config) => {
      if (!cancelled) setDesktop(config);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function changeServer(): Promise<void> {
    setLeaving(true);
    try {
      await api.logout();
    } catch {
      /* the local session goes away regardless */
    } finally {
      clearSession();
    }
  }

  return (
    <section className="card settings__section" id="ajustes-servidor" aria-labelledby="server-title" data-testid="server-section">
      <header className="card__header">
        <h2 className="card__title" id="server-title">
          Servidor
        </h2>
      </header>
      <dl className="kv">
        <dt>Dirección actual</dt>
        <dd className="mono" data-testid="server-url">
          {session.serverUrl}
        </dd>
        <dt>Sesión</dt>
        <dd>
          {session.operator.name} · caduca el {new Date(session.expiresAt).toLocaleString('es-ES')}
        </dd>
        {desktop ? (
          <>
            <dt>Aplicación</dt>
            <dd>
              Versión {desktop.version} · {desktop.platform}
            </dd>
          </>
        ) : null}
      </dl>
      {confirming ? (
        <div className="notice notice--warn" role="alertdialog" aria-label="Confirmar cambio de servidor">
          <p>Para cambiar de servidor hay que cerrar la sesión. Volverás a la pantalla de inicio con el campo de servidor editable.</p>
          <div className="notice__actions">
            <button type="button" className="button button--danger" onClick={() => void changeServer()} disabled={leaving}>
              {leaving ? 'Cerrando sesión…' : 'Cerrar sesión y cambiar'}
            </button>
            <button type="button" className="button" onClick={() => setConfirming(false)} disabled={leaving}>
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <div className="form-actions">
          <button type="button" className="button" onClick={() => setConfirming(true)} data-testid="change-server">
            Cambiar de servidor
          </button>
        </div>
      )}
    </section>
  );
}
