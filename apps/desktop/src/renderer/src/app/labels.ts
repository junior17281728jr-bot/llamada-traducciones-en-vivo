/**
 * Spanish labels shared by the app screens (login, top bar, dialer, history, settings).
 * The call screen keeps its own copies in src/call/labels.ts; both teams own their file.
 */
import {
  languageNameEs,
  type CatalogSource,
  type ConnectionStatus,
  type Direction,
  type LanguageMode,
  type OperatorRole,
  type OperatorStatus,
  type ServiceStatus,
} from '@tw/shared';
import type { ConnectionState } from '../core/types';

export const CONNECTION_LABELS: Record<ConnectionState, string> = {
  disconnected: 'Sin conexión con el servidor',
  connecting: 'Conectando con el servidor…',
  connected: 'Conectado',
  reconnecting: 'Reconectando con el servidor…',
};

export const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = {
  ok: 'Conectado',
  degraded: 'Con problemas',
  down: 'Sin conexión',
  simulated: 'Simulado',
  unconfigured: 'Sin configurar',
  configured: 'Clave configurada, sin comprobar',
};

/** Services reported by `system.status`, in display order. */
export const SERVICES = [
  ['elevenlabs', 'Voz (ElevenLabs)'],
  ['translator', 'Traductor'],
  ['channel', 'Llamadas'],
] as const;

export const ROLE_LABELS: Record<OperatorRole, string> = {
  admin: 'Administrador',
  operator: 'Operador',
};

export const OPERATOR_STATUS_LABELS: Record<OperatorStatus, string> = {
  offline: 'Desconectado',
  available: 'Disponible',
  ringing: 'Sonando',
  in_call: 'En llamada',
};

export const DIRECTION_LABELS: Record<Direction, string> = {
  inbound: 'Entrante',
  outbound: 'Saliente',
  local: 'Audio del PC',
};

export const MODE_HELP: Record<LanguageMode, string> = {
  manual: 'Tú eliges el idioma que habla el pasajero y el idioma en que te oye.',
  auto: 'Se detecta el idioma del pasajero y se le responde en ese mismo idioma.',
  mixed: 'Se detecta lo que habla el pasajero, pero tú eliges el idioma en que te oye.',
};

export const CATALOG_SOURCE_LABELS: Record<CatalogSource, string> = {
  documentation: 'Lista de la documentación (no verificada contra el servicio)',
  live: 'Consulta en vivo a ElevenLabs',
};

export const CONNECTION_TEST_LABELS: Record<ConnectionStatus, string> = {
  ok: 'Correcto',
  fail: 'Falló',
  unconfigured: 'Sin configurar',
  simulated: 'SIMULADO',
};

/** Shown verbatim next to any `simulated` test result: the server contacted nothing. */
export const SIMULATED_TEST_WARNING = 'SIMULADO: no se contactó ningún servicio real.';

export const langName = (code: string | null | undefined): string => (code ? languageNameEs(code) : '');
