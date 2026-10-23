/**
 * Passenger scripts (JSON). Format, in Spanish because operators and testers write them:
 *
 * {
 *   "nombre": "...", "descripcion": "...",            // optional
 *   "desde": "+447700900123",                          // optional default caller number
 *   "idioma": "en",                                    // optional default language of the lines
 *   "esperaRespuestaMs": 20000,                        // optional, how long `esperarRespuesta` waits
 *   "lineas": [ { "texto": "...", "idioma": "en", "pausaMs": 800, "esperarRespuesta": true } ]
 * }
 *
 * `pausaMs` is silence BEFORE the line is spoken; `esperarRespuesta` waits, after the line, until the
 * translated reply of the operator has been heard (or the timeout passes).
 */
import { access, readFile, readdir } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeLanguageCode, speechSignalDurationMs, type LanguageCode } from '@tw/shared';

export interface ScriptLine {
  texto: string;
  idioma: LanguageCode;
  /** Silence before saying the line, in ms (the passenger waveform stays flat meanwhile). */
  pausaMs: number;
  /** After the line, wait for the operator's translated reply before going on. */
  esperarRespuesta: boolean;
}

export interface SimScript {
  nombre: string;
  descripcion?: string;
  desde?: string;
  idioma?: LanguageCode;
  esperaRespuestaMs: number;
  lineas: ScriptLine[];
}

export const DEFAULT_REPLY_TIMEOUT_MS = 20_000;
export const MAX_PAUSE_MS = 10 * 60_000;
export const MAX_LINE_CHARS = 2000;
const PHONE_NUMBER = /^\+?[0-9 ()\-.]{3,32}$/;
const TOP_KEYS = ['nombre', 'descripcion', 'desde', 'idioma', 'esperaRespuestaMs', 'lineas'] as const;
const LINE_KEYS = ['texto', 'idioma', 'pausaMs', 'esperarRespuesta'] as const;

/** Folder with the scenarios shipped in this package (works from `src` and from `dist`). */
export const BUNDLED_SCENARIOS_DIR: string = fileURLToPath(new URL('../escenarios/', import.meta.url));

export class ScriptError extends Error {
  constructor(message: string, readonly source?: string) {
    super(source ? `${source}: ${message}` : message);
    this.name = 'ScriptError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function checkKeys(record: Record<string, unknown>, allowed: readonly string[], where: string, source?: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new ScriptError(`${where}: clave desconocida «${key}» (se admiten: ${allowed.join(', ')})`, source);
    }
  }
}

/** Validates a parsed JSON value and fills in the defaults. Error messages are in Spanish. */
export function parseScript(raw: unknown, source?: string): SimScript {
  if (!isRecord(raw)) throw new ScriptError('el guion debe ser un objeto JSON con la lista «lineas»', source);
  checkKeys(raw, TOP_KEYS, 'guion', source);

  const nombre = raw.nombre === undefined ? (source ? basename(source) : 'Guion sin nombre') : raw.nombre;
  if (typeof nombre !== 'string' || !nombre.trim()) throw new ScriptError('«nombre» debe ser un texto no vacío', source);
  if (raw.descripcion !== undefined && typeof raw.descripcion !== 'string') {
    throw new ScriptError('«descripcion» debe ser un texto', source);
  }
  if (raw.desde !== undefined && (typeof raw.desde !== 'string' || !PHONE_NUMBER.test(raw.desde.trim()))) {
    throw new ScriptError('«desde» no es un número de teléfono válido (ejemplo: +447700900123)', source);
  }
  let defaultLang: LanguageCode | undefined;
  if (raw.idioma !== undefined) {
    const normalized = typeof raw.idioma === 'string' ? normalizeLanguageCode(raw.idioma) : null;
    if (!normalized) throw new ScriptError(`idioma «${String(raw.idioma)}» desconocido`, source);
    defaultLang = normalized;
  }
  const esperaRespuestaMs = raw.esperaRespuestaMs === undefined ? DEFAULT_REPLY_TIMEOUT_MS : raw.esperaRespuestaMs;
  if (!isInteger(esperaRespuestaMs, 100, MAX_PAUSE_MS)) {
    throw new ScriptError(`«esperaRespuestaMs» debe ser un número entero entre 100 y ${MAX_PAUSE_MS}`, source);
  }
  if (!Array.isArray(raw.lineas) || raw.lineas.length === 0) {
    throw new ScriptError('«lineas» debe ser una lista con al menos una línea', source);
  }

  const lineas = raw.lineas.map((item: unknown, index: number): ScriptLine => {
    const where = `línea ${index + 1}`;
    if (!isRecord(item)) throw new ScriptError(`${where}: debe ser un objeto con «texto»`, source);
    checkKeys(item, LINE_KEYS, where, source);
    const texto = item.texto;
    if (typeof texto !== 'string' || !texto.trim() || texto.length > MAX_LINE_CHARS) {
      throw new ScriptError(`${where}: «texto» debe ser un texto no vacío (máximo ${MAX_LINE_CHARS} caracteres)`, source);
    }
    let idioma: LanguageCode | undefined = defaultLang;
    if (item.idioma !== undefined) {
      const normalized = typeof item.idioma === 'string' ? normalizeLanguageCode(item.idioma) : null;
      if (!normalized) throw new ScriptError(`${where}: idioma «${String(item.idioma)}» desconocido`, source);
      idioma = normalized;
    }
    if (!idioma) throw new ScriptError(`${where}: falta «idioma» (ni la línea ni el guion lo indican)`, source);
    const pausaMs = item.pausaMs === undefined ? 0 : item.pausaMs;
    if (!isInteger(pausaMs, 0, MAX_PAUSE_MS)) {
      throw new ScriptError(`${where}: «pausaMs» debe ser un número entero entre 0 y ${MAX_PAUSE_MS}`, source);
    }
    const esperarRespuesta = item.esperarRespuesta === undefined ? false : item.esperarRespuesta;
    if (typeof esperarRespuesta !== 'boolean') throw new ScriptError(`${where}: «esperarRespuesta» debe ser true o false`, source);
    return { texto: texto.trim(), idioma, pausaMs, esperarRespuesta };
  });

  return {
    nombre: nombre.trim(),
    ...(typeof raw.descripcion === 'string' ? { descripcion: raw.descripcion } : {}),
    ...(typeof raw.desde === 'string' ? { desde: raw.desde.trim() } : {}),
    ...(defaultLang ? { idioma: defaultLang } : {}),
    esperaRespuestaMs,
    lineas,
  };
}

export async function loadScript(filePath: string): Promise<SimScript> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new ScriptError(`no se pudo leer el guion (${(error as NodeJS.ErrnoException).code ?? String(error)})`, filePath);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ScriptError(`el guion no es JSON válido (${(error as Error).message})`, filePath);
  }
  return parseScript(json, filePath);
}

/** Pauses plus synthetic speech time, without the waits for replies. */
export function estimateScriptMs(script: SimScript): number {
  return script.lineas.reduce((total, line) => total + line.pausaMs + speechSignalDurationMs(line.texto), 0);
}

export interface ResolveScriptPathOptions {
  cwd?: string;
  /** Folder `npm run` was launched from (`INIT_CWD`); with `-w` the cwd is the package, not the repo. */
  initCwd?: string | undefined;
  scenariosDir?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Names (without `.json`) of the scenarios in `dir`. */
export async function listBundledScenarios(dir: string = BUNDLED_SCENARIOS_DIR): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Finds a script given as typed by the user: an absolute path, a path relative to the cwd or to
 * `INIT_CWD`, or the name of a bundled scenario (with or without `.json`).
 */
export async function resolveScriptPath(input: string, options: ResolveScriptPathOptions = {}): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const scenariosDir = options.scenariosDir ?? BUNDLED_SCENARIOS_DIR;
  const trimmed = input.trim();
  if (!trimmed) throw new ScriptError('falta la ruta del guion');
  const candidates: string[] = [];
  if (isAbsolute(trimmed)) candidates.push(trimmed);
  else {
    candidates.push(resolve(cwd, trimmed));
    if (options.initCwd) candidates.push(resolve(options.initCwd, trimmed));
    const name = trimmed.endsWith('.json') ? trimmed : `${trimmed}.json`;
    candidates.push(join(scenariosDir, name));
  }
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  const bundled = await listBundledScenarios(scenariosDir);
  const hint = bundled.length > 0 ? ` Escenarios incluidos: ${bundled.join(', ')}.` : '';
  throw new ScriptError(`no se encontró el guion «${input}» (se probó: ${candidates.join(', ')}).${hint}`);
}
