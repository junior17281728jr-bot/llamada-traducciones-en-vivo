import { afterEach, describe, expect, it } from 'vitest';
import { concatPcm, pcmDurationMs, speechSignalDurationMs, type TtsSession, type WireAudioFormat } from '@tw/shared';
import { ElevenLabsConfigError, ElevenLabsError } from './errors.js';
import { ElevenLabsTtsProvider, ElevenLabsTtsSession, type ElevenLabsTtsOptions } from './tts.js';
import { FakeElevenLabsServer, type FakeElevenLabsOptions } from './testing/fake-elevenlabs-server.js';

const VOICES: Record<string, string> = { es: 'voice-es', en: 'voice-en', fr: 'voice-fr' };
const PITCH = { 'voice-es': 120, 'voice-en': 180, 'voice-fr': 230 };

let server: FakeElevenLabsServer;
const sessions: TtsSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await server?.close();
});

async function start(options: FakeElevenLabsOptions = {}): Promise<FakeElevenLabsServer> {
  server = await FakeElevenLabsServer.start({ apiKey: 'key-1', ...options, tts: { voicePitch: PITCH, ...options.tts } });
  return server;
}

function provider(overrides: Partial<ElevenLabsTtsOptions> = {}): ElevenLabsTtsProvider {
  return new ElevenLabsTtsProvider({
    getApiKey: () => 'key-1',
    voiceIdFor: (lang) => VOICES[lang] ?? null,
    baseUrl: server.url,
    keepaliveMs: 0,
    retryDelayMs: 5,
    connectTimeoutMs: 2000,
    ...overrides,
  });
}

async function open(tts: ElevenLabsTtsProvider, lang: string) {
  const session = (await tts.openSession({ lang })) as ElevenLabsTtsSession;
  sessions.push(session);
  const chunks: Uint8Array[] = [];
  const errors: Error[] = [];
  let done = 0;
  session.onAudio((pcm) => chunks.push(pcm));
  session.onDone(() => {
    done += 1;
  });
  session.onError((error) => errors.push(error));
  return { session, chunks, errors, done: () => done };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && Buffer.from(a).equals(Buffer.from(b));
const spoken = () => server.ttsConnections.filter((connection) => connection.spokenText);

describe('ElevenLabs TTS against the simulator', () => {
  it('speaks a phrase on its own connection, delivers exactly the synthesised audio and reports done', async () => {
    await start();
    const r = await open(provider(), 'es');
    expect(server.ttsConnections).toHaveLength(0);
    r.session.speak('Hola, buenos días.');
    r.session.flush();
    await waitFor(() => r.done() === 1, 'done');

    expect(bytesEqual(concatPcm(r.chunks), server.expectedTtsAudio('Hola, buenos días.', 'voice-es', 'pcm_16000'))).toBe(true);
    expect(r.errors).toHaveLength(0);
    const connection = server.ttsConnections[0]!;
    expect(connection.voiceId).toBe('voice-es');
    expect(connection.modelId).toBe('eleven_flash_v2_5');
    expect(connection.outputFormat).toBe('pcm_16000');
    expect(connection.headers['xi-api-key']).toBe('key-1');
    expect(connection.init).toEqual({ text: ' ', voice_settings: { stability: 0.5, similarity_boost: 0.8 }, generation_config: { chunk_length_schedule: [120, 160, 250, 290] } });
    expect(connection.messages[1]).toEqual({ text: 'Hola, buenos días. ', try_trigger_generation: true });
    expect(connection.flushes).toBe(1);
    expect(connection.eosReceived).toBe(true);
    expect(JSON.stringify(connection.messages)).not.toContain('key-1');
  });

  it.each<WireAudioFormat>(['pcm_22050', 'pcm_24000', 'pcm_44100', 'ulaw_8000'])('decodes %s into PCM16 16 kHz', async (format) => {
    await start();
    const text = 'I will check the available accommodation options.';
    const r = await open(provider({ outputFormat: format }), 'en');
    r.session.speak(text);
    r.session.flush();
    await waitFor(() => r.done() === 1, 'done');
    const actual = concatPcm(r.chunks);
    expect(server.ttsConnections[0]!.outputFormat).toBe(format);
    expect(bytesEqual(actual, server.expectedTtsAudio(text, 'voice-en', format))).toBe(true);
    expect(Math.abs(pcmDurationMs(actual) - speechSignalDurationMs(text))).toBeLessThan(5);
  });

  it('opens lazily, prewarm() keeps one connection alive with keep-alives, and the phrase reuses it', async () => {
    await start();
    const r = await open(provider({ keepaliveMs: 15 }), 'es');
    expect(r.session.hasConnection).toBe(false);
    await r.session.prewarm();
    expect(r.session.hasConnection).toBe(true);
    expect(server.ttsConnections).toHaveLength(1);
    await waitFor(() => server.ttsConnections[0]!.keepalives >= 2, 'keep-alives');
    expect(server.ttsConnections[0]!.init).toMatchObject({ text: ' ' });

    r.session.speak('Hola');
    r.session.flush();
    await waitFor(() => r.done() === 1, 'done');
    expect(server.ttsConnections[0]!.spokenText).toBe('Hola');
    // The next connection is pre-opened as soon as the phrase ends.
    await waitFor(() => server.ttsConnections.length === 2, 'the standby connection');
    await r.session.close();
    await waitFor(() => server.ttsConnections.every((connection) => connection.closeCode !== null), 'every connection closed');
  });

  it('plays consecutive phrases in order, the second on the pre-opened connection', async () => {
    await start();
    const r = await open(provider(), 'en');
    const first = 'Good morning, you are speaking with Telecomway.';
    const second = 'Your driver is waiting at the meeting point.';
    r.session.speak(first);
    r.session.flush();
    await waitFor(() => r.done() === 1, 'the first phrase');
    await waitFor(() => server.ttsConnections.length === 2, 'the standby connection');
    r.session.speak('Your driver is waiting');
    r.session.speak('at the meeting point.');
    r.session.flush();
    await waitFor(() => r.done() === 2, 'the second phrase');
    const expected = concatPcm([server.expectedTtsAudio(first, 'voice-en', 'pcm_16000'), server.expectedTtsAudio(second, 'voice-en', 'pcm_16000')]);
    expect(bytesEqual(concatPcm(r.chunks), expected)).toBe(true);
    expect(spoken().map((connection) => connection.spokenText)).toEqual([first, second]);
    expect(r.errors).toHaveLength(0);
  });

  it('fails at openSession, in Spanish, when the language has no voice or the key is missing', async () => {
    await start();
    await expect(provider().openSession({ lang: 'de' })).rejects.toMatchObject({ kind: 'config', message: expect.stringContaining('ELEVENLABS_VOICE_DE') });
    await expect(provider().openSession({ lang: 'xx' })).rejects.toBeInstanceOf(ElevenLabsConfigError);
    await expect(provider({ getApiKey: () => undefined }).openSession({ lang: 'es' })).rejects.toMatchObject({ kind: 'config', message: expect.stringContaining('ELEVENLABS_API_KEY') });
    expect(server.ttsConnections).toHaveLength(0);
  });

  it('surfaces a rejected key: prewarm() rejects and a phrase reports one error without retrying', async () => {
    await start({ apiKey: 'secret' });
    const r = await open(provider({ getApiKey: () => 'wrong' }), 'es');
    const prewarmError = await r.session.prewarm().catch((e: unknown) => e);
    expect(prewarmError).toBeInstanceOf(ElevenLabsError);
    expect(prewarmError).toMatchObject({ service: 'tts', kind: 'auth', recoverable: false });
    r.session.speak('Hola');
    r.session.flush();
    await waitFor(() => r.errors.length === 1, 'the error');
    expect(r.errors[0]).toMatchObject({ kind: 'auth' });
    expect(r.errors[0]!.message).toContain('ELEVENLABS_API_KEY');
    await sleep(30);
    expect(server.refused.filter((item) => item.kind === 'tts')).toHaveLength(2);
    expect(r.done()).toBe(0);
  });

  it('retries the phrase once on a fresh connection when the server fails before any audio', async () => {
    await start({
      tts: {
        onConnection: (connection, index) => {
          if (index === 0) connection.errorBeforeAudio = { error: 'internal_error', message: 'try again', close: 1011 };
        },
      },
    });
    const r = await open(provider(), 'es');
    r.session.speak('Hola, buenos días.');
    r.session.flush();
    await waitFor(() => r.done() === 1, 'done after the retry');
    expect(bytesEqual(concatPcm(r.chunks), server.expectedTtsAudio('Hola, buenos días.', 'voice-es', 'pcm_16000'))).toBe(true);
    expect(spoken().map((connection) => connection.spokenText)).toEqual(['Hola, buenos días.', 'Hola, buenos días.']);
    expect(r.errors).toHaveLength(0);
  });

  it('retries once after a rate-limited upgrade', async () => {
    await start({ refuseUpgrade: ({ kind, index }) => (kind === 'tts' && index === 0 ? 429 : null) });
    const r = await open(provider(), 'es');
    r.session.speak('Hola');
    r.session.flush();
    await waitFor(() => r.done() === 1, 'done');
    expect(server.refused).toEqual([{ kind: 'tts', status: 429 }]);
    expect(r.errors).toHaveLength(0);
  });

  it('reports an error, without retrying, when the connection drops after audio started', async () => {
    await start({
      tts: {
        paceMs: 2,
        onConnection: (connection, index) => {
          if (index === 0) connection.terminateAfterChunks = 3;
        },
      },
    });
    const r = await open(provider(), 'es');
    r.session.speak('Hola, buenos días, le atiende Telecomway.');
    r.session.flush();
    await waitFor(() => r.errors.length === 1, 'the error');
    expect(r.errors[0]).toMatchObject({ kind: 'transport', recoverable: true });
    expect(r.chunks).toHaveLength(3);
    await sleep(40);
    expect(r.done()).toBe(0);
    expect(spoken()).toHaveLength(1);
  });

  it('cancel() drops the rest of the phrase with neither done nor error', async () => {
    await start({ tts: { paceMs: 5, chunkMs: 20 } });
    const r = await open(provider({ standby: false }), 'es');
    r.session.speak('Hola, buenos días, le atiende Telecomway, dígame en qué puedo ayudarle.');
    r.session.flush();
    await waitFor(() => r.chunks.length >= 2, 'some audio');
    r.session.cancel();
    const delivered = r.chunks.length;
    await sleep(80);
    expect(r.chunks.length).toBe(delivered);
    expect(r.done()).toBe(0);
    expect(r.errors).toHaveLength(0);
    await waitFor(() => server.ttsConnections[0]!.closeCode !== null, 'the server to see the close');
  });

  it('flush() with nothing queued reports done at once', async () => {
    await start();
    const r = await open(provider(), 'es');
    r.session.flush();
    await waitFor(() => r.done() === 1, 'done');
    expect(server.ttsConnections).toHaveLength(0);
  });

  it('replaces a standby connection the server closed, silently', async () => {
    await start();
    const r = await open(provider(), 'es');
    await r.session.prewarm();
    server.ttsConnections[0]!.close(1000);
    await sleep(30);
    expect(r.errors).toHaveLength(0);
    r.session.speak('Hola');
    r.session.flush();
    await waitFor(() => r.done() === 1, 'done');
    expect(spoken()).toHaveLength(1);
    expect(spoken()[0]).toBe(server.ttsConnections[1]);
  });

  it('close() is idempotent and ignores later calls', async () => {
    await start();
    const r = await open(provider(), 'es');
    await r.session.prewarm();
    await r.session.close();
    await r.session.close();
    r.session.speak('Hola');
    r.session.flush();
    await sleep(30);
    expect(server.ttsConnections).toHaveLength(1);
    expect(r.done()).toBe(0);
  });
});
