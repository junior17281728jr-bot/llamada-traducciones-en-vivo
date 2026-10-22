import type { Logger } from '@tw/shared';

const SENSITIVE = /key|token|secret|password|authorization|cookie/i;

/** Replaces the value of any field whose name looks like a secret. */
export function redact(fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) out[name] = SENSITIVE.test(name) ? '[oculto]' : value;
  return out;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** One JSON line per event on stdout/stderr. Never logs audio or message bodies. */
export function createLogger(level: LogLevel = 'info', sink: (line: string, level: LogLevel) => void = defaultSink): Logger {
  const emit = (at: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (ORDER[at] < ORDER[level]) return;
    sink(JSON.stringify({ time: new Date().toISOString(), level: at, message, ...redact(fields) }), at);
  };
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

function defaultSink(line: string, level: LogLevel): void {
  (level === 'warn' || level === 'error' ? console.error : console.log)(line);
}

export const silentLogger: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
