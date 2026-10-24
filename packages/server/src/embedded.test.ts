import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  AudioFrameType,
  concatPcm,
  encodeAudioFrame,
  encodeMessage,
  parseServerMessage,
  silencePcm16,
  synthesizeSpeechSignal,
  type ServerMessage,
} from '@tw/shared';
import { simulatePassengerCall, startEmbeddedServer, type EmbeddedServer } from './embedded.js';
import { tempDataDir } from './test-utils.js';

const running: EmbeddedServer[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) await server.stop();
});

async function waitFor(condition: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('embedded server (the desktop app)', () => {
  it('serves the operator page, creates the admin, auto-answers a simulated passenger and translates', async () => {
    const dataDir = await tempDataDir();
    const staticDir = join(dataDir, 'pagina');
    await mkdir(join(staticDir, 'assets'), { recursive: true });
    await writeFile(join(staticDir, 'index.html'), '<!doctype html><title>Telecomway</title>');
    await writeFile(join(staticDir, 'assets', 'app-abc.js'), 'console.log(1)');

    const server = await startEmbeddedServer({ dataDir, adminPassword: 'clave-local-1234', staticDir });
    running.push(server);
    expect(server.serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const page = await fetch(`${server.serverUrl}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('Telecomway');
    const asset = await fetch(`${server.serverUrl}/assets/app-abc.js`);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${server.serverUrl}/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
    expect((await fetch(`${server.serverUrl}/api/health`)).status).toBe(200);

    const login = await fetch(`${server.serverUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'clave-local-1234' }),
    });
    expect(login.status).toBe(200);

    const messages: ServerMessage[] = [];
    const ws = new WebSocket(`${server.serverUrl.replace('http', 'ws')}/operator`);
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const parsed = parseServerMessage(data.toString('utf8'));
      if (parsed.ok) messages.push(parsed.value);
    });
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
    ws.send(encodeMessage({ type: 'auth.login', username: 'admin', password: 'clave-local-1234' }));
    await waitFor(() => messages.some((m) => m.type === 'auth.ok'), 'login over the socket');

    const result = await simulatePassengerCall(server.app, {
      lines: [{ text: 'my flight was cancelled and I need a hotel', lang: 'en', pauseMs: 2500 }],
    });
    expect(result.outcome).toBe('completed');
    await waitFor(() => messages.some((m) => m.type === 'call.ended'), 'the call to end');
    expect(messages.some((m) => m.type === 'call.incoming' && m.autoAccept)).toBe(true);
    expect(messages.some((m) => m.type === 'call.state' && m.state === 'active' && m.simulated)).toBe(true);
    const finals = messages.filter((m) => m.type === 'transcript.segment' && m.segment.final && m.segment.speaker === 'passenger');
    expect(finals.length).toBeGreaterThanOrEqual(1);
    expect((finals[0] as Extract<ServerMessage, { type: 'transcript.segment' }>).segment.translatedText).toBe('Mi vuelo fue cancelado y necesito un hotel.');
    ws.close();
  }, 20_000);

  it('a WhatsApp call on this computer uses the real providers: with no key it says so and relays the passenger voice (plan B)', async () => {
    const dataDir = await tempDataDir();
    const server = await startEmbeddedServer({ dataDir, adminPassword: 'clave-local-1234' });
    running.push(server);
    const messages: ServerMessage[] = [];
    const binaryTypes: number[] = [];
    const ws = new WebSocket(`${server.serverUrl.replace('http', 'ws')}/operator`);
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        binaryTypes.push(data[0]!);
        return;
      }
      const parsed = parseServerMessage(data.toString('utf8'));
      if (parsed.ok) messages.push(parsed.value);
    });
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
    ws.send(encodeMessage({ type: 'auth.login', username: 'admin', password: 'clave-local-1234' }));
    await waitFor(() => messages.some((m) => m.type === 'auth.ok'), 'login');
    const auth = messages.find((m): m is Extract<ServerMessage, { type: 'auth.ok' }> => m.type === 'auth.ok')!;
    expect(auth.server).toMatchObject({ providers: 'auto', localAudio: true });
    await waitFor(() => messages.some((m) => m.type === 'system.status'), 'the status');
    const status = messages.filter((m): m is Extract<ServerMessage, { type: 'system.status' }> => m.type === 'system.status').at(-1)!;
    expect(status).toMatchObject({ elevenlabs: 'unconfigured', translator: 'unconfigured' });

    ws.send(encodeMessage({ type: 'call.startLocal', label: 'WhatsApp' }));
    await waitFor(() => messages.some((m) => m.type === 'call.state' && m.state === 'active' && m.direction === 'local'), 'the local call');
    const signal = concatPcm([synthesizeSpeechSignal('hello I need a hotel for tonight please', { pitchHz: 200 }), silencePcm16(200)]);
    for (let round = 0; round < 3 && !binaryTypes.includes(AudioFrameType.OriginalPassenger); round++) {
      for (let offset = 0; offset < signal.byteLength; offset += 640) {
        ws.send(encodeAudioFrame(AudioFrameType.PassengerLocal, signal.slice(offset, offset + 640)));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await waitFor(() => binaryTypes.includes(AudioFrameType.OriginalPassenger), 'the passenger voice relayed');
    const fallback = messages.filter((m): m is Extract<ServerMessage, { type: 'call.fallback' }> => m.type === 'call.fallback').at(-1)!;
    expect(fallback.passengerToOperator).toMatchObject({ originalVoice: true });
    ws.close();
  }, 30_000);

  it('reports when nobody answers', async () => {
    const dataDir = await tempDataDir();
    const server = await startEmbeddedServer({ dataDir, adminPassword: 'clave-local-1234' });
    running.push(server);
    const result = await simulatePassengerCall(server.app, { ringTimeoutMs: 300, lines: [] });
    expect(['rejected', 'not_answered', 'ended_early']).toContain(result.outcome);
  });
});
