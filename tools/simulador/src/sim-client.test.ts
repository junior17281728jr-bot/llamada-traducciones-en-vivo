import { WebSocket } from 'ws';
import { synthesizeSpeechSignal } from '@tw/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { SimClient, SimClientError, normalizeServerUrl } from './sim-client.js';
import { FakeSimServer } from './testing/fake-sim-server.js';
import { waitFor } from './testing/wait-for.js';

const servers: FakeSimServer[] = [];
const clients: SimClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.stop();
});

async function start(options: Parameters<typeof FakeSimServer.start>[0] = {}): Promise<FakeSimServer> {
  const server = await FakeSimServer.start(options);
  servers.push(server);
  return server;
}

async function connect(server: FakeSimServer, burstGapMs = 30): Promise<SimClient> {
  const client = await SimClient.connect({ url: server.baseUrl, burstGapMs });
  clients.push(client);
  return client;
}

describe('normalizeServerUrl', () => {
  it('adds the /sim path and the ws scheme', () => {
    expect(normalizeServerUrl('ws://127.0.0.1:8787')).toBe('ws://127.0.0.1:8787/sim');
    expect(normalizeServerUrl('ws://127.0.0.1:8787/')).toBe('ws://127.0.0.1:8787/sim');
    expect(normalizeServerUrl('ws://127.0.0.1:8787/sim')).toBe('ws://127.0.0.1:8787/sim');
    expect(normalizeServerUrl('127.0.0.1:8787')).toBe('ws://127.0.0.1:8787/sim');
    expect(normalizeServerUrl('http://localhost:8787')).toBe('ws://localhost:8787/sim');
    expect(normalizeServerUrl('https://ejemplo.test')).toBe('wss://ejemplo.test/sim');
  });

  it('rejects other paths, schemes and garbage', () => {
    expect(() => normalizeServerUrl('ws://127.0.0.1:8787/operator')).toThrow(/La ruta del simulador es \/sim/);
    expect(() => normalizeServerUrl('ftp://x')).toThrow(/debe empezar por ws:\/\//);
    expect(() => normalizeServerUrl('   ')).toThrow(/Falta la dirección/);
    expect(() => normalizeServerUrl('ws://:::')).toThrow(SimClientError);
  });
});

describe('SimClient', () => {
  it('fails clearly when nothing listens', async () => {
    await expect(SimClient.connect({ url: 'ws://127.0.0.1:1', connectTimeoutMs: 2000 })).rejects.toThrow(/No se pudo conectar con ws:\/\/127\.0\.0\.1:1\/sim/);
  });

  it('places an inbound call and follows its states', async () => {
    const server = await start({ answerDelayMs: 10 });
    const client = await connect(server);
    client.incoming('+447700900123', 'en');
    const active = await client.waitForState((state) => state.state === 'active', 2000);
    expect(active).toMatchObject({ state: 'active', direction: 'inbound', remoteNumber: '+447700900123' });
    expect(client.states.map((state) => state.state)).toEqual(['ringing', 'active']);
    expect(client.callId).toBe(server.calls[0]!.id);
    client.hangup();
    const ended = await client.waitForState((state) => state.state === 'ended', 2000);
    expect(ended?.reason).toBe('hangup_passenger');
  });

  it('validates outgoing messages with the shared schema before sending', async () => {
    const server = await start();
    const client = await connect(server);
    expect(() => client.incoming('abc', 'en')).toThrow(/Mensaje no válido para el servidor: from/);
    // @ts-expect-error an unknown language must be rejected at runtime too
    expect(() => client.incoming('+447700900123', 'xx')).toThrow(/lang/);
    expect(() => client.say('', 'en')).toThrow(/text/);
    expect(server.invalidMessages).toEqual([]);
  });

  it('merges audio chunks into heard bursts and resolves waits placed before or after the burst', async () => {
    const server = await start({ replyToSay: false });
    const client = await connect(server, 40);
    client.incoming('+447700900123', 'en');
    await client.waitForState((state) => state.state === 'active', 2000);
    const callId = client.callId!;
    const chunks: number[] = [];
    client.on('audio', (chunk) => chunks.push(chunk.ms));

    const pcm = synthesizeSpeechSignal('hello hello', { msPerChar: 10 });
    const pending = client.waitForHeard(2000);
    server.sendAudioToPassenger(callId, pcm.subarray(0, 640), 'primera parte');
    server.sendAudioToPassenger(callId, pcm.subarray(640, 1280));
    server.sendAudioToPassenger(callId, pcm.subarray(1280, 1920), 'última');
    const burst = await pending;
    expect(burst).toMatchObject({ ms: 60, chunks: 3, text: 'primera parte última' });
    expect(chunks).toEqual([20, 20, 20]);
    expect(client.heardBursts).toBe(1);
    expect(client.heardMs).toBe(60);

    // A burst that closed after the mark resolves immediately for a later wait.
    const mark = client.heardBursts;
    server.sendAudioToPassenger(callId, pcm.subarray(0, 320));
    await waitFor(() => client.heardBursts === 2, 'second burst');
    expect(await client.waitForHeard(50, mark)).toMatchObject({ ms: 10, chunks: 1 });
    // Nothing new: the wait times out with null.
    expect(await client.waitForHeard(30, client.heardBursts)).toBeNull();
  });

  it('reports server messages that do not follow the protocol and closes cleanly', async () => {
    const server = await start();
    const client = await connect(server);
    const errors: string[] = [];
    client.on('protocolError', (detail) => errors.push(detail));
    const phone = [...server.phones][0]!;
    phone.ws.send('esto no es json');
    phone.ws.send(JSON.stringify({ type: 'sim.state', state: 'volando', callId: null }));
    await waitFor(() => errors.length === 2, 'protocol errors');
    expect(errors[0]).toBe('Invalid JSON');
    expect(errors[1]).toMatch(/state/);
    const closed = client.waitForClose(2000);
    await client.close();
    expect(await closed).toBe(true);
    expect(client.isClosed).toBe(true);
    expect(client.closeReason?.code).toBe(1000);
    expect(() => client.hangup()).toThrow(/cerrada/);
  });

  it('is told when the server closes the socket, and a wait placed earlier resolves null', async () => {
    const server = await start();
    const client = await connect(server);
    const wait = client.waitForState((state) => state.state === 'active', 5000);
    const phone = [...server.phones][0]!;
    phone.ws.close(1008, 'simulator is local only');
    expect(await wait).toBeNull();
    await waitFor(() => client.isClosed, 'close');
    expect(client.closeReason).toEqual({ code: 1008, reason: 'simulator is local only' });
  });

  it('the fake server only serves /sim', async () => {
    const server = await start();
    const outcome = await new Promise<string>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/operator`);
      socket.once('open', () => resolve('open'));
      socket.once('error', () => resolve('rejected'));
      socket.once('unexpected-response', () => resolve('rejected'));
    });
    expect(outcome).toBe('rejected');
  });
});
