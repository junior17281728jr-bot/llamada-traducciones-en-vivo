import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUNDLED_SCENARIOS_DIR,
  DEFAULT_REPLY_TIMEOUT_MS,
  ScriptError,
  estimateScriptMs,
  listBundledScenarios,
  loadScript,
  parseScript,
  resolveScriptPath,
} from './script.js';

const valid = {
  nombre: 'Prueba',
  desde: '+447700900123',
  idioma: 'en',
  lineas: [
    { texto: 'Hello there, I need some help with my flight.', pausaMs: 500, esperarRespuesta: true },
    { texto: 'Merci beaucoup.', idioma: 'fr-FR' },
  ],
};

describe('parseScript', () => {
  it('fills defaults and normalises language codes', () => {
    const script = parseScript(valid, 'prueba.json');
    expect(script.nombre).toBe('Prueba');
    expect(script.desde).toBe('+447700900123');
    expect(script.idioma).toBe('en');
    expect(script.esperaRespuestaMs).toBe(DEFAULT_REPLY_TIMEOUT_MS);
    expect(script.lineas).toEqual([
      { texto: 'Hello there, I need some help with my flight.', idioma: 'en', pausaMs: 500, esperarRespuesta: true },
      { texto: 'Merci beaucoup.', idioma: 'fr', pausaMs: 0, esperarRespuesta: false },
    ]);
    expect(estimateScriptMs(script)).toBeGreaterThan(500);
  });

  it('names the script after the file when it has no name', () => {
    expect(parseScript({ idioma: 'it', lineas: [{ texto: 'Ciao' }] }, '/tmp/guion-x.json').nombre).toBe('guion-x.json');
    expect(parseScript({ idioma: 'it', lineas: [{ texto: 'Ciao' }] }).nombre).toBe('Guion sin nombre');
  });

  it.each([
    [null, /debe ser un objeto JSON/],
    [{ lineas: [] }, /«lineas» debe ser una lista/],
    [{ lineas: 'x' }, /«lineas» debe ser una lista/],
    [{ idioma: 'en', lineas: [{ texto: '' }] }, /línea 1: «texto»/],
    [{ idioma: 'en', lineas: [{ texto: 'a'.repeat(2001) }] }, /línea 1: «texto»/],
    [{ lineas: [{ texto: 'Hola' }] }, /línea 1: falta «idioma»/],
    [{ idioma: 'xx', lineas: [{ texto: 'Hola' }] }, /idioma «xx» desconocido/],
    [{ idioma: 'en', lineas: [{ texto: 'Hola', idioma: 'klingon' }] }, /línea 1: idioma «klingon» desconocido/],
    [{ idioma: 'en', lineas: [{ texto: 'Hola', pausaMs: -1 }] }, /«pausaMs» debe ser un número entero/],
    [{ idioma: 'en', lineas: [{ texto: 'Hola', pausaMs: 1.5 }] }, /«pausaMs» debe ser un número entero/],
    [{ idioma: 'en', lineas: [{ texto: 'Hola', esperarRespuesta: 'sí' }] }, /«esperarRespuesta» debe ser true o false/],
    [{ idioma: 'en', lineas: [{ texto: 'Hola', pausa: 3 }] }, /línea 1: clave desconocida «pausa»/],
    [{ idioma: 'en', lines: [{ texto: 'Hola' }] }, /guion: clave desconocida «lines»/],
    [{ idioma: 'en', desde: 'abc', lineas: [{ texto: 'Hola' }] }, /«desde» no es un número de teléfono válido/],
    [{ idioma: 'en', esperaRespuestaMs: 10, lineas: [{ texto: 'Hola' }] }, /«esperaRespuestaMs»/],
    [{ idioma: 'en', nombre: '  ', lineas: [{ texto: 'Hola' }] }, /«nombre»/],
  ])('rejects %j with a Spanish message', (raw, pattern) => {
    expect(() => parseScript(raw, 'g.json')).toThrow(ScriptError);
    expect(() => parseScript(raw, 'g.json')).toThrow(pattern);
    expect(() => parseScript(raw, 'g.json')).toThrow(/^g\.json: /);
  });
});

describe('loadScript and resolveScriptPath', () => {
  it('loads a file, reports unreadable files and invalid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tw-sim-script-'));
    const good = join(dir, 'bueno.json');
    await writeFile(good, JSON.stringify(valid));
    await writeFile(join(dir, 'roto.json'), '{ no json');
    expect((await loadScript(good)).lineas).toHaveLength(2);
    await expect(loadScript(join(dir, 'roto.json'))).rejects.toThrow(/no es JSON válido/);
    await expect(loadScript(join(dir, 'no-existe.json'))).rejects.toThrow(/no se pudo leer el guion \(ENOENT\)/);
  });

  it('resolves paths relative to cwd, to INIT_CWD and bundled names', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tw-sim-resolve-'));
    const initDir = await mkdtemp(join(tmpdir(), 'tw-sim-init-'));
    await writeFile(join(dir, 'local.json'), JSON.stringify(valid));
    await writeFile(join(initDir, 'desde-init.json'), JSON.stringify(valid));
    expect(await resolveScriptPath('local.json', { cwd: dir })).toBe(join(dir, 'local.json'));
    expect(await resolveScriptPath('desde-init.json', { cwd: dir, initCwd: initDir })).toBe(join(initDir, 'desde-init.json'));
    expect(await resolveScriptPath('ingles-vuelo-cancelado', { cwd: dir })).toBe(join(BUNDLED_SCENARIOS_DIR, 'ingles-vuelo-cancelado.json'));
    expect(await resolveScriptPath('frances-traslado.json', { cwd: dir })).toBe(join(BUNDLED_SCENARIOS_DIR, 'frances-traslado.json'));
    expect(await resolveScriptPath(join(dir, 'local.json'), { cwd: '/' })).toBe(join(dir, 'local.json'));
    await expect(resolveScriptPath('inexistente', { cwd: dir })).rejects.toThrow(/no se encontró el guion «inexistente».*Escenarios incluidos: cambio-de-idioma, frances-traslado/);
    await expect(resolveScriptPath('  ', { cwd: dir })).rejects.toThrow(/falta la ruta del guion/);
  });

  it('lists the bundled scenarios', async () => {
    expect(await listBundledScenarios()).toEqual(['cambio-de-idioma', 'frances-traslado', 'ingles-vuelo-cancelado', 'italiano-reclamacion']);
    expect(await listBundledScenarios('/ruta/que/no/existe')).toEqual([]);
  });
});
