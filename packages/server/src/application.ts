import { randomBytes } from 'node:crypto';
import { utteranceKey, type UtteranceBus } from '@tw/pipeline';
import {
  DEFAULT_OPERATOR_PREFERENCES,
  type TranscriptStore,
  type CallChannel,
  type ConnectionTestResult,
  type ConnectionTester,
  type LanguageCatalogProvider,
  type Logger,
  type ServerMessage,
  type ServiceStatus,
} from '@tw/shared';
import { LoginRateLimiter, OperatorStore, SessionStore } from './auth.js';
import { CallManager } from './call-manager.js';
import { ElevenLabsCatalogProvider, type FetchLike } from './catalog.js';
import { DesktopAudioChannel } from './channel/desktop-audio.js';
import { MockCallChannel } from './channel/mock-channel.js';
import type { ServerConfig } from './config.js';
import { DefaultConnectionTester } from './connection-tester.js';
import { createLogger } from './logger.js';
import type { DebugHooks } from './operator-socket.js';
import { createDebugHooks, createProviders, type Providers } from './providers.js';
import { createTelecomwayServer, type RunningServer } from './server.js';
import { FilePreferencesStore } from './stores/preferences.js';
import { FileRecordingStore } from './stores/recordings.js';
import { FileSecretsStore } from './stores/secrets.js';
import { FileTranscriptStore } from './stores/transcripts.js';

export interface Application extends RunningServer {
  manager: CallManager;
  operators: OperatorStore;
  /** Telephony channel in use (`CHANNEL`). With `CHANNEL=desktop-audio` it is the desktop-audio channel itself. */
  channel: CallChannel;
  /** "Modo audio del PC" channel; always available, alongside whatever `CHANNEL` says. */
  localChannel: DesktopAudioChannel;
  /** Recording store, or null when RECORD_CALLS is off. */
  recordings: FileRecordingStore | null;
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
  const repaired = await closeCallsLeftOpen(transcripts);
  if (repaired > 0) logger.warn('Llamadas que quedaron abiertas en una ejecución anterior se han cerrado en el historial', { count: repaired });
  const recordings = config.recordCalls ? new FileRecordingStore(config.dataDir) : null;
  const providers = overrides.providers ?? createProviders(config, { getSecret: (name) => secrets.resolve(name) });

  // "Modo audio del PC" exists next to every channel. With CHANNEL=desktop-audio there is no telephone line
  // at all, so the desktop-audio channel (no incoming calls, nothing to dial) is also the main channel.
  const local = new DesktopAudioChannel();
  await local.start();
  const channel: CallChannel = config.channel === 'desktop-audio' ? local : providers.channel;
  await channel.start();

  const manager = new CallManager({
    config,
    channel,
    localChannel: local,
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
  const innerTester =
    overrides.tester ??
    new DefaultConnectionTester({ providers: config.providers, secrets, fetch: fetchImpl, logger, translatorModel: process.env.TRANSLATOR_MODEL?.trim() || 'claude-haiku-5-5' });

  // `debug.say` with simulated providers: the mock channel speaks for simulated phones; local calls get the
  // text through the utterance bus and the real cable audio paces it.
  const mockForDebug = providers.channel instanceof MockCallChannel ? providers.channel : null;
  const debug = withLocalDebugHooks(mockForDebug ? createDebugHooks(providers, mockForDebug, manager) : undefined, providers.bus, manager);

  // With real providers a key only ever shows as "configured" until a "Probar conexión" succeeds; the result
  // of the last real test (ok or fail) is what the status reports, and a key change forgets it.
  const verification: ServiceVerification = { elevenlabs: null, translator: null };
  let status: Extract<ServerMessage, { type: 'system.status' }> = computeStatus(config, providers, channel, { elevenlabs: false, translator: false }, verification);
  const refreshStatus = async (): Promise<void> => {
    const [eleven, anthropic] = await Promise.all([secrets.resolve('ELEVENLABS_API_KEY'), secrets.resolve('ANTHROPIC_API_KEY')]);
    const next = computeStatus(config, providers, channel, { elevenlabs: Boolean(eleven), translator: Boolean(anthropic) }, verification);
    const changed = JSON.stringify(next) !== JSON.stringify(status);
    status = next;
    if (changed) manager.broadcast(status);
  };
  await refreshStatus();
  const tester: ConnectionTester = {
    async test(service) {
      const result = await innerTester.test(service);
      const key = service === 'elevenlabs' ? 'elevenlabs' : service === 'anthropic' ? 'translator' : null;
      if (key && result.contactedRealService && (result.status === 'ok' || result.status === 'fail')) {
        verification[key] = result;
        await refreshStatus();
      }
      return result;
    },
  };

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
    onKeysChanged: () => {
      verification.elevenlabs = null;
      verification.translator = null;
      void refreshStatus();
    },
    simulated: { providers: providers.simulatedProviders, channel: channel.simulated },
    channel,
    socket: { ...(debug ? { debug } : {}), localAudio: manager.localAudioAvailable, systemStatus: () => status },
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
    channel,
    localChannel: local,
    recordings,
    generatedAdminPassword,
    purge,
    async start() {
      // LANGUAGE_CATALOG_LIVE: ask ElevenLabs which languages the voice model supports before serving anyone
      // (`refresh` keeps the documentation list and logs a warning when the key is missing or the request fails).
      if (config.languageCatalogLive) {
        await catalog.refresh().catch((error: unknown) => logger.warn('No se pudo consultar el catálogo de idiomas en vivo', { error: String(error) }));
      }
      const port = await running.start();
      await purge().catch((error: unknown) => logger.error('Fallo en la purga', { error: String(error) }));
      purgeTimer = setInterval(() => void purge().catch(() => undefined), 24 * 3_600_000);
      purgeTimer.unref();
      return port;
    },
    async stop() {
      if (purgeTimer) clearInterval(purgeTimer);
      await running.stop();
      // The server stops the main channel; the local one is separate unless it IS the main channel (stop is idempotent).
      await local.stop();
      if (channel !== providers.channel) await providers.channel.stop();
    },
  };
}

/**
 * `debug.say {as:'passenger'}` on a local call: the mock channel has no phone for it, so the text goes
 * straight to the utterance bus and the simulated STT pairs it with the real audio arriving from the cable.
 */
function withLocalDebugHooks(base: DebugHooks | undefined, bus: UtteranceBus | null, manager: CallManager): DebugHooks | undefined {
  if (!bus) return base;
  return {
    sayAsPassenger: (callId, text, lang) => {
      if (base?.sayAsPassenger(callId, text, lang)) return true;
      if (!manager.isLocalCall(callId)) return false;
      bus.say(utteranceKey(callId, 'passenger'), { text, lang });
      return true;
    },
    sayAsOperator: (operatorId, callId, text, lang) => base?.sayAsOperator(operatorId, callId, text, lang) ?? false,
  };
}

function channelStatus(channel: CallChannel): Pick<Extract<ServerMessage, { type: 'system.status' }>, 'channel'> & { detail?: string } {
  if (channel.simulated) return { channel: 'simulated', detail: 'Llamadas simuladas: no hay línea real' };
  if (channel.kind === 'desktop-audio') {
    return { channel: 'unconfigured', detail: 'Sin línea telefónica: solo el modo audio del PC (cables de audio virtuales)' };
  }
  return { channel: 'unconfigured' };
}

/** Last real connection test per service (null: never tested since the key was set). */
export type ServiceVerification = Record<'elevenlabs' | 'translator', ConnectionTestResult | null>;

/** Status and explanation of one real provider from its key and its last real test. */
export function providerStatus(hasKey: boolean, last: ConnectionTestResult | null): { status: ServiceStatus; detail: string } {
  if (!hasKey) return { status: 'unconfigured', detail: 'Falta la clave' };
  if (last?.status === 'ok') {
    return { status: 'ok', detail: `Comprobado el ${new Date(last.testedAt).toLocaleString('es-ES')}${last.latencyMs !== null ? ` (${last.latencyMs} ms)` : ''}: ${last.message}` };
  }
  if (last?.status === 'fail') return { status: 'down', detail: `La última comprobación falló: ${last.message}` };
  return { status: 'configured', detail: 'Clave configurada, sin comprobar: pulsa «Probar conexión» en Ajustes. No se ha contactado el servicio.' };
}

export function computeStatus(
  config: ServerConfig,
  providers: Providers,
  channel: CallChannel,
  keys: { elevenlabs: boolean; translator: boolean },
  verification: ServiceVerification,
): Extract<ServerMessage, { type: 'system.status' }> {
  const line = channelStatus(channel);
  const channelDetail = line.detail ? { channel: line.detail } : {};
  if (providers.simulatedProviders) {
    return {
      type: 'system.status',
      elevenlabs: 'simulated',
      translator: 'simulated',
      channel: line.channel,
      detail: { elevenlabs: 'Voz simulada: no se usa ElevenLabs', translator: 'Traducción simulada: no se usa Claude', ...channelDetail },
    };
  }
  // Real providers: a key alone is "configured"; only a successful "Probar conexión" makes it "ok".
  const eleven = providerStatus(keys.elevenlabs, verification.elevenlabs);
  const translator = providerStatus(keys.translator, verification.translator);
  return {
    type: 'system.status',
    elevenlabs: eleven.status,
    translator: translator.status,
    channel: config.channel === 'mock' ? 'simulated' : line.channel,
    detail: { elevenlabs: eleven.detail, translator: translator.detail, ...channelDetail },
  };
}

/**
 * A previous run that died mid-call (crash, power cut, `kill -9`) leaves its calls recorded as active or
 * ringing forever. On startup they are closed with `server_shutdown`, so the history never shows a call
 * as "in progress" that nobody is on.
 */
export async function closeCallsLeftOpen(transcripts: TranscriptStore, now: () => number = () => Date.now()): Promise<number> {
  const open = (await transcripts.listCalls({ limit: 500 })).filter((call) => call.state !== 'ended');
  for (const call of open) {
    await transcripts.saveCall({ ...call, state: 'ended', endedAt: now(), endReason: 'server_shutdown' });
  }
  return open.length;
}
