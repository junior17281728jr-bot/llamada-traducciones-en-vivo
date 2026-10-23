/** Minimal argv parser: `comando --clave valor --clave=valor --interruptor`. */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface ParsedArgs {
  command: string | null;
  flags: Map<string, string | true>;
  positionals: string[];
}

/** Flags that never take a value, so `--repetir llamar` does not swallow the command. */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'ayuda',
  'help',
  'version',
  'sin-hora',
  'sin-cuarta',
  'colgar-al-terminar',
  'repetir',
]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  let command: string | null = null;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token === '-h') {
      flags.set('ayuda', true);
      continue;
    }
    if (token.startsWith('--') && token.length > 2) {
      const equals = token.indexOf('=');
      if (equals > 0) {
        flags.set(token.slice(2, equals), token.slice(equals + 1));
        continue;
      }
      const name = token.slice(2);
      const next = argv[index + 1];
      if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith('--')) {
        flags.set(name, next);
        index += 1;
      } else {
        flags.set(name, true);
      }
      continue;
    }
    if (command === null) command = token;
    else positionals.push(token);
  }
  return { command, flags, positionals };
}

export function flagString(flags: ParsedArgs['flags'], name: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (value === true || !value.trim()) throw new UsageError(`--${name} necesita un valor`);
  return value.trim();
}

export interface NumberFlagOptions {
  min?: number;
  max?: number;
  integer?: boolean;
}

export function flagNumber(flags: ParsedArgs['flags'], name: string, options: NumberFlagOptions = {}): number | undefined {
  const text = flagString(flags, name);
  if (text === undefined) return undefined;
  const value = Number(text.replace(',', '.'));
  const min = options.min ?? Number.NEGATIVE_INFINITY;
  const max = options.max ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(value) || value < min || value > max || (options.integer && !Number.isInteger(value))) {
    const range = options.min !== undefined || options.max !== undefined ? ` entre ${options.min ?? '-∞'} y ${options.max ?? '∞'}` : '';
    throw new UsageError(`--${name} debe ser un número${options.integer ? ' entero' : ''}${range} (recibido «${text}»)`);
  }
  return value;
}

export function flagBoolean(flags: ParsedArgs['flags'], name: string): boolean {
  const value = flags.get(name);
  if (value === undefined) return false;
  if (value === true) return true;
  return !['false', 'no', '0'].includes(value.trim().toLowerCase());
}

export function rejectUnknownFlags(flags: ParsedArgs['flags'], allowed: readonly string[], command: string): void {
  const unknown = [...flags.keys()].filter((name) => !allowed.includes(name));
  if (unknown.length > 0) {
    throw new UsageError(`Opción desconocida para «${command}»: --${unknown.join(', --')}. Se admiten: --${allowed.join(', --')}`);
  }
}
