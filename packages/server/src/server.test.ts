import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  AudioFrameType,
  DEFAULT_OPERATOR_PREFERENCES,
  LevelTrack,
  concatPcm,
  decodeBinaryFrame,
  encodeAudioFrame,
  encodeMessage,
  parseServerMessage,
  parseWav,
  silencePcm16,
  synthesizeSpeechSignal,
  documentationCatalog,
  type ClientMessage,
  type ConnectionTestResult,
  type LanguageCatalog,
  type OperatorPreferences,
  type ServerMessage,
  type SimServerMessage,
} from '@tw/shared';
import { createApplication, type Application, type ApplicationOverrides } from './application.js';
import { AUDIO_BURST_BYTES } from './operator-socket.js';
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
  sendBinary(frame: Uint8Array): void {
    this.ws.send(frame, { binary: true });
  }
  /** "Modo audio del PC": what the app captures from the cable, as 20 ms `PassengerLocal` frames plus a silent tail. */
  sendCableAudio(pcm: Uint8Array): void {
    const signal = concatPcm([pcm, silencePcm16(500)]);
    for (let offset = 0; offset < signal.byteLength; offset += 640) {
      this.sendBinary(encodeAudioFrame(AudioFrameType.PassengerLocal, signal.slice(offset, Math.min(offset + 640, signal.byteLength))));
    }
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
  /** Levels frames of a track, heartbeats (zero windows) included. */
  levelFrameCount(track: number): number {
    return this.frames.filter((frame) => {
      const decoded = decodeBinaryFrame(frame);
      return decoded.ok && decoded.value.kind === 'levels' && decoded.value.levels.track === track;
    }).length;
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

async function boot(extraEnv: Record<string, string> = {}, overrides: Omit<ApplicationOverrides, 'logger' | 'providers'> = {}) {
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
  const app = await createApplication(config, { logger: silentLogger, providers: createProviders(config, { speed: 25 }), ...overrides });
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
  it('voice and plan B: admin only, validated, saved; voices come from the account; the computer voice can be tested', async () => {
    const requested: string[] = [];
    const fakeFetch: ApplicationOverrides['fetch'] = async (url) => {
      requested.push(url);
      if (url.endsWith('/v1/voices')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            voices: [
              { voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', labels: { gender: 'male', accent: 'British' } },
              { voice_id: 'bad id!', name: 'Rota' },
              { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Ana' },
            ],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const spoken: string[] = [];
    const systemVoice: ApplicationOverrides['systemVoice'] = {
      platform: 'macos',
      voices: async () => [{ name: 'Mónica', locale: 'es-ES' }],
      synthesize: async (text) => {
        spoken.push(text);
        return new Uint8Array(6400);
      },
      close: async () => undefined,
    };
    const { api, login } = await boot({}, { fetch: fakeFetch, systemVoice });
    const admin = await login(ADMIN);
    const ana = await login(ANA);

    expect((await api('/api/settings/app', { token: ana })).status).toBe(403);
    const defaults = await api('/api/settings/app', { token: admin });
    expect(defaults.json).toEqual({ voiceId: null, fallbackSystemVoice: true, fallbackOriginalVoice: true });
    expect((await api('/api/settings/app', { method: 'PUT', token: admin, body: { voiceId: '../etc', fallbackSystemVoice: true, fallbackOriginalVoice: true } })).status).toBe(400);
    const saved = await api('/api/settings/app', { method: 'PUT', token: admin, body: { voiceId: 'EXAVITQu4vr4xnSDxMaL', fallbackSystemVoice: false, fallbackOriginalVoice: true } });
    expect(saved.status).toBe(200);
    expect((await api('/api/settings/app', { token: admin })).json).toMatchObject({ voiceId: 'EXAVITQu4vr4xnSDxMaL', fallbackSystemVoice: false });

    const noKey = await api('/api/settings/voices', { token: admin });
    expect(noKey.json).toMatchObject({ source: 'unavailable', voices: [] });
    expect(requested).toHaveLength(0);
    await api('/api/settings/keys', { method: 'PUT', token: admin, body: { keys: { ELEVENLABS_API_KEY: 'sk_prueba_1234' } } });
    const voices = await api('/api/settings/voices', { token: admin });
    expect(voices.json.source).toBe('elevenlabs');
    expect(voices.json.voices).toEqual([
      { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Ana', description: null },
      { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', description: 'male · British' },
    ]);
    expect((await api('/api/settings/voices', { token: ana })).status).toBe(403);

    const test = await api('/api/settings/test/system-voice', { method: 'POST', token: admin });
    expect(test.json).toMatchObject({ service: 'system-voice', status: 'ok', contactedRealService: false });
    expect(spoken).toHaveLength(1);
  });

  it('reports health, logs in, rejects bad credentials and rate-limits repeated failures', async () => {
    const s = await boot();
    // Liveness only: nothing about providers or channels leaves without a session.
    const health = await s.api('/api/health');
    expect(health.json).toEqual({ ok: true });
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
    expect(audio.headers.get('x-content-type-options')).toBe('nosniff');
    expect(audio.headers.get('x-frame-options')).toBe('DENY');
    expect(audio.headers.get('content-security-policy')).toContain("default-src 'none'");
    const wav = new Uint8Array(await audio.arrayBuffer());
    expect(Number(audio.headers.get('content-length'))).toBe(wav.byteLength);
    expect(parseWav(wav).sampleRate).toBe(16000);
    const ranged = await fetch(`http://127.0.0.1:${s.port}/api/calls/${callId}/audio/passenger`, { headers: { authorization: `Bearer ${anaToken}`, range: 'bytes=0-99' } });
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(100);
    // Streamed from disk: every leg (the mixed one is summed piece by piece) is byte-for-byte what the
    // in-memory WAV would be, whole and by arbitrary ranges.
    const store = s.app.recordings!;
    for (const leg of ['passenger', 'operator', 'mixed'] as const) {
      const expected = Buffer.from((await store.read(callId, leg))!);
      const whole = Buffer.from(await (await fetch(`http://127.0.0.1:${s.port}/api/calls/${callId}/audio/${leg}`, { headers: { authorization: `Bearer ${anaToken}` } })).arrayBuffer());
      expect(whole.equals(expected)).toBe(true);
      for (const [from, to] of [[0, 43], [43, 44], [45, 1000], [1001, 1002], [expected.byteLength - 7, expected.byteLength - 1], [100, expected.byteLength + 50]]) {
        const part = await fetch(`http://127.0.0.1:${s.port}/api/calls/${callId}/audio/${leg}`, { headers: { authorization: `Bearer ${anaToken}`, range: `bytes=${from}-${to}` } });
        expect(part.status).toBe(206);
        const body = Buffer.from(await part.arrayBuffer());
        expect(body.equals(expected.subarray(from, Math.min(to, expected.byteLength - 1) + 1))).toBe(true);
      }
    }
    expect((await s.api(`/api/calls/${callId}/audio/passenger`, { token: anaToken, headers: { range: 'bytes=9999999-' } })).status).toBe(416);
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

  it('refuses the simulator socket to a browser page (Origin header) even from this machine', async () => {
    const s = await boot();
    const outcome = (headers: Record<string, string>): Promise<string> =>
      new Promise((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${s.port}/sim`, { headers });
        socket.once('open', () => {
          socket.close();
          resolve('open');
        });
        socket.once('error', () => resolve('rejected'));
        socket.once('unexpected-response', () => resolve('rejected'));
      });
    expect(await outcome({ origin: 'https://sitio-malicioso.example' })).toBe('rejected');
    expect(await outcome({})).toBe('open');
    const allowed = await boot({ ALLOWED_ORIGINS: 'http://127.0.0.1:5173' });
    const viaAllowed = await new Promise<string>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${allowed.port}/sim`, { headers: { origin: 'http://127.0.0.1:5173' } });
      socket.once('open', () => {
        socket.close();
        resolve('open');
      });
      socket.once('error', () => resolve('rejected'));
      socket.once('unexpected-response', () => resolve('rejected'));
    });
    expect(viaAllowed).toBe('open');
  });

  it('leaves no ghost operator when the socket closes while its login is being verified', async () => {
    const s = await boot();
    const dying = await OperatorClient.connect(s.port);
    dying.send({ type: 'auth.login', ...ANA });
    dying.close();
    await waitFor(() => dying.ws.readyState === WebSocket.CLOSED, 'the first socket to close');
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The same operator logs in again: with a ghost registered this would be `already_connected` until a restart.
    const again = await s.operator(ANA);
    expect(again.of('auth.error')).toHaveLength(0);
    expect(again.of('presence').at(-1)!.operators.filter((o) => o.name === 'ana')).toHaveLength(1);
  });

  it('keeps the call while the operator reconnects within the grace period, shows it again, and answers unknown_call for a call that is gone', async () => {
    const s = await boot({ RECONNECT_GRACE_SECONDS: '5' });
    const ana = await s.operator(ANA);
    const token = ana.of('auth.ok')[0]!.token;
    const sim = await s.passenger();
    sim.send({ type: 'sim.incoming', from: '+34600000000', lang: 'en' });
    await waitFor(() => ana.of('call.state').some((m) => m.state === 'active'), 'the call to become active');
    const callId = ana.of('call.state')[0]!.callId;

    // The operator's connection drops (no close frame): the passenger keeps the line.
    ana.ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sim.states().some((x) => x.state === 'ended')).toBe(false);
    expect(s.app.manager.activeCalls).toBe(1);

    const back = await OperatorClient.connect(s.port);
    s.clients.push(back);
    back.send({ type: 'auth.resume', token });
    await waitFor(() => back.of('call.languages').length >= 1, 'the call to be shown again');
    expect(back.of('auth.ok')[0]!.operator).toMatchObject({ status: 'in_call', currentCallId: callId });
    expect(back.of('call.state').at(-1)).toMatchObject({ callId, state: 'active' });
    expect(back.of('call.languages').at(-1)!.directAudio).toEqual({ passengerToOperator: false, operatorToPassenger: false });
    sim.send({ type: 'sim.say', text: 'my flight was cancelled and I need a hotel', lang: 'en' });
    await waitFor(() => back.finals('passenger').length === 1, 'a phrase after the reconnection');

    back.send({ type: 'call.hangup', callId });
    await waitFor(() => back.of('call.ended').length === 1, 'the call to end');
    expect(back.of('call.ended')[0]).toMatchObject({ callId, reason: 'hangup_operator' });
    // Hanging up a call that is already gone is answered, so a stale screen can be closed.
    back.send({ type: 'call.hangup', callId });
    await waitFor(() => back.of('error').some((m) => m.code === 'unknown_call' && m.callId === callId), 'the unknown_call answer');
  });

  it('drops microphone audio that arrives faster than real time instead of recording and transcribing it', async () => {
    const s = await boot();
    const ana = await s.operator(ANA);
    const sim = await s.passenger();
    sim.send({ type: 'sim.incoming', from: '+34600000000', lang: 'en' });
    await waitFor(() => ana.of('call.state').some((m) => m.state === 'active'), 'the call to become active');
    const callId = ana.of('call.state')[0]!.callId;
    // 400 frames of one second each, sent at once: 400 s of "microphone" in a few milliseconds.
    const frame = encodeAudioFrame(AudioFrameType.OperatorMic, silencePcm16(1000));
    for (let i = 0; i < 400; i++) ana.sendBinary(frame);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(ana.ws.readyState).toBe(WebSocket.OPEN);
    sim.send({ type: 'sim.hangup' });
    await waitFor(() => ana.of('call.ended').length === 1, 'the call to end');
    const recorded = (await stat(join(s.dataDir, 'recordings', callId, 'operator.pcm'))).size;
    expect(recorded).toBeLessThanOrEqual(AUDIO_BURST_BYTES + 2 * 32_000);
  });

  it('limits failed logins per address whatever the user name tried, and bounds its table', async () => {
    const s = await boot();
    for (let i = 0; i < 20; i++) {
      const attempt = await s.api('/api/login', { method: 'POST', body: { username: `usuario${i}`, password: 'incorrecta-1' } });
      expect(attempt.status).toBe(401);
    }
    const blocked = await s.api('/api/login', { method: 'POST', body: ANA });
    expect(blocked.status).toBe(429);
  });

  it('answers 400, not 500, to a malformed percent-escape in the path', async () => {
    const s = await boot();
    const token = await s.login(ANA);
    const bad = await s.api('/api/calls/%E0%A4%A', { token });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('bad_request');
    expect((await s.api('/api/calls/%E0%A4%A/audio/passenger', { token })).status).toBe(400);
  });

  it('LANGUAGE_CATALOG_LIVE=true refreshes the catalogue at start (and only then)', async () => {
    const fakeCatalog = (): { provider: NonNullable<ApplicationOverrides['catalog']>; refreshes: () => number } => {
      let refreshes = 0;
      const live: LanguageCatalog = { ...documentationCatalog(), source: 'live', fetchedAt: 123 };
      return {
        provider: {
          getCatalog: async () => (refreshes > 0 ? live : documentationCatalog()),
          refresh: async () => {
            refreshes += 1;
            return live;
          },
        },
        refreshes: () => refreshes,
      };
    };
    const off = fakeCatalog();
    const quiet = await boot({}, { catalog: off.provider });
    expect(off.refreshes()).toBe(0);
    expect((await quiet.api('/api/languages', { token: await quiet.login(ANA) })).json.source).toBe('documentation');
    const on = fakeCatalog();
    const live = await boot({ LANGUAGE_CATALOG_LIVE: 'true' }, { catalog: on.provider });
    expect(on.refreshes()).toBe(1);
    expect((await live.api('/api/languages', { token: await live.login(ANA) })).json).toMatchObject({ source: 'live', fetchedAt: 123 });
  });

  it('with real providers a key is only "configured" until a real connection test succeeds; the status is broadcast', async () => {
    let answer: ConnectionTestResult['status'] = 'ok';
    const tester = {
      test: async (service: ConnectionTestResult['service']): Promise<ConnectionTestResult> => ({
        service,
        status: answer,
        message: answer === 'ok' ? 'Respuesta correcta' : 'Clave rechazada (401)',
        contactedRealService: true,
        latencyMs: 12,
        testedAt: Date.now(),
      }),
    };
    const s = await boot({ PROVIDERS: 'elevenlabs' }, { tester });
    const ana = await s.operator(ANA);
    expect(ana.of('system.status')[0]).toMatchObject({ elevenlabs: 'unconfigured', translator: 'unconfigured', channel: 'simulated' });

    const admin = await s.login(ADMIN);
    await s.api('/api/settings/keys', { method: 'PUT', token: admin, body: { keys: { ELEVENLABS_API_KEY: 'xi-prueba-0123456789abcdef' } } });
    await waitFor(() => ana.of('system.status').some((m) => m.elevenlabs === 'configured'), 'the configured status');
    expect(ana.of('system.status').at(-1)!.detail?.elevenlabs).toContain('sin comprobar');
    expect(ana.of('system.status').at(-1)!.translator).toBe('unconfigured');

    expect((await s.api('/api/settings/test/elevenlabs', { method: 'POST', token: admin })).json.status).toBe('ok');
    await waitFor(() => ana.of('system.status').some((m) => m.elevenlabs === 'ok'), 'the ok status');
    expect(ana.of('system.status').at(-1)!.detail?.elevenlabs).toContain('Comprobado');

    answer = 'fail';
    await s.api('/api/settings/test/elevenlabs', { method: 'POST', token: admin });
    await waitFor(() => ana.of('system.status').at(-1)?.elevenlabs === 'down', 'the down status');
    expect(ana.of('system.status').at(-1)!.detail?.elevenlabs).toContain('Clave rechazada');

    // A key change forgets the old result: back to "configured".
    await s.api('/api/settings/keys', { method: 'PUT', token: admin, body: { keys: { ELEVENLABS_API_KEY: 'xi-otra-0123456789abcdef' } } });
    await waitFor(() => ana.of('system.status').at(-1)?.elevenlabs === 'configured', 'configured again');
  });
});

describe('modo audio del PC (local calls over the wire)', () => {
  const EN = 'my flight was cancelled and I need a hotel';
  const cableVoice = () => synthesizeSpeechSignal(EN, { pitchHz: 200 });

  it('runs next to the mock channel: 0x04 frames feed the passenger lane, the translated operator voice leaves as 0x05 and the history says local', async () => {
    const s = await boot();
    const ana = await s.operator(ANA);
    expect(ana.of('auth.ok')[0]!.server).toMatchObject({ channel: 'mock', localAudio: true, debug: true });

    ana.send({ type: 'call.startLocal', label: 'WhatsApp', langHint: 'en', languages: { passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'follow' } } });
    await waitFor(() => ana.of('call.state').some((m) => m.state === 'active'), 'the local call to become active');
    const state = ana.of('call.state').at(-1)!;
    expect(state).toMatchObject({ state: 'active', direction: 'local', remoteNumber: 'WhatsApp', simulated: false, muted: false });
    const callId = state.callId;
    expect(ana.of('call.incoming')).toHaveLength(0);
    expect(ana.of('call.languages')[0]!.settings).toMatchObject({ passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'follow' } });
    expect(ana.of('presence').at(-1)!.operators[0]).toMatchObject({ status: 'in_call', currentCallId: callId });

    // Nothing arrives from the cable yet: the passenger lane only gets heartbeats, never invented windows.
    await waitFor(() => ana.levelFrameCount(LevelTrack.PassengerIn) >= 3, 'passenger heartbeats');
    expect(ana.levelWindows(LevelTrack.PassengerIn)).toHaveLength(0);

    // The passenger speaks through the cable: text out of band (simulated STT) + real synthetic audio in 0x04 frames.
    ana.send({ type: 'debug.say', text: EN, lang: 'en', as: 'passenger' });
    ana.sendCableAudio(cableVoice());
    await waitFor(() => ana.finals('passenger').length === 1, 'the passenger phrase');
    expect(ana.finals('passenger')[0]).toMatchObject({ originalLang: 'en', originalText: EN, translatedLang: 'es', translatedText: 'Mi vuelo fue cancelado y necesito un hotel.' });
    expect(ana.levelWindows(LevelTrack.PassengerIn).some((w) => w.rms > 0.01)).toBe(true);
    expect(ana.levelWindows(LevelTrack.OperatorIn).every((w) => w.rms === 0)).toBe(true);
    await waitFor(() => ana.audioBytes(AudioFrameType.TranslatedPassenger) > 20_000, 'the translated voice for the operator');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const toOperatorBefore = ana.audioBytes(AudioFrameType.TranslatedPassenger);
    expect(ana.audioBytes(AudioFrameType.TranslatedToPassenger)).toBe(0);

    // The operator answers: the translation goes to the cable (0x05), never to the operator's headphones (0x02).
    ana.send({ type: 'debug.say', text: 'voy a comprobar las opciones de alojamiento disponibles', lang: 'es', as: 'operator' });
    await waitFor(() => ana.finals('operator').length === 1, 'the operator phrase');
    expect(ana.finals('operator')[0]).toMatchObject({ translatedLang: 'en', translatedText: 'I will check the available accommodation options.' });
    await waitFor(() => ana.audioBytes(AudioFrameType.TranslatedToPassenger) > 20_000, 'the translated voice for the passenger');
    expect(ana.levelWindows(LevelTrack.OperatorIn).some((w) => w.rms > 0.01)).toBe(true);
    expect(ana.audioBytes(AudioFrameType.TranslatedPassenger)).toBe(toOperatorBefore);

    ana.send({ type: 'call.hangup', callId });
    await waitFor(() => ana.of('call.ended').length === 1, 'the call to end');
    expect(ana.of('call.ended')[0]).toMatchObject({ callId, reason: 'hangup_operator' });
    await waitFor(() => ana.of('presence').at(-1)?.operators[0]?.status === 'available', 'the operator to be free');

    const token = await s.login(ANA);
    const list = await s.api('/api/calls', { token });
    expect(list.json.calls).toHaveLength(1);
    expect(list.json.calls[0]).toMatchObject({ id: callId, direction: 'local', remoteNumber: 'WhatsApp', passengerLang: 'en', recorded: true, endReason: 'hangup_operator' });
    expect((await s.api('/api/calls?direction=local', { token })).json.calls).toHaveLength(1);
    expect((await s.api('/api/calls?direction=inbound', { token })).json.calls).toHaveLength(0);
    const detail = await s.api(`/api/calls/${callId}`, { token });
    expect(detail.json.segments.map((x: { speaker: string }) => x.speaker).sort()).toEqual(['operator', 'passenger']);
    const wav = new Uint8Array(await (await fetch(`http://127.0.0.1:${s.port}/api/calls/${callId}/audio/passenger`, { headers: { authorization: `Bearer ${token}` } })).arrayBuffer());
    expect(parseWav(wav).pcm.byteLength).toBeGreaterThanOrEqual(cableVoice().byteLength);
  });

  it('CHANNEL=desktop-audio: no phone line and no simulator, only local calls', async () => {
    const s = await boot({ CHANNEL: 'desktop-audio' });
    expect((await s.api('/api/health')).json).toEqual({ ok: true });

    const ana = await s.operator(ANA);
    expect(ana.of('auth.ok')[0]!.server).toMatchObject({ channel: 'desktop-audio', localAudio: true });
    expect(ana.of('system.status')[0]).toMatchObject({ elevenlabs: 'simulated', translator: 'simulated', channel: 'unconfigured' });
    expect(ana.of('system.status')[0]!.detail?.channel).toContain('modo audio del PC');

    const sim = new WebSocket(`ws://127.0.0.1:${s.port}/sim`);
    const outcome = await new Promise<string>((resolve) => {
      sim.once('open', () => resolve('open'));
      sim.once('error', () => resolve('rejected'));
      sim.once('unexpected-response', () => resolve('rejected'));
    });
    expect(outcome).toBe('rejected');

    ana.send({ type: 'call.dial', number: '+34600111222' });
    await waitFor(() => ana.of('error').length === 1, 'the dial refusal');
    expect(ana.of('error')[0]).toMatchObject({ code: 'dial_failed' });
    expect(ana.of('error')[0]!.message).toContain('línea telefónica');

    ana.send({ type: 'call.startLocal', label: 'WhatsApp Desktop', languages: { passengerSpeaks: { mode: 'fixed', lang: 'fr' }, passengerHears: { mode: 'fixed', lang: 'fr' } } });
    await waitFor(() => ana.of('call.state').some((m) => m.state === 'active'), 'the local call to become active');
    expect(ana.of('call.state').at(-1)).toMatchObject({ direction: 'local', remoteNumber: 'WhatsApp Desktop', simulated: false });
    expect(ana.of('call.languages')[0]!.settings).toMatchObject({ passengerSpeaks: { mode: 'fixed', lang: 'fr' }, passengerHears: { mode: 'fixed', lang: 'fr' } });
    const callId = ana.of('call.state').at(-1)!.callId;

    // A second local call while this one runs is refused.
    ana.send({ type: 'call.startLocal', label: 'Otra' });
    await waitFor(() => ana.of('error').length === 2, 'the busy refusal');
    expect(ana.of('error')[1]).toMatchObject({ code: 'operator_busy' });

    ana.send({ type: 'debug.say', text: 'voy a comprobar las opciones de alojamiento disponibles', lang: 'es', as: 'operator' });
    await waitFor(() => ana.finals('operator').length === 1, 'the operator phrase');
    expect(ana.finals('operator')[0]).toMatchObject({ translatedLang: 'fr', translatedText: "Je vais vérifier les options d'hébergement disponibles." });
    await waitFor(() => ana.audioBytes(AudioFrameType.TranslatedToPassenger) > 20_000, 'the voice for the cable');
    expect(ana.audioBytes(AudioFrameType.TranslatedPassenger)).toBe(0);

    ana.send({ type: 'call.hangup', callId });
    await waitFor(() => ana.of('call.ended').length === 1, 'the call to end');
    expect(s.app.localChannel.activeCalls).toBe(0);
    expect((await s.api('/api/calls', { token: await s.login(ANA) })).json.calls[0]).toMatchObject({ direction: 'local', remoteNumber: 'WhatsApp Desktop', passengerLang: 'fr' });
  });
});

describe('startup repair', () => {
  it('closes in the history the calls a previous run left open', async () => {
    const { FileTranscriptStore } = await import('./stores/transcripts.js');
    const { closeCallsLeftOpen } = await import('./application.js');
    const dir = await tempDataDir();
    const store = new FileTranscriptStore(dir);
    const base = { direction: 'inbound' as const, remoteNumber: '+34600', operatorId: 'op1', passengerLang: 'en', createdAt: 1000, answeredAt: 1001, endedAt: null, endReason: null, recorded: false };
    await store.saveCall({ ...base, id: 'left-active', state: 'active' });
    await store.saveCall({ ...base, id: 'left-ringing', state: 'ringing', answeredAt: null });
    await store.saveCall({ ...base, id: 'finished', state: 'ended', endedAt: 5000, endReason: 'hangup_passenger' });
    expect(await closeCallsLeftOpen(store, () => 9000)).toBe(2);
    expect(await store.getCall('left-active')).toMatchObject({ state: 'ended', endedAt: 9000, endReason: 'server_shutdown' });
    expect(await store.getCall('left-ringing')).toMatchObject({ state: 'ended', endReason: 'server_shutdown' });
    expect(await store.getCall('finished')).toMatchObject({ endedAt: 5000, endReason: 'hangup_passenger' });
    expect(await closeCallsLeftOpen(store)).toBe(0);
  });
});
