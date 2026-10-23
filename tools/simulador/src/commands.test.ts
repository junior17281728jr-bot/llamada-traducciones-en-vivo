import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT, cargarPrueba, colgar, defaultLoadPhones, escuchar, llamar, type CommandContext } from './commands.js';
import { listRegisteredPhones } from './control.js';
import { Log, memoryReporter, type ReportLine } from './output.js';
import { BUNDLED_SCENARIOS_DIR, loadScript, parseScript } from './script.js';
import { FakeSimServer } from './testing/fake-sim-server.js';
import { waitFor } from './testing/wait-for.js';

const servers: FakeSimServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

async function start(options: Parameters<typeof FakeSimServer.start>[0] = {}): Promise<FakeSimServer> {
  const server = await FakeSimServer.start({ answerDelayMs: 10, replyDelayMs: 10, replyChunkGapMs: 2, ...options });
  servers.push(server);
  return server;
}

function context(extra: Partial<CommandContext> = {}): { ctx: CommandContext; lines: ReportLine[]; texts: () => string[] } {
  const { reporter, lines, texts } = memoryReporter();
  return { ctx: { log: new Log(reporter), controlDir: null, speed: 100, burstGapMs: 30, ...extra }, lines, texts };
}

const guion = parseScript({
  nombre: 'Corto',
  idioma: 'en',
  esperaRespuestaMs: 5000,
  lineas: [
    { texto: 'Hello, my flight was cancelled and I need a hotel.', pausaMs: 500, esperarRespuesta: true },
    { texto: 'Thank you, goodbye.', pausaMs: 300 },
  ],
});

describe('llamar', () => {
  it('rings, is answered, recites the script, hears the replies and hangs up', async () => {
    const server = await start();
    const { ctx, texts, lines } = context();
    const result = await llamar({ servidor: server.baseUrl, desde: '+447700900123', idioma: 'en', guion }, ctx);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.summary).toMatchObject({ numero: '+447700900123', answered: true, endReason: 'hangup_passenger', linesSaid: 2, repliesHeard: 1, repliesMissed: 0 });
    // The fake replies to every line; the reply to the last one may or may not land before the hangup.
    expect(result.summary!.heardBursts).toBeGreaterThanOrEqual(1);
    expect(result.summary!.heardMs).toBeGreaterThan(0);
    expect(result.summary!.callId).toBe(server.calls[0]!.id);
    expect(server.calls[0]).toMatchObject({ state: 'ended', reason: 'hangup_passenger', remoteNumber: '+447700900123', lang: 'en' });
    expect(server.utterances.map((u) => u.text)).toEqual(['Hello, my flight was cancelled and I need a hotel.', 'Thank you, goodbye.']);

    const out = texts();
    expect(out[0]).toMatch(/^Conectado al simulador del servidor \(ws:\/\/127\.0\.0\.1:\d+\/sim\)\. Todo lo que ocurre aquí es simulado\.$/);
    expect(out).toContain('Llama desde +447700900123 hablando Inglés con el guion «Corto».');
    expect(out).toContain('Suena en el servidor: llamada entrante desde +447700900123 (Inglés), esperando a un operador.');
    expect(out.some((line) => /^Contestada: un operador ha cogido la llamada [0-9a-f]{8}\.$/.test(line))).toBe(true);
    expect(out).toContain('Dice (Inglés): «Hello, my flight was cancelled and I need a hotel.»');
    expect(out.some((line) => /^Oye audio de \d+ ms \(voz traducida del operador, sintética, 3 tramas\)$/.test(line))).toBe(true);
    expect(out).toContain('Fin del guion: cuelga.');
    expect(out.some((line) => /^Colgada: el pasajero colgó \(duró .+\)\.$/.test(line))).toBe(true);
    expect(out.at(-1)).toMatch(/^Resumen: contestada; dijo 2 líneas; oyó .+ de audio sintético en [12] ráfagas; terminó porque el pasajero colgó\.$/);
    expect(out.indexOf('Fin del guion: cuelga.')).toBeLessThan(out.findIndex((line) => line.startsWith('Colgada:')));
    expect(lines.every((line) => line.phone === '+447700900123')).toBe(true);
    expect(lines.every((line) => line.level === 'info')).toBe(true);
  });

  it('reports a call the server rejects and exits with code 2', async () => {
    const server = await start({ maxCalls: 0 });
    const { ctx, texts } = context();
    const result = await llamar({ servidor: server.baseUrl, desde: '+447700900123', idioma: 'en', guion }, ctx);
    expect(result.exitCode).toBe(EXIT.CALL_FAILED);
    expect(result.summary).toMatchObject({ answered: false, endReason: 'rejected', linesSaid: 0 });
    expect(texts()).toContain('No llegó a establecerse: rechazada por el servidor (todas las líneas ocupadas o ningún operador libre).');
    expect(server.utterances).toEqual([]);
  });

  it('gives up when nobody answers in time', async () => {
    const server = await start({ autoAnswer: false });
    const { ctx, texts } = context();
    const result = await llamar({ servidor: server.baseUrl, desde: '+447700900123', idioma: 'en', guion, esperaContestacionMs: 3000 }, ctx);
    expect(result.exitCode).toBe(EXIT.CALL_FAILED);
    expect(texts()).toContain('Nadie contestó en 3,0 s.');
    expect(texts()).toContain('Nadie contestó a tiempo: cuelga.');
    await waitFor(() => server.calls[0]!.state === 'ended', 'the call to end');
  });

  it('exits with code 3 when the server is not reachable', async () => {
    const { ctx, texts, lines } = context();
    const result = await llamar({ servidor: 'ws://127.0.0.1:1', desde: '+447700900123', idioma: 'en' }, ctx);
    expect(result.exitCode).toBe(EXIT.CONNECTION);
    expect(texts()[0]).toMatch(/^No se pudo conectar con el simulador del servidor: No se pudo conectar con ws:\/\/127\.0\.0\.1:1\/sim/);
    expect(texts()[1]).toMatch(/CHANNEL=mock/);
    expect(lines.every((line) => line.level === 'error')).toBe(true);
  });

  it('without a script stays on the line until the operator hangs up', async () => {
    const server = await start();
    const { ctx, texts } = context();
    const running = llamar({ servidor: server.baseUrl, desde: '+447700900123', idioma: 'en' }, ctx);
    await waitFor(() => server.activeCalls.length === 1, 'active call');
    server.hangupFromOperator(server.calls[0]!.id);
    const result = await running;
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.summary).toMatchObject({ answered: true, endReason: 'hangup_operator', linesSaid: 0 });
    expect(texts()).toContain('Sin guion: la llamada queda abierta hasta que el operador cuelgue, se ejecute «colgar» o se pulse Ctrl+C.');
    expect(texts().some((line) => line.startsWith('Colgada: el operador colgó'))).toBe(true);
  });

  it('can be hung up from another process through «colgar»', async () => {
    const server = await start();
    const dir = await mkdtemp(join(tmpdir(), 'tw-sim-colgar-'));
    const caller = context({ controlDir: dir });
    const running = llamar({ servidor: server.baseUrl, desde: '+447700900123', idioma: 'en' }, caller.ctx);
    await waitFor(() => server.activeCalls.length === 1, 'active call');
    expect(await listRegisteredPhones(dir)).toHaveLength(1);

    const other = context();
    const hung = await colgar({ dir }, other.ctx);
    expect(hung.exitCode).toBe(EXIT.OK);
    expect(hung.outcomes.map((o) => o.result)).toEqual(['ok']);
    expect(other.texts()[0]).toMatch(/^Colgado: \+447700900123 \(llamar, proceso \d+\)\.$/);

    const result = await running;
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.summary).toMatchObject({ answered: true, endReason: 'hangup_passenger' });
    expect(caller.texts()).toContain('Orden «colgar» recibida: cuelga.');
    expect(server.calls[0]!.reason).toBe('hangup_passenger');
    expect(await listRegisteredPhones(dir)).toEqual([]);

    const none = context();
    expect((await colgar({ dir }, none.ctx)).exitCode).toBe(EXIT.OK);
    expect(none.texts()).toEqual(['No hay ningún teléfono simulado en marcha en este equipo.']);
    const filtered = context();
    await colgar({ dir, numero: '+34600000000' }, filtered.ctx);
    expect(filtered.texts()).toEqual(['No hay ningún teléfono simulado en marcha en este equipo con el número +34600000000.']);
  });

  it('hangs up when interrupted by the user', async () => {
    const server = await start({ replyToSay: false });
    const controller = new AbortController();
    const { ctx, texts } = context({ signal: controller.signal, speed: 10 });
    const long = parseScript({ idioma: 'en', lineas: Array.from({ length: 5 }, (_, i) => ({ texto: `Line ${i + 1}, quite a long sentence to read aloud.`, pausaMs: 3000 })) });
    const running = llamar({ servidor: server.baseUrl, desde: '+447700900123', idioma: 'en', guion: long }, ctx);
    await waitFor(() => server.utterances.length >= 1, 'first line');
    controller.abort();
    const result = await running;
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.script?.stoppedBecause).toBe('aborted');
    expect(texts()).toContain('Interrumpido: cuelga.');
    expect(server.calls[0]!.reason).toBe('hangup_passenger');
  });
});

describe('escuchar', () => {
  it('answers the outbound call, recites the script and stays until the operator hangs up', async () => {
    const server = await start();
    const { ctx, texts, lines } = context();
    const running = escuchar({ servidor: server.baseUrl, idioma: 'pt', guion, contestarTrasMs: 300, esperaLlamadaMs: 5000 }, ctx);
    await waitFor(() => [...server.phones].some((phone) => phone.listening === 'pt'), 'listening phone');
    const call = server.dial('+351912345678')!;
    expect(call).toBeTruthy();
    await waitFor(() => call.state === 'active', 'answer');
    await waitFor(() => server.utterances.length === 2, 'script lines');
    await waitFor(() => texts().includes('Sigue al teléfono hasta que el operador cuelgue (o hasta «colgar» / Ctrl+C).'), 'the phone to stay on the line');
    server.hangupFromOperator(call.id);
    const result = await running;
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toMatchObject({ answered: true, endReason: 'hangup_operator', linesSaid: 2, repliesHeard: 1 });
    const out = texts();
    expect(out).toContain('Teléfono libre (Portugués): contestará la próxima llamada saliente que marque un operador. Espera como mucho 5,0 s.');
    expect(out).toContain('Suena: el operador llama al +351912345678 (este teléfono habla Portugués).');
    expect(out).toContain('Descuelga.');
    expect(out.some((line) => /^Contestada: hablando con el operador \(llamada [0-9a-f]{8}\)\.$/.test(line))).toBe(true);
    expect(lines.find((line) => line.text === 'Descuelga.')?.phone).toBe('+351912345678');
    expect(lines[0]!.phone).toBe('teléfono libre');
  });

  it('can hang up by itself after the script and repeat for the next call', async () => {
    const server = await start();
    const controller = new AbortController();
    const { ctx, texts } = context({ signal: controller.signal });
    const running = escuchar({ servidor: server.baseUrl, idioma: 'fr', guion, contestarTrasMs: 100, colgarAlTerminar: true, repetir: true }, ctx);
    await waitFor(() => [...server.phones].some((phone) => phone.listening === 'fr'), 'listening phone');
    const first = server.dial('+33111111111')!;
    await waitFor(() => first.state === 'ended', 'first call to end');
    expect(first.reason).toBe('hangup_passenger');
    await waitFor(() => texts().includes('Vuelve a quedar libre para la próxima llamada saliente.'), 'back to listening');
    const second = server.dial('+33222222222')!;
    expect(second).toBeTruthy();
    await waitFor(() => second.state === 'ended', 'second call to end');
    await waitFor(() => texts().filter((line) => line === 'Vuelve a quedar libre para la próxima llamada saliente.').length === 2, 'listening again');
    controller.abort();
    const result = await running;
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.calls.map((call) => [call.answered, call.endReason, call.linesSaid])).toEqual([
      [true, 'hangup_passenger', 2],
      [true, 'hangup_passenger', 2],
    ]);
    expect(server.utterances).toHaveLength(4);
    expect(texts()).toContain('Interrumpido mientras esperaba una llamada.');
  });

  it('gives up when no outbound call arrives', async () => {
    const server = await start();
    const { ctx, texts } = context();
    const result = await escuchar({ servidor: server.baseUrl, idioma: 'de', esperaLlamadaMs: 2000 }, ctx);
    expect(result.exitCode).toBe(EXIT.CALL_FAILED);
    expect(result.calls).toEqual([]);
    expect(texts()).toContain('No llegó ninguna llamada saliente en 2,0 s.');
  });

  it('notices when the operator cancels before it picks up', async () => {
    const server = await start();
    const { ctx, texts } = context();
    const running = escuchar({ servidor: server.baseUrl, idioma: 'it', contestarTrasMs: 5000, esperaLlamadaMs: 2000 }, ctx);
    await waitFor(() => [...server.phones].some((phone) => phone.listening === 'it'), 'listening phone');
    const call = server.dial('+39000000000')!;
    await waitFor(() => texts().some((line) => line.startsWith('Suena:')), 'ringing');
    server.hangupFromOperator(call.id, 'cancelled');
    const result = await running;
    expect(result.exitCode).toBe(EXIT.CALL_FAILED);
    expect(texts()).toContain('El operador colgó antes de que descolgara.');
    expect(result.calls[0]).toMatchObject({ answered: false, endReason: 'cancelled' });
  });
});

describe('cargar-prueba', () => {
  it('runs the three bundled scenarios at once and verifies that a fourth call is rejected', async () => {
    const server = await start({ maxCalls: 3 });
    const { ctx, texts, lines } = context();
    const result = await cargarPrueba({ servidor: server.baseUrl }, ctx);
    expect(result).toMatchObject({ exitCode: EXIT.OK, activas: 3, total: 3, cuarta: 'rechazada' });
    expect(result.resumenes.map((r) => [r.numero, r.answered, r.endReason])).toEqual([
      ['+447700900123', true, 'hangup_passenger'],
      ['+33612345678', true, 'hangup_passenger'],
      ['+393123456789', true, 'hangup_passenger'],
    ]);
    const phones = await defaultLoadPhones(BUNDLED_SCENARIOS_DIR);
    const expectedLines = phones.reduce((n, p) => n + p.guion.lineas.length, 0);
    expect(server.utterances).toHaveLength(expectedLines);
    expect(new Set(server.utterances.map((u) => u.lang))).toEqual(new Set(['en', 'fr', 'it']));
    expect(server.rejected).toHaveLength(1);
    expect(server.rejected[0]!.remoteNumber).toBe('+4915123456789');
    expect(server.calls.filter((call) => call.state === 'ended' && call.reason === 'hangup_passenger')).toHaveLength(3);
    const out = texts();
    expect(out[0]).toMatch(/^Prueba de carga: 3 llamadas simultáneas contra ws:\/\/127\.0\.0\.1:\d+ \(todo simulado\)\.$/);
    expect(out).toContain('Las 3 llamadas están activas a la vez.');
    expect(out).toContain('La llamada 4 fue rechazada por el servidor: el límite de 3 llamadas simultáneas se cumple.');
    expect(out.at(-1)).toBe('Resultado de la prueba de carga: 3 de 3 llamadas activas a la vez; llamada 4: rechazada (correcto).');
    expect(lines.filter((line) => line.phone === '+4915123456789').some((line) => line.text.startsWith('No llegó a establecerse: rechazada'))).toBe(true);
    expect(lines.some((line) => line.level === 'error')).toBe(false);
  });

  it('fails when the server cannot hold three calls at once', async () => {
    const server = await start({ maxCalls: 2 });
    const { ctx, texts } = context();
    const result = await cargarPrueba({ servidor: server.baseUrl }, ctx);
    expect(result).toMatchObject({ exitCode: EXIT.CALL_FAILED, activas: 2, total: 3, cuarta: 'no_probada' });
    expect(texts()).toContain('Solo 2 de 3 llamadas llegaron a activa.');
    expect(texts().at(-1)).toBe('Resultado de la prueba de carga: 2 de 3 llamadas activas a la vez; llamada 4: no probada.');
  });

  it('fails when the server accepts the fourth call', async () => {
    const server = await start({ maxCalls: 10 });
    const { ctx, texts } = context();
    const result = await cargarPrueba({ servidor: server.baseUrl }, ctx);
    expect(result).toMatchObject({ exitCode: EXIT.CALL_FAILED, activas: 3, cuarta: 'aceptada' });
    expect(texts()).toContain('La llamada 4 fue ACEPTADA: el servidor no está limitando a 3 llamadas simultáneas.');
    expect(server.calls).toHaveLength(4);
    expect(server.calls.every((call) => call.state === 'ended')).toBe(true);
  });

  it('can skip the fourth call and accepts custom phones', async () => {
    const server = await start({ maxCalls: 2 });
    const { ctx } = context();
    const script = await loadScript(join(BUNDLED_SCENARIOS_DIR, 'cambio-de-idioma.json'));
    const result = await cargarPrueba(
      { servidor: server.baseUrl, probarCuarta: false, telefonos: [{ desde: '+5511987654321', idioma: 'pt', guion: script }, { desde: '+5511987654322', idioma: 'pt', guion: guion }] },
      ctx,
    );
    expect(result).toMatchObject({ exitCode: EXIT.OK, activas: 2, total: 2, cuarta: 'no_probada' });
    expect(server.utterances.filter((u) => u.from === '+5511987654321').map((u) => u.lang)).toEqual(script.lineas.map((line) => line.idioma));
  });

  it('exits with code 3 when the server is unreachable', async () => {
    const { ctx, texts } = context();
    const result = await cargarPrueba({ servidor: 'ws://127.0.0.1:1' }, ctx);
    expect(result).toMatchObject({ exitCode: EXIT.CONNECTION, activas: 0, total: 3, cuarta: 'sin_conexion' });
    expect(texts().at(-1)).toBe('No se pudo conectar con el servidor para todos los teléfonos; se cancela la prueba.');
  });
});
