import { randomBytes } from 'node:crypto';
import {
  DEFAULT_OPERATOR_PREFERENCES,
  type ConnectionTester,
  type LanguageCatalogProvider,
  type Logger,
  type ServerMessage,
} from '@tw/shared';
import { LoginRateLimiter, OperatorStore, SessionStore } from './auth.js';
import { CallManager } from './call-manager.js';
import { ElevenLabsCatalogProvider, type FetchLike } from './catalog.js';
import { MockCallChannel } from './channel/mock-channel.js';
import type { ServerConfig } from './config.js';
import { DefaultConnectionTester } from './connection-tester.js';
import { createLogger } from './logger.js';
import { createDebugHooks, createProviders, type Providers } from './providers.js';
import { createTelecomwayServer, type RunningServer } from './server.js';
import { FilePreferencesStore } from './stores/preferences.js';
import { FileRecordingStore } from './stores/recordings.js';
import { FileSecretsStore } from './stores/secrets.js';
import { FileTranscriptStore } from './stores/transcripts.js';

export interface Application extends RunningServer {
  manager: CallManager;
  operators: OperatorStore;
  /** Set when the first administrator was created with a generated password (shown once at startup). */
  generatedAdminPassword: string | null;
  purge(): Promise<{ calls: number; recordings: number }>;
}

export interface ApplicationOverrides {
  logger?: Logger;
  providers?: Providers;
  catalog?: LanguageCatalogProvider;
  tester?: ConnectionTester;
  fetch?: FetchLike;
}

/** Builds the whole server from a validated configuration. Nothing listens until `start()`. */
export async function createApplication(config: ServerConfig, overrides: ApplicationOverrides = {}): Promise<Application> {
  const logger = overrides.logger ?? createLogger();
  const fetchImpl = overrides.fetch ?? (globalThis.fetch as unknown as FetchLike);

  const operators = OperatorStore.inDataDir(config.dataDir);
  await operators.load();
  let generatedAdminPassword: string | null = null;
  if ((await operators.list()).length === 0) {
    generatedAdminPassword = config.adminPassword ?? randomBytes(9).toString('base64url');
    await operators.create({ username: config.adminUsername, password: generatedAdminPassword, name: 'Administrador', role: 'admin' });
    if (config.adminPassword) generatedAdminPassword = null;
  }
  for (const initial of config.initialOperators) {
    if (!(await operators.list()).some((account) => account.username.toLowerCase() === initial.username.toLowerCase())) {
      await operators.create({ username: initial.username, password: initial.password });
    }
  }

  const secrets = new FileSecretsStore(config.dataDir, config.secretsKey);
  const preferences = new FilePreferencesStore(config.dataDir, {
    ...DEFAULT_OPERATOR_PREFERENCES,
    operatorLang: config.defaultOperatorLang,
    defaultMode: config.defaultLanguageMode,
    autoAccept: config.autoAccept,
  });
  const transcripts = new FileTranscriptStore(config.dataDir);
  const recordings = config.recordCalls ? new FileRecordingStore(config.dataDir) : null;
  const providers = overrides.providers ?? createProviders(config);

  const manager = new CallManager({
    config,
    channel: providers.channel,
    pipelines: providers.pipelines,
    transcripts,
    recordings,
    preferences,
    logger,
  });
  manager.start();

  const catalog =
    overrides.catalog ??
    new ElevenLabsCatalogProvider({ getApiKey: () => secrets.resolve('ELEVENLABS_API_KEY'), fetch: fetchImpl, logger });
  const tester =
    overrides.tester ??
    new DefaultConnectionTester({ providers: config.providers, secrets, fetch: fetchImpl, logger, translatorModel: process.env.TRANSLATOR_MODEL?.trim() || 'claude-haiku-5-5' });

  const mock = providers.channel instanceof MockCallChannel ? providers.channel : null;
  const debug = mock ? createDebugHooks(providers, mock, manager) : undefined;

  let status: Extract<ServerMessage, { type: 'system.status' }> = computeStatus(config, providers, false, false);
  const refreshStatus = async (): Promise<void> => {
    const [eleven, anthropic] = await Promise.all([secrets.resolve('ELEVENLABS_API_KEY'), secrets.resolve('ANTHROPIC_API_KEY')]);
    status = computeStatus(config, providers, Boolean(eleven), Boolean(anthropic));
  };
  await refreshStatus();

  const running = createTelecomwayServer({
    config,
    logger,
    operators,
    sessions: new SessionStore(config.sessionTtlHours * 3_600_000),
    limiter: new LoginRateLimiter(),
    manager,
    secrets,
    preferences,
    transcripts,
    recordings,
    catalog,
    tester,
    onKeysChanged: () => void refreshStatus(),
    simulated: { providers: providers.simulatedProviders, channel: providers.channel.simulated },
    channel: providers.channel,
    socket: { ...(debug ? { debug } : {}), systemStatus: () => status },
  });

  const purge = async (): Promise<{ calls: number; recordings: number }> => {
    if (config.retentionDays <= 0) return { calls: 0, recordings: 0 };
    const cutoff = Date.now() - config.retentionDays * 86_400_000;
    const result = {
      calls: await transcripts.deleteOlderThan(cutoff),
      recordings: recordings ? await recordings.deleteOlderThan(cutoff) : 0,
    };
    if (result.calls || result.recordings) logger.info('Purga por plazo de conservación', result);
    return result;
  };
  let purgeTimer: ReturnType<typeof setInterval> | null = null;

  return {
    ...running,
    manager,
    operators,
    generatedAdminPassword,
    purge,
    async start() {
      const port = await running.start();
      await purge().catch((error: unknown) => logger.error('Fallo en la purga', { error: String(error) }));
      purgeTimer = setInterval(() => void purge().catch(() => undefined), 24 * 3_600_000);
      purgeTimer.unref();
      return port;
    },
    async stop() {
      if (purgeTimer) clearInterval(purgeTimer);
      await running.stop();
    },
  };
}

function computeStatus(config: ServerConfig, providers: Providers, hasElevenKey: boolean, hasAnthropicKey: boolean): Extract<ServerMessage, { type: 'system.status' }> {
  if (providers.simulatedProviders) {
    return {
      type: 'system.status',
      elevenlabs: 'simulated',
      translator: 'simulated',
      channel: providers.channel.simulated ? 'simulated' : 'unconfigured',
      detail: { elevenlabs: 'Voz simulada: no se usa ElevenLabs', translator: 'Traducción simulada: no se usa Claude', ...(providers.channel.simulated ? { channel: 'Llamadas simuladas: no hay línea real' } : {}) },
    };
  }
  // Real providers: only "configured or not" is known here; a live check is the "Probar conexión" button.
  return {
    type: 'system.status',
    elevenlabs: hasElevenKey ? 'ok' : 'unconfigured',
    translator: hasAnthropicKey ? 'ok' : 'unconfigured',
    channel: config.channel === 'mock' ? 'simulated' : 'unconfigured',
    detail: { elevenlabs: hasElevenKey ? 'Clave configurada (no comprobada)' : 'Falta la clave', translator: hasAnthropicKey ? 'Clave configurada (no comprobada)' : 'Falta la clave' },
  };
}
