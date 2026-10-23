/** Plain-text export of a call transcript (what the "Exportar transcripción" button downloads). */
import type { CallRecord, TranscriptSegment } from '@tw/shared';
import { DIRECTION_LABELS, langName } from '../app/labels';
import { callDurationSeconds, formatDateTime, formatDuration, formatOffset } from '../app/format';

const SPEAKER_LABELS = { passenger: 'Pasajero', operator: 'Operador' } as const;

export function transcriptToText(call: CallRecord, segments: TranscriptSegment[]): string {
  const duration = callDurationSeconds(call);
  const lines: string[] = [
    'Telecomway - Transcripción de llamada',
    `Identificador: ${call.id}`,
    `Fecha: ${formatDateTime(call.createdAt)}`,
    `Dirección: ${DIRECTION_LABELS[call.direction]}`,
    `${call.direction === 'local' ? 'Etiqueta' : 'Número'}: ${call.remoteNumber}`,
    `Duración: ${duration === null ? 'no contestada' : formatDuration(duration)}`,
    `Idioma del pasajero: ${call.passengerLang ? `${langName(call.passengerLang)} (${call.passengerLang})` : 'desconocido'}`,
    '',
  ];
  const finals = segments.filter((segment) => segment.final);
  if (finals.length === 0) lines.push('(Sin transcripción)');
  for (const segment of finals) {
    const original = segment.originalLang ? `[${segment.originalLang}] ` : '';
    lines.push(`[${formatOffset(segment.startMs)}] ${SPEAKER_LABELS[segment.speaker]}: ${original}${segment.originalText}`);
    if (segment.translatedText !== null && segment.translatedLang !== segment.originalLang) {
      lines.push(`    -> ${segment.translatedLang ? `[${segment.translatedLang}] ` : ''}${segment.translatedText}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function transcriptFileName(call: CallRecord): string {
  const date = new Date(call.createdAt);
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    '-',
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
  ].join('');
  const who = call.remoteNumber.replace(/[^\w+]+/g, '_').slice(0, 24) || 'llamada';
  return `telecomway-${stamp}-${who}.txt`;
}

/** Triggers a browser download of `text` as a UTF-8 file. */
export function downloadTextFile(fileName: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a tick to start the download before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
