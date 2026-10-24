import './settings.css';
import { useCall } from '../core/CallContext';
import { useSession } from '../core/session';
import { AudioSection } from './AudioSection';
import { KeysSection } from './KeysSection';
import { LanguagesSection } from './LanguagesSection';
import { PlanBSection } from './PlanBSection';
import { ServerSection } from './ServerSection';

/**
 * Settings. In the desktop app (PROVIDERS=auto): keys of ElevenLabs and Anthropic, voice and plan B, audio and
 * WhatsApp, languages. A separate server also shows the telephony keys and the server address.
 */
export function SettingsPage() {
  const session = useSession();
  const { state } = useCall();
  if (!session) return null;
  const isAdmin = session.operator.role === 'admin';
  const server = state.server;
  const desktop = server?.providers === 'auto';
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
          {isAdmin && !simulatedProviders ? <a href="#ajustes-voz">Voz y plan B</a> : null}
          <a href="#ajustes-audio">Audio y WhatsApp</a>
          <a href="#ajustes-idiomas">Idiomas</a>
          {!desktop ? <a href="#ajustes-servidor">Servidor</a> : null}
        </nav>
      </header>

      {desktop ? (
        <p className="notice notice--info" role="note" data-testid="settings-desktop">
          Las llamadas de WhatsApp de este ordenador se traducen de verdad con tus claves de ElevenLabs y Anthropic. Solo la «Llamada de prueba» es simulada.
        </p>
      ) : simulatedProviders || simulatedChannel ? (
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
        <KeysSection {...(desktop ? { services: ['elevenlabs', 'anthropic'] as const } : {})} />
      ) : (
        <p className="notice notice--info" data-testid="keys-admin-only">
          Las claves de los servicios y las pruebas de conexión solo las puede ver y cambiar un administrador.
        </p>
      )}
      {isAdmin && !simulatedProviders ? <PlanBSection /> : null}
      <AudioSection />
      <LanguagesSection isAdmin={isAdmin} />
      {!desktop ? <ServerSection session={session} /> : null}
    </section>
  );
}
