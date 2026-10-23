import './settings.css';
import { useCall } from '../core/CallContext';
import { useSession } from '../core/session';
import { AudioSection } from './AudioSection';
import { KeysSection } from './KeysSection';
import { LanguagesSection } from './LanguagesSection';
import { ServerSection } from './ServerSection';

/** Settings: keys (admin), languages and preferences, audio devices, server. */
export function SettingsPage() {
  const session = useSession();
  const { state } = useCall();
  if (!session) return null;
  const isAdmin = session.operator.role === 'admin';
  const server = state.server;
  const simulatedProviders = server?.providers === 'mock';
  const simulatedChannel = server?.channel === 'mock';

  return (
    <section className="page settings" aria-labelledby="settings-title" data-testid="settings">
      <header className="page__header">
        <h2 className="page__title" id="settings-title">
          Ajustes
        </h2>
        <nav aria-label="Secciones de ajustes" className="settings__nav">
          {isAdmin ? <a href="#ajustes-claves">Claves</a> : null}
          <a href="#ajustes-idiomas">Idiomas</a>
          <a href="#ajustes-audio">Audio</a>
          <a href="#ajustes-servidor">Servidor</a>
        </nav>
      </header>

      {simulatedProviders || simulatedChannel ? (
        <p className="notice notice--simulated" role="note" data-testid="settings-simulated">
          <span className="badge badge--simulated">Simulado</span>{' '}
          {simulatedProviders && simulatedChannel
            ? 'Este servidor usa voz, traducción y teléfono simulados: nada de lo que ocurra aquí llega a un servicio real.'
            : simulatedProviders
              ? 'Este servidor usa voz y traducción simuladas: las llamadas no se transcriben ni traducen con servicios reales.'
              : 'Este servidor usa un teléfono simulado: no entra ni sale ninguna llamada real.'}
        </p>
      ) : null}

      {isAdmin ? (
        <KeysSection />
      ) : (
        <p className="notice notice--info" data-testid="keys-admin-only">
          Las claves de los servicios y las pruebas de conexión solo las puede ver y cambiar un administrador.
        </p>
      )}
      <LanguagesSection isAdmin={isAdmin} />
      <AudioSection />
      <ServerSection session={session} />
    </section>
  );
}
