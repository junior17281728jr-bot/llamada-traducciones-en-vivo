import { languageNameEs, type CallEndReason, type ServiceStatus } from '@tw/shared';
import type { ActiveCall } from '../core/types';

export const END_REASON_LABELS: Record<CallEndReason, string> = {
  hangup_operator: 'Has colgado',
  hangup_passenger: 'El pasajero ha colgado',
  rejected: 'Llamada rechazada',
  no_answer: 'Nadie contestó',
  busy: 'Todas las líneas estaban ocupadas',
  failed: 'La llamada ha fallado',
  cancelled: 'Llamada cancelada',
  server_shutdown: 'El servidor se ha cerrado',
  connection_lost: 'Se perdió la conexión con el servidor y la llamada terminó',
};

export const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = {
  ok: 'Conectado',
  degraded: 'Con problemas',
  down: 'Sin conexión',
  simulated: 'Simulado',
  unconfigured: 'Sin configurar',
  configured: 'Clave configurada, sin comprobar',
};

export const langName = (code: string | null | undefined): string => (code ? languageNameEs(code) : '');

/** What the Pasajero lane says about the passenger's language. */
export function passengerLanguageLabel(call: ActiveCall): string {
  const speaks = call.settings?.passengerSpeaks;
  if (speaks?.mode === 'fixed') return `${langName(speaks.lang)} (elegido)`;
  const { lang, status } = call.detected;
  switch (status) {
    case 'unknown':
      return 'Detectando idioma…';
    case 'tentative':
      return `${langName(lang)} (probable)`;
    case 'confirmed':
      return `${langName(lang)} (detectado)`;
    case 'uncertain':
      return lang ? `${langName(lang)} (incierto)` : 'Idioma incierto';
  }
}

/** The language the passenger hears the operator in, or what it will follow. */
export function passengerHearsLabel(call: ActiveCall): string {
  const hears = call.settings?.passengerHears;
  if (!hears) return '';
  if (hears.mode === 'fixed') return langName(hears.lang);
  return call.detected.lang ? langName(call.detected.lang) : 'el idioma del pasajero (aún sin detectar)';
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
