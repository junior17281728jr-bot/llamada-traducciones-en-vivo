/**
 * @tw/server: servidor puente (canales de llamada, sesiones de llamada, operadores por WebSocket,
 * historial, grabaciones, claves y ajustes).
 */
export const SERVER_PACKAGE = '@tw/server' as const;

export { createApplication, type Application, type ApplicationOverrides } from './application.js';
export { CallManager, type CallManagerDeps } from './call-manager.js';
export { CallSession, type OperatorLink } from './call-session.js';
export { MockCallChannel, MockPhone, MockChannelCall } from './channel/mock-channel.js';
export { DesktopAudioChannel, DesktopAudioCall, type LocalCallChannel, type StartLocalCallOptions } from './channel/desktop-audio.js';
export { ConfigError, loadConfig, type ServerConfig } from './config.js';
export { loadDotEnv, parseDotEnv, applyDotEnv, type LoadDotEnvResult } from './dotenv.js';
export { createProviders, NotConfiguredError, type Providers } from './providers.js';
export { createTelecomwayServer, type RunningServer } from './server.js';
export {
  startEmbeddedServer,
  simulatePassengerCall,
  DEFAULT_TEST_CALL,
  type EmbeddedServer,
  type EmbeddedServerOptions,
  type SimulatedCallOptions,
  type SimulatedCallOutcome,
  type SimulatedLine,
} from './embedded.js';
