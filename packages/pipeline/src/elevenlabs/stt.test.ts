import { afterEach, describe, expect, it, vi } from 'vitest';
import { concatPcm, silencePcm16, synthesizeSpeechSignal, type Logger, type SttFinal, type SttPartial, type SttSession } from '@tw/shared';
import { ElevenLabsConfigError, ElevenLabsError } from './errors.js';
import { ElevenLabsSttProvider, ElevenLabsSttSession, type ElevenLabsSttOptions } from './stt.js';
import { FakeElevenLabsServer, type FakeElevenLabsOptions } from './testing/fake-elevenlabs-server.js';

const EN = 'my flight was cancelled and I need a hotel';

let server: FakeElevenLabsServer;
const sessions: SttSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await server?.close();
});

async function start(options: FakeElevenLabsOptions = {}): Promise<FakeElevenLabsServer> {
  server = await FakeElevenLabsServer.start({ apiKey: 'key-1', ...options });
  return server;
}

function provider(overrides: Partial<ElevenLabsSttOptions> = {}): ElevenLabsSttProvider {
  return new ElevenLabsSttProvider({ getApiKey: () => 'key-1', baseUrl: server.url, reconnectDelayMs: 10, rateLimitDelayMs: 40, connectTimeoutMs: 2000, ...overrides });
}

async function open(stt: ElevenLabsSttProvider, lang?: string) {
  const session = await stt.openSession(lang ? { lang } : {});
  sessions.push(session);
  const partials: SttPartial[] = [];
  const finals: SttFinal[] = [];
  const errors: Error[] = [];
  session.onPartial((partial) => partials.push(partial));
  session.onFinal((final) => finals.push(final));
  session.onError((error) => errors.push(error));
  return { session, partials, finals, errors };
}

const speech = (text: string): Uint8Array => concatPcm([synthesizeSpeechSignal(text, { pitchHz: 200 }), silencePcm16(200)]);

/** Feeds 20 ms chunks, yielding to the event loop now and then so the fake server runs in between. */
async function feed(session: SttSession, signal: Uint8Array, fraction = 1): Promise<void> {
  const end = fraction >= 1 ? signal.byteLength : Math.floor((signal.byteLength * fraction) / 640) * 640;
  for (let offset = 0, index = 0; offset < end; offset += 640, index++) {
    session.sendAudio(signal.slice(offset, Math.min(offset + 640, end)));
    if (index % 5 === 4) await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('ElevenLabs STT against the simulator', () => {
  it('streams PCM16 16 kHz as base64 JSON and turns partial and committed transcripts into events', async () => {
    await start();
    const r = await open(provider());
    server.say(null, { text: EN, lang: 'en', probability: 0.91 });
    const signal = speech(EN);
    await feed(r.session, signal);
    await waitFor(() => r.finals.length === 1, 'the final transcript');

    expect(r.finals[0]).toMatchObject({ text: EN, lang: 'en', langProbability: 0.91, startMs: 0 });
    expect(r.finals[0]!.endMs).toBeGreaterThan(1000);
    expect(r.partials.length).toBeGreaterThan(0);
    expect(EN.startsWith(r.partials[0]!.text)).toBe(true);
    expect(r.partials.at(-1)).toMatchObject({ lang: 'en' });
    expect(r.errors).toHaveLength(0);

    const fake = server.sttSessions[0]!;
    expect(fake.headers['xi-api-key']).toBe('key-1');
    expect(fake.params.get('model_id')).toBe('scribe_v2_realtime');
    expect(fake.params.get('language_code')).toBeNull();
    expect(fake.params.get('audio_format')).toBe('pcm_16000');
    expect(fake.params.get('include_language_detection')).toBe('true');
    await waitFor(() => fake.audioBytes === signal.byteLength, 'the last chunks to arrive');
    expect(fake.messages[0]).toMatchObject({ message_type: 'input_audio_chunk', commit: false, sample_rate: 16000 });
  });

  it('sends the fixed language and converts the audio to the configured wire format', async () => {
    await start();
    const r = await open(provider({ audioFormat: 'ulaw_8000' }), 'fr');
    server.say('fr', { text: 'bonjour je voudrais savoir où est ma navette', lang: 'fr' });
    const signal = speech('bonjour je voudrais savoir où est ma navette');
    await feed(r.session, signal);
    await waitFor(() => r.finals.length === 1, 'the final transcript');
    expect(r.finals[0]).toMatchObject({ lang: 'fr' });
    const fake = server.sttSessions[0]!;
    expect(fake.params.get('language_code')).toBe('fr');
    expect(fake.params.get('audio_format')).toBe('ulaw_8000');
    // 16 kHz PCM16 (2 bytes/sample) to 8 kHz mu-law (1 byte/sample): a quarter of the bytes, give or take a sample.
    await waitFor(() => Math.abs(fake.audioBytes - signal.byteLength / 4) <= 4, 'the last chunks to arrive');
    expect(fake.messages[0]).toMatchObject({ sample_rate: 8000 });
  });

  it('reads the alternative field names and ignores a duplicated committed transcript', async () => {
    await start({ stt: { fieldStyle: 'alternative', duplicateCommits: true } });
    const r = await open(provider());
    server.say(null, { text: EN, lang: 'en' });
    await feed(r.session, speech(EN));
    await waitFor(() => r.finals.length >= 1, 'the final transcript');
    await sleep(60);
    expect(r.finals).toHaveLength(1);
    expect(r.finals[0]).toMatchObject({ text: EN, lang: 'en' });
    expect(r.partials.at(-1)).toMatchObject({ lang: 'en' });
  });

  it('commit() forces the phrase to be finalised with manual commits', async () => {
    await start();
    const r = await open(provider({ commitStrategy: 'manual' }));
    server.say(null, { text: EN, lang: 'en' });
    await feed(r.session, speech(EN), 0.3);
    await sleep(20);
    expect(r.finals).toHaveLength(0);
    r.session.commit();
    await waitFor(() => r.finals.length === 1, 'the committed transcript');
    const fake = server.sttSessions[0]!;
    expect(fake.params.get('commit_strategy')).toBe('manual');
    expect(fake.commits).toBe(1);
    expect(fake.messages.at(-1)).toMatchObject({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true });
  });

  it('rejects a wrong key with a typed, Spanish authentication error', async () => {
    await start({ apiKey: 'secret' });
    const error = await provider({ getApiKey: () => 'wrong' }).openSession({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ElevenLabsError);
    expect(error).toMatchObject({ service: 'stt', kind: 'auth', recoverable: false, code: '401' });
    expect((error as Error).message).toContain('ELEVENLABS_API_KEY');
    expect((error as Error).message).not.toContain('wrong');
    expect(server.refused).toEqual([{ kind: 'stt', status: 401 }]);
  });

  it('fails before connecting when no key is configured', async () => {
    await start();
    const error = await provider({ getApiKey: () => Promise.resolve(undefined) }).openSession({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ElevenLabsConfigError);
    expect((error as Error).message).toContain('ELEVENLABS_API_KEY');
    expect(server.sttSessions).toHaveLength(0);
  });

  it('maps refused upgrades: 429 is recoverable, 404 is not', async () => {
    let status = 429;
    await start({ refuseUpgrade: () => status });
    await expect(provider().openSession({})).rejects.toMatchObject({ kind: 'rate_limited', recoverable: true, code: '429' });
    status = 404;
    await expect(provider().openSession({})).rejects.toMatchObject({ kind: 'config', recoverable: false });
  });

  it('reports a fatal provider error once and stops using the session', async () => {
    await start();
    const r = await open(provider());
    server.sttSessions[0]!.sendError('auth_error', 'invalid key');
    await waitFor(() => r.errors.length === 1, 'the error');
    expect(r.errors[0]).toMatchObject({ kind: 'auth', recoverable: false, code: 'auth_error' });
    expect(r.errors[0]!.message).toContain('ELEVENLABS_API_KEY');
    await feed(r.session, speech(EN));
    await sleep(60);
    expect(server.sttSessions).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
  });

  it('ignores advisory errors and keeps transcribing', async () => {
    await start();
    const r = await open(provider());
    server.sttSessions[0]!.sendError('insufficient_audio_activity');
    server.sttSessions[0]!.sendError('commit_throttled');
    server.sttSessions[0]!.sendError('chunk_size_exceeded');
    await sleep(30);
    server.say(null, { text: EN, lang: 'en' });
    await feed(r.session, speech(EN));
    await waitFor(() => r.finals.length === 1, 'the final transcript');
    expect(r.errors).toHaveLength(0);
    expect(server.sttSessions).toHaveLength(1);
  });

  it('reconnects after the connection drops mid-phrase and replays the unconfirmed audio', async () => {
    await start({ stt: { dropAfterChunks: 40 } });
    const r = await open(provider());
    server.say(null, { text: EN, lang: 'en' });
    const signal = speech(EN);
    await feed(r.session, signal);
    await waitFor(() => r.finals.length === 1, 'the final transcript after reconnecting');
    expect(r.finals[0]).toMatchObject({ text: EN, lang: 'en' });
    expect(r.errors).toHaveLength(0);
    expect(server.sttSessions).toHaveLength(2);
    // Nothing had been committed, so the whole phrase was replayed on the new connection.
    expect(server.sttSessions[1]!.audioBytes).toBe(signal.byteLength);
    expect(server.sttSessions[1]!.params.get('model_id')).toBe('scribe_v2_realtime');
  });

  it('reconnects when the server ends the session (time limit) and after rate_limited, with a longer pause', async () => {
    await start({ stt: { errorAfterChunks: { count: 15, type: 'session_time_limit_exceeded', close: 1000 } } });
    const r = await open(provider());
    server.say(null, { text: EN, lang: 'en' });
    await feed(r.session, speech(EN));
    await waitFor(() => r.finals.length === 1, 'the final after the time limit');
    expect(server.sttSessions).toHaveLength(2);
    expect(r.errors).toHaveLength(0);

    server.sttBehavior.errorAfterChunks = { count: 10, type: 'rate_limited' };
    server.say(null, { text: 'hello thanks where is the hotel please', lang: 'en' });
    const before = Date.now();
    await feed(r.session, speech('hello thanks where is the hotel please'));
    await waitFor(() => r.finals.length === 2, 'the final after rate_limited');
    expect(server.sttSessions).toHaveLength(3);
    expect(Date.now() - before).toBeGreaterThanOrEqual(40);
    expect(r.errors).toHaveLength(0);
  });

  it('gives up after the reconnection budget and reports the loss', async () => {
    await start({ stt: { dropAfterChunks: 5 }, refuseUpgrade: ({ index }) => (index >= 1 ? 503 : null) });
    const r = await open(provider({ maxReconnects: 2 }));
    await feed(r.session, speech(EN));
    await waitFor(() => r.errors.length === 1, 'the final error', 6000);
    expect(r.errors[0]).toMatchObject({ kind: 'transport', code: '503' });
    expect(r.errors[0]!.message).toContain('no se recuperó');
    expect(server.refused.filter((item) => item.status === 503)).toHaveLength(2);
    expect((r.session as ElevenLabsSttSession).reconnectCount).toBe(2);
  });

  it('closes cleanly and ignores audio afterwards', async () => {
    await start();
    const r = await open(provider());
    await r.session.close();
    await r.session.close();
    await waitFor(() => server.sttSessions[0]!.closeCode !== null, 'the server to see the close');
    expect(server.sttSessions[0]!.closeCode).toBe(1000);
    expect(() => r.session.sendAudio(silencePcm16(20))).not.toThrow();
    await sleep(30);
    expect(server.sttSessions).toHaveLength(1);
  });

  it('logs the first unknown message once and never the key', async () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await start({ stt: { extraMessages: [{ message_type: 'brand_new', detail: 1 }, { message_type: 'brand_new', detail: 2 }] } });
    await open(provider({ logger }));
    await waitFor(() => (logger.warn as ReturnType<typeof vi.fn>).mock.calls.length >= 1, 'the warning');
    await sleep(30);
    const warnings = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter((call) => String(call[0]).includes('desconocido'));
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).toContain('brand_new');
    const everything = JSON.stringify([...(logger.debug as ReturnType<typeof vi.fn>).mock.calls, ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls]);
    expect(everything).not.toContain('key-1');
  });
});
