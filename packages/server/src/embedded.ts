/**
 * The server as the desktop app runs it: in-process, data in the app's own folder, the operator page served
 * at `/`. PROVIDERS=auto: "modo audio del PC" calls (WhatsApp on this computer) are translated for real with
 * ElevenLabs and Claude, using the keys saved in Ajustes, with the computer's own voice as plan B. The
 * "Llamada de prueba" button stays SIMULATED (a scripted passenger on the simulated line): it shows the screens
 * work, not that any real service does.
 */
import { speechSignalDurationMs, type LanguageCode, type Logger } from '@tw/shared';
import { createApplication, type Application } from './application.js';
import { MockCallChannel } from './channel/mock-channel.js';
import { loadConfig } from './config.js';
import { silentLogger } from './logger.js';

export interface EmbeddedServerOptions {
  dataDir: string;
  adminUsername?: string;
  adminPassword: string;
  /** Compiled operator page to serve at `/`. */
  staticDir?: string;
  /** 0 = any free port. */
  port?: number;
  recordCalls?: boolean;
  logger?: Logger;
}

export interface EmbeddedServer {
  app: Application;
  port: number;
  serverUrl: string;
  stop(): Promise<void>;
}

export async function startEmbeddedServer(options: EmbeddedServerOptions): Promise<EmbeddedServer> {
  const config = loadConfig({
    PROVIDERS: 'auto',
    CHANNEL: 'mock',
    HOST: '127.0.0.1',
    PORT: String(options.port ?? 0),
    DATA_DIR: options.dataDir,
    ADMIN_USERNAME: options.adminUsername ?? 'admin',
    ADMIN_PASSWORD: options.adminPassword,
    AUTO_ACCEPT: 'true',
    RECORD_CALLS: options.recordCalls === false ? 'false' : 'true',
    RETENTION_DAYS: '90',
  });
  const app = await createApplication(config, {
    logger: options.logger ?? silentLogger,
    ...(options.staticDir ? { staticDir: options.staticDir } : {}),
  });
  const port = await app.start();
  return { app, port, serverUrl: `http://127.0.0.1:${port}`, stop: () => app.stop() };
}

export interface SimulatedLine {
  text: string;
  lang: LanguageCode;
  /** Silence after the line, before the next one. */
  pauseMs?: number;
}

export interface SimulatedCallOptions {
  from?: string;
  lang?: LanguageCode;
  lines?: SimulatedLine[];
  /** How long the simulated passenger lets it ring before giving up. */
  ringTimeoutMs?: number;
}

export type SimulatedCallOutcome =
  | { outcome: 'completed'; callId: string }
  | { outcome: 'not_answered' | 'rejected' | 'ended_early'; callId: string | null; reason?: string }
  | { outcome: 'unsupported'; message: string };

/** A realistic passenger: flight cancelled, needs a hotel. */
export const DEFAULT_TEST_CALL: Required<Pick<SimulatedCallOptions, 'from' | 'lang' | 'lines'>> = {
  from: '+44 7700 900123',
  lang: 'en',
  lines: [
    { text: 'Hello, good morning. My flight was cancelled and I need a hotel for tonight.', lang: 'en', pauseMs: 6000 },
    { text: 'Thank you. My booking reference is TW four seven nine two.', lang: 'en', pauseMs: 6000 },
    { text: 'Perfect, thank you very much for your help. Goodbye.', lang: 'en', pauseMs: 2500 },
  ],
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Makes a simulated passenger call the app and recite a few lines, waiting after each one so the
 * operator can hear the translation and answer. Resolves when the passenger hangs up (or the call ends first).
 */
export async function simulatePassengerCall(app: Application, options: SimulatedCallOptions = {}): Promise<SimulatedCallOutcome> {
  const channel = app.channel;
  if (!(channel instanceof MockCallChannel)) {
    return { outcome: 'unsupported', message: 'La llamada de prueba solo existe con el teléfono simulado (CHANNEL=mock).' };
  }
  const lines = options.lines ?? DEFAULT_TEST_CALL.lines;
  const phone = channel.createPhone();
  let ended: { reason?: string } | null = null;
  let active = false;
  const offState = phone.onState((state) => {
    if (state.state === 'active') active = true;
    if (state.state === 'ended') ended = { ...(state.reason ? { reason: state.reason } : {}) };
  });
  try {
    const call = phone.incoming(options.from ?? DEFAULT_TEST_CALL.from, options.lang ?? DEFAULT_TEST_CALL.lang);
    const deadline = Date.now() + (options.ringTimeoutMs ?? 45_000);
    while (!active && !ended && Date.now() < deadline) await sleep(50);
    if (ended) {
      const reason = (ended as { reason?: string }).reason;
      return { outcome: reason === 'rejected' || reason === 'busy' ? 'rejected' : 'ended_early', callId: call.id, ...(reason ? { reason } : {}) };
    }
    if (!active) {
      await phone.hangup('cancelled');
      return { outcome: 'not_answered', callId: call.id };
    }
    for (const line of lines) {
      if (ended) break;
      phone.say(line.text, line.lang);
      // The simulated phone plays the audio in real time: wait for it, then leave room for the answer.
      await sleep(speechSignalDurationMs(line.text) + (line.pauseMs ?? 4000));
    }
    if (!ended) await phone.hangup('hangup_passenger');
    return ended && (ended as { reason?: string }).reason !== 'hangup_passenger'
      ? { outcome: 'ended_early', callId: call.id, reason: (ended as { reason?: string }).reason ?? 'ended' }
      : { outcome: 'completed', callId: call.id };
  } finally {
    offState();
    await phone.dispose();
  }
}
