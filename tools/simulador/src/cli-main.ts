/** Testable entry of the CLI: parses arguments, loads scripts, runs a command and returns the exit code. */
import { languageNameEs, normalizeLanguageCode, type LanguageCode } from '@tw/shared';
import { BOOLEAN_FLAGS, UsageError, flagBoolean, flagNumber, flagString, parseArgs, rejectUnknownFlags, type ParsedArgs } from './args.js';
import { EXIT, cargarPrueba, colgar, escuchar, llamar, type CommandContext } from './commands.js';
import { defaultControlDir } from './control.js';
import { Log, consoleReporter, type Reporter } from './output.js';
import { BUNDLED_SCENARIOS_DIR, ScriptError, listBundledScenarios, loadScript, resolveScriptPath, type SimScript } from './script.js';
import { SimClientError, normalizeServerUrl, type SimClient, type SimClientOptions } from './sim-client.js';

export const DEFAULT_SERVER = 'ws://127.0.0.1:8787';
export const SERVER_ENV = 'TW_SIM_SERVIDOR';

export interface CliDeps {
  /** Replaces the console reporter (tests). */
  reporter?: Reporter;
  connect?: (options: SimClientOptions) => Promise<SimClient>;
  controlDir?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  scenariosDir?: string;
  speed?: number;
  burstGapMs?: number;
  now?: () => number;
}

const GLOBAL_FLAGS = ['servidor', 'velocidad', 'sin-hora', 'ayuda', 'help'] as const;

export function helpText(): string {
  return [
    'Simulador de pasajeros de Telecomway (todo simulado: audio sintético, sin servicios reales).',
    '',
    'Uso: npm run sim -w @tw/simulador -- <comando> [opciones]',
    '',
    'Comandos:',
    '  llamar          Llamada entrante: anuncia la llamada, espera a un operador, recita un guion y cuelga.',
    '                  --desde +447700900123  --idioma en  [--guion <ruta o nombre>]  [--espera 60]',
    '  escuchar        Teléfono libre: contesta la próxima llamada saliente del operador y recita un guion.',
    '                  --idioma pt  [--guion <ruta>]  [--contestar-tras 1500]  [--colgar-al-terminar]  [--repetir]  [--espera <s>]',
    '  colgar          Cuelga los teléfonos simulados en marcha en este equipo.  [--numero +44...]',
    '  cargar-prueba   3 llamadas a la vez con 3 guiones y comprueba que las 3 llegan a activa',
    '                  y que una 4.ª se rechaza.  [--sin-cuarta]  [--espera 60]',
    '  escenarios      Lista los guiones incluidos.',
    '',
    'Opciones comunes:',
    `  --servidor ws://127.0.0.1:8787   Servidor (también variable ${SERVER_ENV}); la ruta /sim se añade sola.`,
    '  --sin-hora                       No antepone la hora a cada línea.',
    '  --velocidad 1                    Divide las esperas (solo para pruebas contra un servidor acelerado).',
    '  --ayuda                          Esta ayuda.',
    '',
    'Guion JSON: {"idioma":"en","desde":"+44...","lineas":[{"texto":"...","idioma":"en","pausaMs":800,"esperarRespuesta":true}]}',
    `Guiones incluidos en ${BUNDLED_SCENARIOS_DIR} (se pueden pasar por nombre: --guion ingles-vuelo-cancelado).`,
    '',
    'Códigos de salida: 0 bien; 1 argumentos o guion incorrectos; 2 llamada rechazada, sin contestar o prueba fallida; 3 sin conexión.',
  ].join('\n');
}

function parseLanguage(input: string | undefined, flag: string): LanguageCode | undefined {
  if (input === undefined) return undefined;
  const code = normalizeLanguageCode(input);
  if (!code) throw new UsageError(`--${flag}: idioma «${input}» desconocido (usa códigos como en, fr, it, pt, de)`);
  return code;
}

async function loadFlagScript(parsed: ParsedArgs, deps: CliDeps): Promise<SimScript | undefined> {
  const path = flagString(parsed.flags, 'guion');
  if (path === undefined) return undefined;
  const env = deps.env ?? process.env;
  const resolved = await resolveScriptPath(path, {
    cwd: deps.cwd ?? process.cwd(),
    initCwd: env.INIT_CWD,
    ...(deps.scenariosDir ? { scenariosDir: deps.scenariosDir } : {}),
  });
  return loadScript(resolved);
}

export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const parsed = parseArgs(argv);
  const env = deps.env ?? process.env;
  const reporter = deps.reporter ?? consoleReporter({ timestamps: !flagBoolean(parsed.flags, 'sin-hora') });
  const log = new Log(reporter, undefined, deps.now ?? Date.now);
  const print = (text: string): void => reporter({ level: 'info', text, at: (deps.now ?? Date.now)() });

  if (parsed.command === null || parsed.command === 'ayuda' || flagBoolean(parsed.flags, 'ayuda') || flagBoolean(parsed.flags, 'help')) {
    print(helpText());
    return parsed.command === null && parsed.flags.size === 0 ? EXIT.USAGE : EXIT.OK;
  }

  try {
    // Validated here so a malformed address is a usage error, not a connection failure.
    const servidor = normalizeServerUrl(flagString(parsed.flags, 'servidor') ?? (env[SERVER_ENV]?.trim() || DEFAULT_SERVER));
    const velocidad = flagNumber(parsed.flags, 'velocidad', { min: 0.01, max: 1000 }) ?? deps.speed ?? 1;
    const ctx: CommandContext = {
      log,
      controlDir: deps.controlDir ?? defaultControlDir(env),
      speed: velocidad,
      ...(deps.connect ? { connect: deps.connect } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(deps.burstGapMs !== undefined ? { burstGapMs: deps.burstGapMs } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    };

    switch (parsed.command) {
      case 'llamar': {
        rejectUnknownFlags(parsed.flags, [...GLOBAL_FLAGS, 'desde', 'idioma', 'guion', 'espera'], 'llamar');
        const guion = await loadFlagScript(parsed, deps);
        const desde = flagString(parsed.flags, 'desde') ?? guion?.desde;
        if (!desde) throw new UsageError('Falta --desde (el número que llama), o un «desde» en el guion');
        const idioma = parseLanguage(flagString(parsed.flags, 'idioma'), 'idioma') ?? guion?.idioma;
        if (!idioma) throw new UsageError('Falta --idioma (el idioma del pasajero), o un «idioma» en el guion');
        const espera = flagNumber(parsed.flags, 'espera', { min: 1, max: 3600 });
        const result = await llamar(
          { servidor, desde, idioma, ...(guion ? { guion } : {}), ...(espera !== undefined ? { esperaContestacionMs: espera * 1000 } : {}) },
          ctx,
        );
        return result.exitCode;
      }
      case 'escuchar': {
        rejectUnknownFlags(parsed.flags, [...GLOBAL_FLAGS, 'idioma', 'guion', 'contestar-tras', 'colgar-al-terminar', 'repetir', 'espera'], 'escuchar');
        const guion = await loadFlagScript(parsed, deps);
        const idioma = parseLanguage(flagString(parsed.flags, 'idioma'), 'idioma') ?? guion?.idioma;
        if (!idioma) throw new UsageError('Falta --idioma (el idioma que habla este teléfono), o un «idioma» en el guion');
        const contestarTras = flagNumber(parsed.flags, 'contestar-tras', { min: 0, max: 60_000, integer: true });
        const espera = flagNumber(parsed.flags, 'espera', { min: 1, max: 86_400 });
        const result = await escuchar(
          {
            servidor,
            idioma,
            ...(guion ? { guion } : {}),
            colgarAlTerminar: flagBoolean(parsed.flags, 'colgar-al-terminar'),
            repetir: flagBoolean(parsed.flags, 'repetir'),
            ...(contestarTras !== undefined ? { contestarTrasMs: contestarTras } : {}),
            ...(espera !== undefined ? { esperaLlamadaMs: espera * 1000 } : {}),
          },
          ctx,
        );
        return result.exitCode;
      }
      case 'colgar': {
        rejectUnknownFlags(parsed.flags, [...GLOBAL_FLAGS, 'numero'], 'colgar');
        const numero = flagString(parsed.flags, 'numero');
        const result = await colgar({ dir: ctx.controlDir ?? defaultControlDir(env), ...(numero ? { numero } : {}) }, ctx);
        return result.exitCode;
      }
      case 'cargar-prueba': {
        rejectUnknownFlags(parsed.flags, [...GLOBAL_FLAGS, 'sin-cuarta', 'espera'], 'cargar-prueba');
        const espera = flagNumber(parsed.flags, 'espera', { min: 1, max: 3600 });
        const result = await cargarPrueba(
          {
            servidor,
            probarCuarta: !flagBoolean(parsed.flags, 'sin-cuarta'),
            ...(espera !== undefined ? { esperaContestacionMs: espera * 1000 } : {}),
          },
          ctx,
        );
        return result.exitCode;
      }
      case 'escenarios': {
        rejectUnknownFlags(parsed.flags, [...GLOBAL_FLAGS], 'escenarios');
        const dir = deps.scenariosDir ?? BUNDLED_SCENARIOS_DIR;
        const names = await listBundledScenarios(dir);
        if (names.length === 0) {
          log.warn(`No hay guiones en ${dir}.`);
          return EXIT.OK;
        }
        print(`Guiones incluidos (${dir}):`);
        for (const name of names) {
          try {
            const script = await loadScript(`${dir}/${name}.json`);
            const langs = [...new Set(script.lineas.map((line) => languageNameEs(line.idioma)))].join(', ');
            print(`  ${name}: ${script.nombre} (${script.lineas.length} líneas; ${langs})`);
          } catch (error) {
            log.warn(`  ${name}: no se pudo cargar (${(error as Error).message})`);
          }
        }
        return EXIT.OK;
      }
      default:
        throw new UsageError(`Comando desconocido «${parsed.command}». Comandos: llamar, escuchar, colgar, cargar-prueba, escenarios.`);
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof ScriptError || error instanceof SimClientError) {
      log.error(error.message);
      log.error('Usa --ayuda para ver las opciones.');
      return EXIT.USAGE;
    }
    log.error(`Error inesperado: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return EXIT.USAGE;
  }
}

/** Exposed so the help can list them; kept in one place with the parser. */
export const KNOWN_BOOLEAN_FLAGS = BOOLEAN_FLAGS;
