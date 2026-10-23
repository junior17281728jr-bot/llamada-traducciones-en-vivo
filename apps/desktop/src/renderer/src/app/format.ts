/** Date and duration formatting for the operator screens (Spanish locale, local time zone). */

const dateTime = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const dateOnly = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });

const timeOnly = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function formatDateTime(epochMs: number | null | undefined): string {
  return typeof epochMs === 'number' && Number.isFinite(epochMs) ? dateTime.format(new Date(epochMs)) : '—';
}

export function formatDate(epochMs: number | null | undefined): string {
  return typeof epochMs === 'number' && Number.isFinite(epochMs) ? dateOnly.format(new Date(epochMs)) : '—';
}

export function formatTime(epochMs: number | null | undefined): string {
  return typeof epochMs === 'number' && Number.isFinite(epochMs) ? timeOnly.format(new Date(epochMs)) : '—';
}

/** `mm:ss` (or `h:mm:ss` past one hour). */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const mmss = `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}

/** Duration of a call from its timestamps; null when it was never answered. */
export function callDurationSeconds(call: { answeredAt: number | null; endedAt: number | null }): number | null {
  if (call.answeredAt === null) return null;
  const end = call.endedAt ?? Date.now();
  return Math.max(0, (end - call.answeredAt) / 1000);
}

/** Milliseconds since the call was answered to `m:ss`, for transcript lines. */
export function formatOffset(ms: number): string {
  return formatDuration(ms / 1000);
}

/** `YYYY-MM-DD` of a local date, for `<input type="date">`. */
export function toDateInputValue(epochMs: number): string {
  const date = new Date(epochMs);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Start (or end, inclusive) of the local day written in a date input; undefined for an empty or invalid value. */
export function dateInputToEpoch(value: string, edge: 'start' | 'end'): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(date.getTime())) return undefined;
  if (edge === 'end') date.setHours(23, 59, 59, 999);
  return date.getTime();
}
