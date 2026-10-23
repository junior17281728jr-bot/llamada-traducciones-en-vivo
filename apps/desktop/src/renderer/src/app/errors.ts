/**
 * Turns errors thrown by `api.*` (see src/core/http.ts) into sentences for the operator.
 * Duck-typed on `status`/`code` so it also works with mocked modules in tests.
 */
import { clearSession } from '../core/session';

export interface ApiFailure {
  status: number;
  code: string;
  message: string;
}

export function asApiFailure(error: unknown): ApiFailure {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as Partial<ApiFailure>;
    if (typeof candidate.status === 'number' && typeof candidate.code === 'string') {
      return { status: candidate.status, code: candidate.code, message: candidate.message ?? '' };
    }
    if (error instanceof Error) return { status: -1, code: 'unknown', message: error.message };
  }
  return { status: -1, code: 'unknown', message: 'Error desconocido' };
}

/** Sentence for a failed login against `serverUrl`. */
export function describeLoginError(error: unknown, serverUrl: string): string {
  const failure = asApiFailure(error);
  if (failure.status === 0) {
    return `No se pudo conectar con el servidor en ${serverUrl}. Comprueba la dirección y que el servidor esté en marcha.`;
  }
  if (failure.status === 429 || failure.code === 'rate_limited') {
    return 'Demasiados intentos fallidos. Por seguridad el acceso está bloqueado unos minutos; espera antes de volver a intentarlo.';
  }
  if (failure.status === 401 || failure.code === 'invalid_credentials') return 'Usuario o contraseña incorrectos.';
  if (failure.status === 400) return 'Escribe el usuario y la contraseña.';
  return failure.message || 'No se pudo iniciar sesión.';
}

/** Generic sentence for any other API failure (page loads, saves). */
export function describeApiError(error: unknown, fallback = 'Ha ocurrido un error'): string {
  const failure = asApiFailure(error);
  if (failure.status === 0) return 'No se pudo conectar con el servidor.';
  if (failure.status === 401) return 'La sesión ha caducado. Vuelve a iniciar sesión.';
  if (failure.status === 403) return 'Solo un administrador puede hacer esto.';
  return failure.message || fallback;
}

/**
 * When the server says the token is no longer valid, the only sensible thing is to log out
 * so the login screen appears. Returns true when it did so.
 */
export function logoutIfSessionExpired(error: unknown): boolean {
  const failure = asApiFailure(error);
  if (failure.status === 401 && (failure.code === 'token_expired' || failure.code === 'token_invalid')) {
    clearSession();
    return true;
  }
  return false;
}
