import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  AudioFrameType,
  DEFAULT_OPERATOR_PREFERENCES,
  LevelTrack,
  decodeBinaryFrame,
  encodeMessage,
  parseServerMessage,
  parseWav,
  type ClientMessage,
  type OperatorPreferences,
  type ServerMessage,
  type SimServerMessage,
} from '@tw/shared';
import { createApplication, type Application } from './application.js';
import { loadConfig } from './config.js';
import { silentLogger } from './logger.js';
import { createProviders } from './providers.js';
import { isLoopback } from './sim-socket.js';
import { tempDataDir } from './test-utils.js';

const ADMIN = { username: 'admin', password: 'clave-admin-123' };
const ANA = { username: 'ana', password: 'clave-ana-1234' };
const LUIS = { username: 'luis', password: 'clave-luis-123' };

async function waitFor(condition: () => boolean, what: string, timeoutMs = 6000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class OperatorClient {
  readonly messages: ServerMessage[] = [];
  readonly frames: Uint8Array[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) this.frames.push(new Uint8Array(data));
      else {
        const parsed = parseServerMessage(data.toString('utf8'));
        if (parsed.ok) this.messages.push(parsed.value);
        else throw new Error(`The server sent an invalid message: ${parsed.error}`);
      }
    });
  }
  static async connect(port: number): Promise<OperatorClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/operator`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new OperatorClient(ws);
  }
  send(message: ClientMessage): void {
    this.ws.send(encodeMessage(message));
  }
  of<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.messages.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
  finals(speaker: 'passenger' | 'operator') {
    return this.of('transcript.segment').map((m) => m.segment).filter((s) => s.final && s.speaker === speaker);
  }
  levelWindows(track: number) {
    return this.frames.flatMap((frame) => {
      const decoded = decodeBinaryFrame(frame);
      return decoded.ok && decoded.value.kind === 'levels' && decoded.value.levels.track === track ? decoded.value.levels.windows : [];
    });
  }
  audioBytes(type: number): number {
    return this.frames.filter((f) => f[0] === type).reduce((n, f) => n + f.byteLength - 1, 0);
  }
  close(): void {
    this.ws.close();
  }
}

class SimClient {
  readonly messages: SimServerMessage[] = [];
  heardBytes = 0;
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      const message = JSON.parse(data.toString('utf8')) as SimServerMessage;
      this.messages.push(message);
      if (message.type === 'sim.audio') this.heardBytes += Buffer.from(message.audio, 'base64').byteLength;
    });
  }
  static async connect(port: number): Promise<SimClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sim`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new SimClient(ws);
  }
  send(message: object): void {
    this.ws.send(JSON.stringify(message));
  }
  states() {
    return this.messages.filter((m): m is Extract<SimServerMessage, { type: 'sim.state' }> => m.type === 'sim.state');
  }
  close(): void {
    this.ws.close();
  }
}

const running: { app: Application; clients: { close(): void }[] }[] = [];
afterEach(async () => {
  for (const item of running.splice(0)) {
    for (const client of item.clients) client.close();
    await item.app.stop();
  }
});

async function boot(extraEnv: Record<string, string> = {}) {
  const dataDir = await tempDataDir();
  const config = loadConfig({
    PORT: '0',
    DATA_DIR: dataDir,
    ADMIN_PASSWORD: ADMIN.password,
    OPERATORS: `${ANA.username}:${ANA.password},${LUIS.username}:${LUIS.password}`,
    AUTO_ACCEPT: 'true',
    RECORD_CALLS: 'true',
    LANG_HOLD_SECONDS: '0.3',
    ...extraEnv,
  });
  const app = await createApplication(config, { logger: silentLogger, providers: createProviders(config, { speed: 25 }) });
  const port = await app.start();
  const clients: { close(): void }[] = [];
  running.push({ app, clients });
  const base = `http://127.0.0.1:${port}`;
  const api = async (path: string, init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...init.headers,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: response.status, headers: response.headers, json: json as any, text };
  };
  const login = async (user: { username: string; password: string }): Promise<string> => {
    const response = await api('/api/login', { method: 'POST', body: user });
    expect(response.status).toBe(200);
    return response.json.token as string;
  };
  const operator = async (user: { username: string; password: string }) => {
    const client = await OperatorClient.connect(port);
    clients.push(client);
    client.send({ type: 'auth.login', ...user });
    await waitFor(() => client.of('auth.ok').length === 1, `${user.username} to authenticate`);
    return client;
  };
  const passenger = async () => {
    const client = await SimClient.connect(port);
    clients.push(client);
    return client;
  };
  return { app, port, dataDir, api, login, operator, passenger, clients };
}

describe('HTTP API', () => {
  it('reports health, logs in, rejects bad credentials and rate-limits repeated failures', async () => {
    const s = await boot();
    const health = await s.api('/api/health');
    expect(health.json).toMatchObject({ ok: true, providers: 'mock', channel: 'mock', simulatedProviders: true, simulatedChannel: true });
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');

    const wrong = await s.api('/api/login', { method: 'POST', body: { username: 'ana', password: 'mala-clave-123' } });
    expect(wrong.status).toBe(401);
    expect(wrong.json.error.code).toBe('invalid_credentials');
    const ok = await s.api('/api/login', { method: 'POST', body: ANA });
    expect(ok.json.operator).toMatchObject({ name: 'ana', role: 'operator' });
    expect(JSON.stringify(ok.json)).not.toContain('passwordHash');

    for (let i = 0; i < 5; i++) await s.api('/api/login', { method: 'POST', body: { username: 'luis', password: 'incorrecta-1' } });
    const blocked = await s.api('/api/login', { method: 'POST', body: LUIS });
    expect(blocked.status).toBe(429);
  });

  it('requires a valid session for everything else', async () => {
    const s = await boot();
    expect((await s.api('/api/calls')).status).toBe(401);
    const invalid = await s.api('/api/calls', { token: 'nope' });
    expect(invalid.status).toBe(401);
    expect(invalid.json.error.code).toBe('token_invalid');
    const token = await s.login(ANA);
    expect((await s.api('/api/calls', { token })).status).toBe(200);
    await s.api('/api/logout', { method: 'POST', token });
    expect((await s.api('/api/calls', { token })).status).toBe(401);
    expect((await s.api('/api/nada', { token: await s.login(ANA) })).status).toBe(404);
  });

  it('keeps API keys write-only, admin-only and out of the disk in clear text', async () => {
    const s = await boot();
    const adminToken = await s.login(ADMIN);
    const anaToken = await s.login(ANA);
    const secret = 'sk_live_0123456789abcdefghij';

    expect((await s.api('/api/settings/keys', { token: anaToken })).status).toBe(403);
    expect((await s.api('/api/settings/keys', { method: 'PUT', token: anaToken, body: { keys: { ELEVENLABS_API_KEY: secret } } })).status).toBe(403);
    expect((await s.api('/api/settings/test/elevenlabs', { method: 'POST', token: anaToken })).status).toBe(403);

    const bad = await s.api('/api/settings/keys', { method: 'PUT', token: adminToken, body: { keys: { ELEVENLABS_API_KEY: 'tiene espacios' } } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('bad_secret');

    const saved = await s.api('/api/settings/keys', { method: 'PUT', token: adminToken, body: { keys: { ELEVENLABS_API_KEY: secret } } });
    expect(saved.json.keys.ELEVENLABS_API_KEY).toMatchObject({ configured: true, last4: 'ghij', source: 'settings' });
    expect(saved.text).not.toContain(secret);
    expect((await s.api('/api/settings/keys', { token: adminToken })).text).not.toContain(secret);
    for (const name of await readdir(s.dataDir)) {
      if (name.endsWith('.json')) expect(await readFile(join(s.dataDir, name), 'utf8')).not.toContain(secret);
    }

    const removed = await s.api('/api/settings/keys', { method: 'PUT', token: adminToken, body: { keys: { ELEVENLABS_API_KEY: null } } });
    expect(removed.json.keys.ELEVENLABS_API_KEY).toMatchObject({ configured: false, source: 'none' });
  });

  it('connection tests say SIMULATED and that no real service was contacted; channels never report success', async () => {
    const s = await boot();
    const token = await s.login(ADMIN);
    for (const service of ['elevenlabs', 'anthropic'] as const) {
      const result = await s.api(`/api/settings/test/${service}`, { method: 'POST', token });
      expect(result.json).toMatchObject({ service, status: 'simulated', contactedRealService: false });
      expect(result.json.message).toContain('NO se ha contactado');
    }
    for (const service of ['twilio', 'whatsapp'] as const) {
      const result = await s.api(`/api/settings/test/${service}`, { method: 'POST', token });
      expect(result.json).toMatchObject({ status: 'unconfigured', contactedRealService: false });
    }
    expect((await s.api('/api/settings/test/otro', { method: 'POST', token })).status).toBe(404);
  });

  it('serves the language catalog and validates operator preferences against it', async () => {
    const s = await boot();
    const token = await s.login(ANA);
    const catalog = (await s.api('/api/languages', { token })).json;
    expect(catalog.source).toBe('documentation');
    expect(catalog.languages.find((l: { code: string }) => l.code === 'es')).toMatchObject({ stt: true, tts: true });

    const prefs: OperatorPreferences = { ...DEFAULT_OPERATOR_PREFERENCES, defaultMode: 'mixed', defaultPassengerHears: 'it', autoAccept: true };
    expect((await s.api('/api/me/preferences', { method: 'PUT', token, body: prefs })).status).toBe(200);
    expect((await s.api('/api/me/preferences', { token })).json).toEqual(prefs);

    const unsupported = await s.api('/api/me/preferences', { method: 'PUT', token, body: { ...prefs, defaultPassengerSpeaks: 'th' } });
    expect(unsupported.status).toBe(400);
    expect(unsupported.json.error.code).toBe('unsupported_language');
    expect((await s.api('/api/me/preferences', { method: 'PUT', token, body: { ...prefs, operatorLang: 'xx' } })).status).toBe(400);
    expect((await s.api('/api/languages/refresh', { method: 'POST', token })).status).toBe(403);
  });

  it('restricts CORS to the configured origins', async () => {
    const s = await boot({ ALLOWED_ORIGINS: 'http://localhost:5173' });
    const allowed = await s.api('/api/health', { headers: { origin: 'http://localhost:5173' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const denied = await s.api('/api/health', { headers: { origin: 'http://evil.example' } });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    const socket = new WebSocket(`ws://127.0.0.1:${s.port}/operator`, { headers: { origin: 'http://evil.example' } });
    const outcome = await new Promise<string>((resolve) => {
      socket.once('open', () => resolve('open'));
      socket.once('error', () => resolve('rejected'));
      socket.once('unexpected-response', () => resolve('rejected'));
    });
    expect(outcome).toBe('rejected');
  });
});

describe('a call over the wire', () => {
  it('enters on its own, translates both ways, measures each leg and lands in the history with its recording', async () => {
    const s = await boot();
    const ana = await s.operator(ANA);
    expect(ana.of('auth.ok')[0]).toMatchObject({ operator: { name: 'ana' }, server: { providers: 'mock', channel: 'mock', debug: true, maxCalls: 3 } });
    expect(ana.of('system.status')[0]).toMatchObject({ elevenlabs: 'simulated', translator: 'simulated', channel: 'simulated' });
    expect(ana.of('presence')[0]!.operators).toHaveLength(1);

    const sim = await s.passenger();
    sim.send({ type: 'sim.incoming', from: '+441234567890', lang: 'en' });
    await waitFor(() => ana.of('call.state').some((m) => m.state === 'active'), 'the call to become active');
    const callId = ana.of('call.incoming')[0]!.callId;
    expect(ana.of('call.state').at(-1)).toMatchObject({ simulated: true, direction: 'inbound', remoteNumber: '+441234567890' });

    // Both lanes start flat.
    await waitFor(() => ana.levelWindows(LevelTrack.PassengerIn).length >= 20, 'passenger lane frames');
    expect(ana.levelWindows(LevelTrack.PassengerIn).every((w) => w.rms === 0)).toBe(true);

    sim.send({ type: 'sim.say', text: 'my flight was cancelled and I need a hotel', lang: 'en' });
    await waitFor(() => ana.finals('passenger').length === 1, 'the passenger phrase');
    expect(ana.finals('passenger')[0]).toMatchObject({ originalLang: 'en', translatedLang: 'es', translatedText: 'Mi vuelo fue cancelado y necesito un hotel.' });
    expect(ana.levelWindows(LevelTrack.PassengerIn).some((w) => w.rms > 0.01)).toBe(true);
    expect(ana.levelWindows(LevelTrack.OperatorIn).every((w) => w.rms === 0)).toBe(true);
    await waitFor(() => ana.audioBytes(AudioFrameType.TranslatedPassenger) > 20_000, 'the translated voice');

    // The operator answers (simulated microphone): the passenger hears the translation, the operator lane moves.
    ana.send({ type: 'debug.say', text: 'voy a comprobar las opciones de alojamiento disponibles', lang: 'es', as: 'operator' });
    await waitFor(() => ana.finals('operator').length === 1, 'the operator phrase');
    expect(ana.finals('operator')[0]).toMatchObject({ translatedLang: 'en', translatedText: 'I will check the available accommodation options.' });
    expect(ana.levelWindows(LevelTrack.OperatorIn).some((w) => w.rms > 0.01)).toBe(true);
    await waitFor(() => sim.heardBytes > 20_000, 'the passenger to hear the translation');

    // Live language change over the wire.
    ana.send({ type: 'call.setLanguages', callId, settings: { passengerHears: { mode: 'fixed', lang: 'fr' } } });
    await waitFor(() => ana.of('call.languages').at(-1)!.settings.passengerHears.mode === 'fixed', 'the language confirmation');
    expect(ana.of('call.languages').at(-1)!.settings.passengerHears).toEqual({ mode: 'fixed', lang: 'fr' });

    sim.send({ type: 'sim.hangup' });
    await waitFor(() => ana.of('call.ended').length === 1, 'the call to end');
    expect(ana.of('call.ended')[0]).toMatchObject({ callId, reason: 'hangup_passenger' });

    // History: the owner sees it, another operator does not, the admin does.
    const anaToken = await s.login(ANA);
    const list = await s.api('/api/calls', { token: anaToken });
    expect(list.json.calls).toHaveLength(1);
    expect(list.json.calls[0]).toMatchObject({ id: callId, remoteNumber: '+441234567890', passengerLang: 'en', recorded: true });
    expect((await s.api('/api/calls?q=441234', { token: anaToken })).json.calls).toHaveLength(1);
    expect((await s.api('/api/calls?q=999', { token: anaToken })).json.calls).toHaveLength(0);
    expect((await s.api(`/api/calls?from=${Date.now() + 60_000}`, { token: anaToken })).json.calls).toHaveLength(0);

    const detail = await s.api(`/api/calls/${callId}`, { token: anaToken });
    expect(detail.json.segments.map((x: { speaker: string }) => x.speaker).sort()).toEqual(['operator', 'passenger']);
    expect((await s.api(`/api/calls/${callId}`, { token: await s.login(LUIS) })).status).toBe(404);
    expect((await s.api('/api/calls', { token: await s.login(LUIS) })).json.calls).toHaveLength(0);
    expect((await s.api('/api/calls', { token: await s.login(ADMIN) })).json.calls).toHaveLength(1);

    // Recording: WAV with ranges, access-controlled, no path traversal.
    const audio = await fetch(`http://127.0.0.1:${s.port}/api/calls/${callId}/audio/passenger`, { headers: { authorization: `Bearer ${anaToken}` } });
    expect(audio.status).toBe(200);
    expect(audio.headers.get('content-type')).toBe('audio/wav');
    const wav = new Uint8Array(await audio.arrayBuffer());
    expect(parseWav(wav).sampleRate).toBe(16000);
    const ranged = await fetch(`http://127.0.0.1:${s.port}/api/calls/${callId}/audio/passenger`, { headers: { authorization: `Bearer ${anaToken}`, range: 'bytes=0-99' } });
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(100);
    expect((await fetch(`http://127.0.0.1:${s.port}/api/calls/${callId}/audio/passenger`, { headers: { authorization: `Bearer ${await s.login(LUIS)}` } })).status).toBe(404);
    expect((await s.api(`/api/calls/${callId}/audio/..%2F..%2Fsecrets`, { token: anaToken })).status).toBe(404);
    expect((await s.api('/api/calls/..%2F..%2Fetc%2Fpasswd', { token: anaToken })).status).toBe(404);
  });

  it('refuses a second session of the same operator, bad credentials and unauthenticated messages', async () => {
    const s = await boot();
    await s.operator(ANA);
    const second = await OperatorClient.connect(s.port);
    s.clients.push(second);
    second.send({ type: 'auth.login', ...ANA });
    await waitFor(() => second.of('auth.error').length === 1, 'the refusal');
    expect(second.of('auth.error')[0]!.code).toBe('already_connected');

    const stranger = await OperatorClient.connect(s.port);
    s.clients.push(stranger);
    stranger.send({ type: 'call.hangup', callId: 'x' });
    await waitFor(() => stranger.of('error').length === 1, 'the not-authenticated error');
    expect(stranger.of('error')[0]!.code).toBe('not_authenticated');
    stranger.send({ type: 'auth.login', username: 'ana', password: 'otra-clave-123' });
    await waitFor(() => stranger.of('auth.error').length === 1, 'the credentials error');
    expect(stranger.of('auth.error')[0]!.code).toBe('invalid_credentials');
  });

  it('resumes a session with its token after a reconnect', async () => {
    const s = await boot();
    const first = await s.operator(ANA);
    const token = first.of('auth.ok')[0]!.token;
    first.close();
    await waitFor(() => first.ws.readyState === WebSocket.CLOSED, 'the first socket to close');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = await OperatorClient.connect(s.port);
    s.clients.push(again);
    again.send({ type: 'auth.resume', token });
    await waitFor(() => again.of('auth.ok').length === 1, 'the resume');
    const bad = await OperatorClient.connect(s.port);
    s.clients.push(bad);
    bad.send({ type: 'auth.resume', token: 'inventado' });
    await waitFor(() => bad.of('auth.error').length === 1, 'the invalid token');
    expect(bad.of('auth.error')[0]!.code).toBe('token_invalid');
  });

  it('places an outbound call to a simulated passenger who is listening', async () => {
    const s = await boot();
    const ana = await s.operator(ANA);
    const sim = await s.passenger();
    sim.send({ type: 'sim.listen', lang: 'pt' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    ana.send({ type: 'call.dial', number: '+351912345678', languages: { passengerHears: { mode: 'fixed', lang: 'pt' }, passengerSpeaks: { mode: 'auto' } } });
    await waitFor(() => sim.states().some((x) => x.state === 'ringing' && x.direction === 'outbound'), 'the phone to ring');
    sim.send({ type: 'sim.answer' });
    await waitFor(() => ana.of('call.state').some((m) => m.state === 'active'), 'the call to become active');
    ana.send({ type: 'debug.say', text: 'voy a comprobar las opciones de alojamiento disponibles', lang: 'es', as: 'operator' });
    await waitFor(() => ana.finals('operator').length === 1, 'the operator phrase');
    expect(ana.finals('operator')[0]).toMatchObject({ translatedLang: 'pt', translatedText: 'Vou verificar as opções de alojamento disponíveis.' });
    await waitFor(() => sim.heardBytes > 20_000, 'the passenger to hear');
  });

  it('only accepts the simulator from the same machine', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('192.168.1.20')).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});
