import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SERVER, SERVER_ENV, helpText, runCli, type CliDeps } from './cli-main.js';
import { EXIT } from './commands.js';
import { memoryReporter } from './output.js';
import { FakeSimServer } from './testing/fake-sim-server.js';

const servers: FakeSimServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

async function start(options: Parameters<typeof FakeSimServer.start>[0] = {}): Promise<FakeSimServer> {
  const server = await FakeSimServer.start({ answerDelayMs: 10, replyDelayMs: 10, replyChunkGapMs: 2, ...options });
  servers.push(server);
  return server;
}

async function deps(extra: Partial<CliDeps> = {}): Promise<{ deps: CliDeps; texts: () => string[]; levels: () => string[] }> {
  const { reporter, texts, lines } = memoryReporter();
  const controlDir = await mkdtemp(join(tmpdir(), 'tw-sim-cli-'));
  return { deps: { reporter, controlDir, env: {}, speed: 100, burstGapMs: 30, ...extra }, texts, levels: () => lines.map((line) => line.level) };
}

describe('runCli', () => {
  it('prints the help in Spanish', async () => {
    const empty = await deps();
    expect(await runCli([], empty.deps)).toBe(EXIT.USAGE);
    expect(empty.texts()[0]).toBe(helpText());
    expect(helpText()).toMatch(/Simulador de pasajeros de Telecomway \(todo simulado/);
    expect(helpText()).toMatch(/llamar\s+Llamada entrante/);
    const asked = await deps();
    expect(await runCli(['--ayuda'], asked.deps)).toBe(EXIT.OK);
    expect(await runCli(['ayuda'], asked.deps)).toBe(EXIT.OK);
    expect(await runCli(['llamar', '-h'], asked.deps)).toBe(EXIT.OK);
  });

  it('rejects unknown commands, unknown options and missing arguments', async () => {
    const d = await deps();
    expect(await runCli(['volar'], d.deps)).toBe(EXIT.USAGE);
    expect(d.texts()[0]).toBe('Comando desconocido «volar». Comandos: llamar, escuchar, colgar, cargar-prueba, escenarios.');
    expect(d.texts()[1]).toBe('Usa --ayuda para ver las opciones.');
    expect(await runCli(['llamar', '--idioma', 'en'], d.deps)).toBe(EXIT.USAGE);
    expect(d.texts()).toContain('Falta --desde (el número que llama), o un «desde» en el guion');
    expect(await runCli(['llamar', '--desde', '+447700900123'], d.deps)).toBe(EXIT.USAGE);
    expect(d.texts()).toContain('Falta --idioma (el idioma del pasajero), o un «idioma» en el guion');
    expect(await runCli(['llamar', '--desde', '+447700900123', '--idioma', 'klingon'], d.deps)).toBe(EXIT.USAGE);
    expect(d.texts()).toContain('--idioma: idioma «klingon» desconocido (usa códigos como en, fr, it, pt, de)');
    expect(await runCli(['llamar', '--desde', '+447700900123', '--idioma', 'en', '--turbo'], d.deps)).toBe(EXIT.USAGE);
    expect(d.texts().some((line) => line.startsWith('Opción desconocida para «llamar»: --turbo.'))).toBe(true);
    expect(await runCli(['escuchar'], d.deps)).toBe(EXIT.USAGE);
    expect(await runCli(['llamar', '--guion', 'no-existe', '--desde', '+447700900123', '--idioma', 'en'], d.deps)).toBe(EXIT.USAGE);
    expect(d.texts().some((line) => line.startsWith('no se encontró el guion «no-existe»'))).toBe(true);
    expect(await runCli(['llamar', '--servidor', 'ws://127.0.0.1:1/operator', '--desde', '+447700900123', '--idioma', 'en'], d.deps)).toBe(EXIT.USAGE);
    expect(d.texts()).toContain('La ruta del simulador es /sim; recibido /operator');
    expect(d.levels().every((level) => level === 'error')).toBe(true);
  });

  it('llamar takes the number and language from a bundled script named on the command line', async () => {
    const server = await start();
    const d = await deps();
    const code = await runCli(['llamar', '--guion', 'ingles-vuelo-cancelado', '--servidor', server.baseUrl], d.deps);
    expect(code).toBe(EXIT.OK);
    expect(server.calls[0]).toMatchObject({ remoteNumber: '+447700900123', lang: 'en', state: 'ended', reason: 'hangup_passenger' });
    expect(server.utterances).toHaveLength(5);
    expect(d.texts()).toContain('Llama desde +447700900123 hablando Inglés con el guion «Vuelo cancelado: pide hotel (inglés)».');
    expect(d.texts()).toContain('Guarda silencio 1,5 s antes de la línea 1 (ondas del pasajero planas).');
  });

  it('llamar honours --desde, --idioma, --espera and a script path relative to INIT_CWD', async () => {
    const server = await start({ autoAnswer: false });
    const initCwd = await mkdtemp(join(tmpdir(), 'tw-sim-initcwd-'));
    await writeFile(join(initCwd, 'mio.json'), JSON.stringify({ lineas: [{ texto: 'Hola, buenas tardes.', idioma: 'es' }] }));
    const d = await deps({ env: { INIT_CWD: initCwd, [SERVER_ENV]: server.baseUrl }, cwd: tmpdir() });
    const code = await runCli(['llamar', '--desde', '+34600000000', '--idioma', 'es-ES', '--guion', 'mio.json', '--espera', '2'], d.deps);
    expect(code).toBe(EXIT.CALL_FAILED);
    expect(server.calls[0]).toMatchObject({ remoteNumber: '+34600000000', lang: 'es' });
    expect(d.texts()).toContain('Nadie contestó en 2,0 s.');
  });

  it('uses the default server when the variable is empty and reports the connection failure', async () => {
    const d = await deps({ env: { [SERVER_ENV]: '   ' } });
    const code = await runCli(['colgar'], d.deps);
    expect(code).toBe(EXIT.OK);
    expect(DEFAULT_SERVER).toBe('ws://127.0.0.1:8787');
    const call = await deps({ env: {} });
    expect(await runCli(['llamar', '--desde', '+447700900123', '--idioma', 'en', '--servidor', 'ws://127.0.0.1:1'], call.deps)).toBe(EXIT.CONNECTION);
  });

  it('escuchar and cargar-prueba are wired to their options', async () => {
    const server = await start({ maxCalls: 3 });
    const listen = await deps();
    expect(await runCli(['escuchar', '--idioma', 'pt', '--espera', '1', '--servidor', server.baseUrl], listen.deps)).toBe(EXIT.CALL_FAILED);
    expect(listen.texts()).toContain('No llegó ninguna llamada saliente en 1,0 s.');
    const load = await deps();
    expect(await runCli(['cargar-prueba', '--sin-cuarta', '--servidor', server.baseUrl, '--velocidad', '200'], load.deps)).toBe(EXIT.OK);
    expect(load.texts().at(-1)).toBe('Resultado de la prueba de carga: 3 de 3 llamadas activas a la vez; llamada 4: no probada.');
    expect(server.calls).toHaveLength(3);
  });

  it('escenarios lists the bundled scripts', async () => {
    const d = await deps();
    expect(await runCli(['escenarios'], d.deps)).toBe(EXIT.OK);
    const out = d.texts();
    expect(out[0]).toMatch(/^Guiones incluidos \(/);
    expect(out.slice(1)).toEqual([
      expect.stringMatching(/^ {2}cambio-de-idioma: Cambio de idioma en directo \(portugués → inglés\) \(9 líneas; Portugués, Inglés\)$/),
      expect.stringMatching(/^ {2}frances-traslado: .* \(4 líneas; Francés\)$/),
      expect.stringMatching(/^ {2}ingles-vuelo-cancelado: .* \(5 líneas; Inglés\)$/),
      expect.stringMatching(/^ {2}italiano-reclamacion: .* \(5 líneas; Italiano\)$/),
    ]);
  });
});
