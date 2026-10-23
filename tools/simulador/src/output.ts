/**
 * Reporting: every module emits `ReportLine`s through a `Log`; the CLI prints them, tests collect them.
 * All user-facing text is Spanish.
 */
import type { CallEndReason } from '@tw/shared';

export type ReportLevel = 'info' | 'warn' | 'error';

export interface ReportLine {
  level: ReportLevel;
  text: string;
  /** Label of the simulated phone the line belongs to (usually its number). */
  phone?: string;
  at: number;
}

export type Reporter = (line: ReportLine) => void;

/** Logger bound to an optional phone label. `forPhone` derives a child with its own (mutable) label. */
export class Log {
  label: string | undefined;

  constructor(
    private readonly sink: Reporter,
    label?: string,
    private readonly now: () => number = Date.now,
  ) {
    this.label = label;
  }

  forPhone(label: string): Log {
    return new Log(this.sink, label, this.now);
  }

  info(text: string): void {
    this.emit('info', text);
  }

  warn(text: string): void {
    this.emit('warn', text);
  }

  error(text: string): void {
    this.emit('error', text);
  }

  private emit(level: ReportLevel, text: string): void {
    this.sink({ level, text, at: this.now(), ...(this.label ? { phone: this.label } : {}) });
  }
}

export interface ConsoleReporterOptions {
  timestamps?: boolean;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export function formatClock(at: number): string {
  const date = new Date(at);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function formatReportLine(line: ReportLine, options: { timestamps?: boolean } = {}): string {
  const parts: string[] = [];
  if (options.timestamps !== false) parts.push(`[${formatClock(line.at)}]`);
  if (line.phone) parts.push(`[${line.phone}]`);
  if (line.level === 'warn') parts.push('AVISO:');
  if (line.level === 'error') parts.push('ERROR:');
  parts.push(line.text);
  return parts.join(' ');
}

/** Reporter that prints to the console (info to stdout, warnings and errors to stderr). */
export function consoleReporter(options: ConsoleReporterOptions = {}): Reporter {
  const out = options.out ?? ((line: string) => console.log(line));
  const err = options.err ?? ((line: string) => console.error(line));
  return (line) => {
    const text = formatReportLine(line, { timestamps: options.timestamps ?? true });
    if (line.level === 'info') out(text);
    else err(text);
  };
}

/** Collects lines in memory (tests). */
export function memoryReporter(): { reporter: Reporter; lines: ReportLine[]; texts: () => string[] } {
  const lines: ReportLine[] = [];
  return { reporter: (line) => lines.push(line), lines, texts: () => lines.map((line) => line.text) };
}

/** "850 ms", "1,2 s", "1 min 5 s". */
export function formatDuration(ms: number): string {
  const rounded = Math.round(ms);
  if (rounded < 1000) return `${rounded} ms`;
  if (rounded < 60_000) return `${(rounded / 1000).toFixed(1).replace('.', ',')} s`;
  const minutes = Math.floor(rounded / 60_000);
  const seconds = Math.round((rounded % 60_000) / 1000);
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

const END_REASON_ES: Record<CallEndReason, string> = {
  hangup_operator: 'el operador colgó',
  hangup_passenger: 'el pasajero colgó',
  rejected: 'rechazada por el servidor (todas las líneas ocupadas o ningún operador libre)',
  no_answer: 'nadie contestó',
  busy: 'todas las líneas ocupadas',
  failed: 'fallo: el servidor simulado no admitió la operación en ese estado',
  cancelled: 'cancelada',
  server_shutdown: 'el servidor se apagó',
  connection_lost: 'el operador perdió la conexión y no volvió a tiempo',
};

export function endReasonEs(reason: CallEndReason | undefined): string {
  if (!reason) return 'motivo desconocido';
  return END_REASON_ES[reason] ?? reason;
}

/** First 8 characters of a call id, enough to match it in the operator app and the history. */
export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '?';
}
