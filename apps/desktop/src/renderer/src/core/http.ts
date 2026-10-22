/**
 * Authenticated fetch with the typed HTTP API of @tw/shared (see `API_PATHS`).
 *
 * Owner: src/core/**. Screens call `api.*`; they never build URLs or headers themselves.
 * Secrets are write-only: `api.putKeys` sends values, nothing here can read one back.
 */
import {
  API_PATHS,
  type ApiErrorBody,
  type CallDetailResponse,
  type ConnectionTestResult,
  type KeysResponse,
  type LanguageCatalog,
  type ListCallsQuery,
  type ListCallsResponse,
  type LoginRequest,
  type LoginResponse,
  type OperatorPreferences,
  type PutKeysRequest,
  type RecordingLeg,
  type TestService,
} from '@tw/shared';
import { getSession, normalizeServerUrl } from './session';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Overrides the session's server (only needed for login, before a session exists). */
  serverUrl?: string;
  /** Send the bearer token (default true). */
  auth?: boolean;
  signal?: AbortSignal;
  /** Parse the answer as a Blob instead of JSON. */
  blob?: boolean;
}

function queryString(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

async function errorFrom(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as Partial<ApiErrorBody>;
    if (body.error?.message) return new ApiError(response.status, body.error.code ?? 'error', body.error.message);
  } catch {
    /* not JSON */
  }
  return new ApiError(response.status, 'http_error', `El servidor respondió ${response.status}`);
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const session = getSession();
  const serverUrl = options.serverUrl ?? session?.serverUrl;
  if (!serverUrl) throw new ApiError(0, 'no_server', 'No hay servidor configurado');

  const headers: Record<string, string> = { Accept: options.blob ? '*/*' : 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.auth !== false) {
    if (!session) throw new ApiError(401, 'not_authenticated', 'Inicia sesión primero');
    headers['Authorization'] = `Bearer ${session.token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${normalizeServerUrl(serverUrl)}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'network', 'No se pudo conectar con el servidor');
  }
  if (!response.ok) throw await errorFrom(response);
  return (options.blob ? await response.blob() : await response.json()) as T;
}

export const api = {
  login: (serverUrl: string, request: LoginRequest): Promise<LoginResponse> =>
    apiRequest<LoginResponse>(API_PATHS.login, { method: 'POST', body: request, serverUrl, auth: false }),

  getLanguages: (): Promise<LanguageCatalog> => apiRequest<LanguageCatalog>(API_PATHS.languages),

  getPreferences: (): Promise<OperatorPreferences> => apiRequest<OperatorPreferences>(API_PATHS.preferences),
  putPreferences: (preferences: OperatorPreferences): Promise<OperatorPreferences> =>
    apiRequest<OperatorPreferences>(API_PATHS.preferences, { method: 'PUT', body: preferences }),

  /** Admin only. Returns masks (last 4 characters and date), never values. */
  getKeys: (): Promise<KeysResponse> => apiRequest<KeysResponse>(API_PATHS.keys),
  putKeys: (request: PutKeysRequest): Promise<KeysResponse> =>
    apiRequest<KeysResponse>(API_PATHS.keys, { method: 'PUT', body: request }),
  testService: (service: TestService): Promise<ConnectionTestResult> =>
    apiRequest<ConnectionTestResult>(API_PATHS.test(service), { method: 'POST' }),

  listCalls: (query: ListCallsQuery = {}): Promise<ListCallsResponse> =>
    apiRequest<ListCallsResponse>(`${API_PATHS.calls}${queryString(query)}`),
  getCall: (id: string): Promise<CallDetailResponse> => apiRequest<CallDetailResponse>(API_PATHS.call(id)),
  getCallAudio: (id: string, leg: RecordingLeg): Promise<Blob> =>
    apiRequest<Blob>(API_PATHS.callAudio(id, leg), { blob: true }),
};
