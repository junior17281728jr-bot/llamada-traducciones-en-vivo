/**
 * Typed failures of the ElevenLabs clients. Messages are in Spanish because the pipeline shows them
 * to the operator (stage `error`) and the server logs them. They never contain the API key.
 */
import type { SttErrorPolicy } from './protocol.js';

export type ElevenLabsService = 'stt' | 'tts';

/**
 * - `config`: something is missing in the environment (key, voice, format). Nothing to retry.
 * - `auth`: the service rejected the key. Nothing to retry until the key changes.
 * - `quota`: no credit left. Nothing to retry.
 * - `rate_limited`: too many requests; retrying after a pause may work.
 * - `input`: the service rejected what we sent (a protocol mismatch on our side, most likely).
 * - `session`: the session ended on the server side (time limit, internal error...).
 * - `transport`: the connection could not be opened or was lost.
 * - `protocol`: the server answered something this client does not understand.
 */
export type ElevenLabsErrorKind = 'config' | 'auth' | 'quota' | 'rate_limited' | 'input' | 'session' | 'transport' | 'protocol';

export interface ElevenLabsErrorOptions {
  /** Provider error type or HTTP status, for logs. */
  code?: string | number | null;
  /** True when opening a new session may succeed. */
  recoverable?: boolean;
  cause?: unknown;
}

export class ElevenLabsError extends Error {
  readonly service: ElevenLabsService;
  readonly kind: ElevenLabsErrorKind;
  readonly code: string | null;
  readonly recoverable: boolean;

  constructor(service: ElevenLabsService, kind: ElevenLabsErrorKind, message: string, options: ElevenLabsErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ElevenLabsError';
    this.service = service;
    this.kind = kind;
    this.code = options.code == null ? null : String(options.code);
    this.recoverable = options.recoverable ?? DEFAULT_RECOVERABLE[kind];
  }
}

/** Missing key, voice or an invalid setting: the operator (or the admin) has to fix the configuration. */
export class ElevenLabsConfigError extends ElevenLabsError {
  constructor(service: ElevenLabsService, message: string, options: ElevenLabsErrorOptions = {}) {
    super(service, 'config', message, { recoverable: false, ...options });
    this.name = 'ElevenLabsConfigError';
  }
}

const DEFAULT_RECOVERABLE: Record<ElevenLabsErrorKind, boolean> = {
  config: false,
  auth: false,
  quota: false,
  rate_limited: true,
  input: false,
  session: true,
  transport: true,
  protocol: true,
};

const SERVICE_LABEL: Record<ElevenLabsService, string> = { stt: 'la transcripción de ElevenLabs', tts: 'la voz de ElevenLabs' };

export const MISSING_ELEVENLABS_KEY_MESSAGE =
  'Falta la clave de ElevenLabs (ELEVENLABS_API_KEY): introdúcela en Ajustes o en el entorno del servidor.';

export function serviceLabel(service: ElevenLabsService): string {
  return SERVICE_LABEL[service];
}

/** Error for an STT error message, following `STT_ERROR_POLICY`. */
export function sttErrorFromType(type: string, detail: string, policy: SttErrorPolicy): ElevenLabsError {
  const label = detail && detail !== type ? `${type}: ${detail}` : type;
  switch (type) {
    case 'auth_error':
      return new ElevenLabsError('stt', 'auth', `ElevenLabs rechazó la clave de API al transcribir (${label}). Revisa ELEVENLABS_API_KEY en Ajustes.`, { code: type });
    case 'quota_exceeded':
      return new ElevenLabsError('stt', 'quota', `La cuenta de ElevenLabs no tiene cuota para transcribir (${label}).`, { code: type });
    case 'rate_limited':
      return new ElevenLabsError('stt', 'rate_limited', `ElevenLabs está limitando las peticiones de transcripción (${label}); se reintentará.`, { code: type });
    case 'input_error':
      return new ElevenLabsError('stt', 'input', `ElevenLabs rechazó el audio o los parámetros enviados (${label}).`, { code: type });
    default:
      return new ElevenLabsError('stt', policy === 'fatal' ? 'input' : 'session', `La sesión de transcripción de ElevenLabs terminó (${label}).`, {
        code: type,
        recoverable: policy !== 'fatal',
      });
  }
}

/** Error for a failed WebSocket upgrade (HTTP status instead of 101). */
export function errorFromUpgradeStatus(service: ElevenLabsService, status: number): ElevenLabsError {
  const where = serviceLabel(service);
  if (status === 401 || status === 403) {
    return new ElevenLabsError(service, 'auth', `ElevenLabs rechazó la clave de API al abrir ${where} (HTTP ${status}). Revisa ELEVENLABS_API_KEY en Ajustes.`, { code: status });
  }
  if (status === 402) return new ElevenLabsError(service, 'quota', `La cuenta de ElevenLabs no tiene cuota disponible (HTTP ${status}).`, { code: status });
  if (status === 404) {
    return new ElevenLabsError(service, 'config', `ElevenLabs no encuentra el recurso pedido al abrir ${where} (HTTP 404): revisa el modelo${service === 'tts' ? ' y el voice_id' : ''}.`, {
      code: status,
      recoverable: false,
    });
  }
  if (status === 429) return new ElevenLabsError(service, 'rate_limited', `ElevenLabs está limitando las peticiones (HTTP 429) al abrir ${where}; se reintentará.`, { code: status });
  if (status >= 500) return new ElevenLabsError(service, 'transport', `ElevenLabs no está disponible ahora mismo (HTTP ${status}) para ${where}.`, { code: status });
  return new ElevenLabsError(service, 'transport', `ElevenLabs respondió HTTP ${status} al abrir ${where}.`, { code: status, recoverable: status < 400 });
}

export function transportError(service: ElevenLabsService, detail: string, cause?: unknown): ElevenLabsError {
  return new ElevenLabsError(service, 'transport', `No se pudo conectar con ${serviceLabel(service)}: ${detail}`, { recoverable: true, cause });
}

export const toError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));
