import { afterEach, describe, expect, it } from 'vitest';
import { Log, memoryReporter } from './output.js';
import { parseScript } from './script.js';
import { runScript, sleepUnless, stopSignal } from './script-runner.js';
import { SimClient } from './sim-client.js';
import { FakeSimServer } from './testing/fake-sim-server.js';
import { waitFor } from './testing/wait-for.js';

const servers: FakeSimServer[] = [];
const clients: SimClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.stop();
});

async function activeCall(options: Parameters<typeof FakeSimServer.start>[0] = {}): Promise<{ server: FakeSimServer; client: SimClient }> {
  const server = await FakeSimServer.start({ answerDelayMs: 5, replyDelayMs: 10, replyChunkGapMs: 2, ...options });
  servers.push(server);
  const client = await SimClient.connect({ url: server.url, burstGapMs: 30 });
  clients.push(client);
  client.incoming('+447700900123', 'en');
  await client.waitForState((state) => state.state === 'active', 2000);
  return { server, client };
}

const script = parseScript({
  nombre: 'Tres líneas',
  idioma: 'en',
  esperaRespuestaMs: 5000,
  lineas: [
    { texto: 'Hello, my flight was cancelled.', pausaMs: 1000, esperarRespuesta: true },
    { texto: 'Merci.', idioma: 'fr', pausaMs: 2000 },
    { texto: 'I need a hotel for tonight, please.', esperarRespuesta: true },
  ],
});

describe('runScript', () => {
  it('says every line in order, honours pauses and waits for the translated replies', async () => {
    const { server, client } = await activeCall();
    const { reporter, texts } = memoryReporter();
    const started = Date.now();
    const result = await runScript({ client, script, log: new Log(reporter), speed: 100 });
    const elapsed = Date.now() - started;
    expect(result).toEqual({ linesSaid: 3, repliesHeard: 2, repliesMissed: 0, stoppedBecause: null });
    expect(server.utterances.map((u) => [u.text, u.lang])).toEqual([
      ['Hello, my flight was cancelled.', 'en'],
      ['Merci.', 'fr'],
      ['I need a hotel for tonight, please.', 'en'],
    ]);
    // Pauses (3 s) and speech (~4 s) at speed 100 are tens of ms, but never zero.
    expect(elapsed).toBeGreaterThanOrEqual(30);
    const lines = texts();
    expect(lines[0]).toBe('Guion «Tres líneas»: 3 líneas.');
    expect(lines).toContain('Guarda silencio 1,0 s antes de la línea 1 (ondas del pasajero planas).');
    expect(lines).toContain('Dice (Inglés): «Hello, my flight was cancelled.»');
    expect(lines).toContain('Dice (Francés): «Merci.»');
    expect(lines.filter((line) => line === 'Espera a oír la respuesta traducida del operador...')).toHaveLength(2);
    expect(lines.at(-1)).toBe('Guion terminado.');
    expect(lines.indexOf('Guarda silencio 2,0 s antes de la línea 2 (ondas del pasajero planas).')).toBeGreaterThan(lines.indexOf('Dice (Inglés): «Hello, my flight was cancelled.»'));
  });

  it('counts a missed reply when the operator stays silent', async () => {
    const { client } = await activeCall({ replyToSay: false });
    const { reporter, texts } = memoryReporter();
    const result = await runScript({ client, script, log: new Log(reporter), speed: 100, replyTimeoutMs: 3000 });
    expect(result).toEqual({ linesSaid: 3, repliesHeard: 0, repliesMissed: 2, stoppedBecause: null });
    expect(texts()).toContain('No oyó ninguna respuesta en 3,0 s; sigue con el guion.');
  });

  it('stops when the operator hangs up in the middle', async () => {
    const { server, client } = await activeCall({ replyToSay: false });
    const long = parseScript({ idioma: 'en', lineas: Array.from({ length: 6 }, (_, i) => ({ texto: `Line number ${i + 1} of a long script.`, pausaMs: 2000 })) });
    const { reporter, texts } = memoryReporter();
    const running = runScript({ client, script: long, log: new Log(reporter), speed: 20 });
    await waitFor(() => server.utterances.length === 1, 'first line');
    server.hangupFromOperator(client.callId!);
    const result = await running;
    expect(result.stoppedBecause).toBe('call_ended');
    expect(result.linesSaid).toBeLessThan(6);
    expect(texts().at(-1)).toMatch(/Guion interrumpido: la llamada terminó tras \d+ líneas\./);
  });

  it('stops on abort and reports it', async () => {
    const { client } = await activeCall({ replyToSay: false });
    const long = parseScript({ idioma: 'en', lineas: Array.from({ length: 6 }, (_, i) => ({ texto: `Line number ${i + 1} of a long script.`, pausaMs: 5000 })) });
    const controller = new AbortController();
    const { reporter, texts } = memoryReporter();
    const running = runScript({ client, script: long, log: new Log(reporter), speed: 10, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    const result = await running;
    expect(result.stoppedBecause).toBe('aborted');
    expect(texts().at(-1)).toMatch(/interrumpido por el usuario/);
  });

  it('ignores the ended state of a previous call thanks to `since`', async () => {
    const { server, client } = await activeCall();
    server.hangupFromOperator(client.callId!);
    await client.waitForState((state) => state.state === 'ended', 1000);
    const since = client.states.length;
    client.incoming('+447700900124', 'en');
    await client.waitForState((state) => state.state === 'active', 2000, since);
    const short = parseScript({ idioma: 'en', lineas: [{ texto: 'Second call line.' }] });
    const { reporter } = memoryReporter();
    expect((await runScript({ client, script: short, log: new Log(reporter), speed: 100 })).stoppedBecause).toBe('call_ended');
    expect((await runScript({ client, script: short, log: new Log(reporter), speed: 100, since })).stoppedBecause).toBeNull();
  });
});

describe('sleepUnless and stopSignal', () => {
  it('resolve early when the call ends', async () => {
    const { server, client } = await activeCall();
    const stop = stopSignal(client);
    const slept = sleepUnless(5000, stop);
    server.hangupFromOperator(client.callId!);
    expect(await slept).toBe(false);
    expect(await sleepUnless(5, new Promise(() => undefined))).toBe(true);
  });
});
