import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  API_PATHS,
  DIRECTIONS,
  LoginRequestSchema,
  PutKeysRequestSchema,
  PutPreferencesRequestSchema,
  RECORDING_CONTENT_TYPE,
  RECORDING_LEGS,
  SECRET_KEY_NAMES,
  TEST_SERVICES,
  isSelectableLanguage,
  type CallDetailResponse,
  type CallRecord,
  type ConnectionTester,
  type Direction,
  type KeysResponse,
  type ListCallsResponse,
  type LanguageCatalogProvider,
  type LoginResponse,
  type Logger,
  type PreferencesStore,
  type RecordingLeg,
  type RecordingStore,
  type SecretsStore,
  type TestService,
  type TranscriptStore,
} from '@tw/shared';
import type { CallManager } from './call-manager.js';
import type { ServerConfig } from './config.js';
import { LoginRateLimiter, OperatorStore, SessionStore, type OperatorAccount } from './auth.js';
import { HttpError, SECURITY_HEADERS, parseRange, readJsonBody, sendError, sendJson } from './http-utils.js';
import type { LegStream } from './stores/recordings.js';

export interface ApiDeps {
  config: ServerConfig;
  logger: Logger;
  operators: OperatorStore;
  sessions: SessionStore;
  limiter: LoginRateLimiter;
  manager: CallManager;
  secrets: SecretsStore;
  preferences: PreferencesStore;
  transcripts: TranscriptStore;
  /** `openLeg` (streaming) is used when the store offers it; otherwise the WAV is built in memory with `read`. */
  recordings: (RecordingStore & { openLeg?(callId: string, leg: RecordingLeg): Promise<LegStream | null> }) | null;
  catalog: LanguageCatalogProvider;
  tester: ConnectionTester;
  /** Called after keys change so the server can refresh service statuses. */
  onKeysChanged?: () => void;
  simulated: { providers: boolean; channel: boolean };
}

interface Authed {
  account: OperatorAccount;
  token: string;
}

const SECRET_VALUE = /^[^\s\u0000-\u001f\u007f]{1,4096}$/;

function clientAddress(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

/** A path segment with a malformed percent-escape is a client error, not a crash. */
function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'bad_request', 'La dirección contiene caracteres no válidos');
  }
}

/** Resolves the bearer token of a request to an account, or throws 401. */
async function authenticate(req: IncomingMessage, deps: ApiDeps): Promise<Authed> {
  const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
  if (!match) throw new HttpError(401, 'not_authenticated', 'Falta iniciar sesión');
  const resolved = deps.sessions.resolve(match[1]!);
  if ('error' in resolved) {
    throw new HttpError(401, resolved.error === 'expired' ? 'token_expired' : 'token_invalid', 'La sesión ha caducado. Vuelve a iniciar sesión.');
  }
  const account = await deps.operators.get(resolved.session.operatorId);
  if (!account) throw new HttpError(401, 'token_invalid', 'La sesión no es válida');
  return { account, token: match[1]! };
}

function requireAdmin(auth: Authed): void {
  if (auth.account.role !== 'admin') throw new HttpError(403, 'forbidden', 'Solo un administrador puede hacer esto');
}

function toTimestamp(value: string | null): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? numeric : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new HttpError(400, 'bad_query', `Fecha no válida: ${value}`);
  return parsed;
}

function canSee(account: OperatorAccount, call: CallRecord): boolean {
  return account.role === 'admin' || call.operatorId === account.id;
}

/** Minimum length of a query before it is compared with the beginning of a call id (ids are random UUIDs). */
const MIN_ID_PREFIX_LENGTH = 8;

/**
 * Free-text search of the history: the number (ignoring spaces) or the call id. A short query never
 * matches an id by substring, otherwise random ids would match digits such as "999" by chance.
 */
export function matchesCallQuery(call: { id: string; remoteNumber: string }, q: string | undefined): boolean {
  if (!q) return true;
  const compact = q.replace(/\s/g, '');
  if (compact.length > 0 && call.remoteNumber.replace(/\s/g, '').toLowerCase().includes(compact)) return true;
  const id = call.id.toLowerCase();
  return id === q || (q.length >= MIN_ID_PREFIX_LENGTH && id.startsWith(q));
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: ApiDeps): Promise<boolean> {
  const { pathname } = url;
  const method = req.method ?? 'GET';
  if (!pathname.startsWith('/api/')) return false;

  // Unauthenticated liveness only: what the server is made of (providers, channel, simulated or not) is told to
  // authenticated operators in `auth.ok` and `system.status`, never to anyone who can reach the port.
  if (pathname === '/api/health' && method === 'GET') {
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === API_PATHS.login && method === 'POST') {
    const parsed = LoginRequestSchema.safeParse(await readJsonBody(req, 4096));
    if (!parsed.success) throw new HttpError(400, 'bad_request', 'Faltan el usuario o la contraseña');
    const address = clientAddress(req);
    if (deps.limiter.isClientBlocked(address, parsed.data.username)) {
      throw new HttpError(429, 'rate_limited', 'Demasiados intentos fallidos. Espera unos minutos.');
    }
    const account = await deps.operators.authenticate(parsed.data.username, parsed.data.password);
    if (!account) {
      deps.limiter.recordClientFailure(address, parsed.data.username);
      throw new HttpError(401, 'invalid_credentials', 'Usuario o contraseña incorrectos');
    }
    deps.limiter.recordClientSuccess(address, parsed.data.username);
    const { token, expiresAt } = deps.sessions.create(account.id);
    const prefs = await deps.preferences.get(account.id);
    const body: LoginResponse = {
      token,
      expiresAt,
      operator: {
        id: account.id,
        name: account.name,
        role: account.role,
        status: 'offline',
        currentCallId: null,
        autoAccept: prefs.autoAccept || deps.config.autoAccept,
      },
    };
    sendJson(res, 200, body);
    return true;
  }

  // Everything below needs a session.
  const auth = await authenticate(req, deps);

  if (pathname === '/api/logout' && method === 'POST') {
    deps.sessions.revoke(auth.token);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === API_PATHS.languages && method === 'GET') {
    sendJson(res, 200, await deps.catalog.getCatalog());
    return true;
  }

  if (pathname === `${API_PATHS.languages}/refresh` && method === 'POST') {
    requireAdmin(auth);
    sendJson(res, 200, await deps.catalog.refresh());
    return true;
  }

  if (pathname === API_PATHS.preferences) {
    if (method === 'GET') {
      sendJson(res, 200, await deps.preferences.get(auth.account.id));
      return true;
    }
    if (method === 'PUT') {
      const parsed = PutPreferencesRequestSchema.safeParse(await readJsonBody(req, 8192));
      if (!parsed.success) throw new HttpError(400, 'bad_request', 'Preferencias no válidas');
      const prefs = parsed.data;
      const catalog = await deps.catalog.getCatalog();
      const checks: [string | null, Parameters<typeof isSelectableLanguage>[1], string][] = [
        [prefs.operatorLang, 'operatorLanguage', 'tu idioma'],
        [prefs.defaultPassengerSpeaks, 'passengerSpeaks', 'el idioma del pasajero'],
        [prefs.defaultPassengerHears, 'passengerVoice', 'el idioma de la voz del pasajero'],
      ];
      for (const [lang, role, label] of checks) {
        if (lang !== null && !isSelectableLanguage(catalog, role, lang)) {
          throw new HttpError(400, 'unsupported_language', `El idioma "${lang}" no está disponible para ${label}.`);
        }
      }
      await deps.preferences.set(auth.account.id, prefs);
      await deps.manager.refreshPreferences(auth.account.id);
      sendJson(res, 200, prefs);
      return true;
    }
  }

  if (pathname === API_PATHS.keys) {
    requireAdmin(auth);
    if (method === 'GET') {
      const body: KeysResponse = { keys: await deps.secrets.listMasked() };
      sendJson(res, 200, body);
      return true;
    }
    if (method === 'PUT') {
      const parsed = PutKeysRequestSchema.safeParse(await readJsonBody(req));
      if (!parsed.success) throw new HttpError(400, 'bad_request', 'Datos de claves no válidos');
      for (const [name, value] of Object.entries(parsed.data.keys)) {
        if (!(SECRET_KEY_NAMES as readonly string[]).includes(name)) continue;
        const trimmed = value?.trim() ?? '';
        if (!trimmed) {
          await deps.secrets.delete(name as (typeof SECRET_KEY_NAMES)[number]);
        } else {
          if (!SECRET_VALUE.test(trimmed)) throw new HttpError(400, 'bad_secret', 'La clave no puede contener espacios ni saltos de línea');
          await deps.secrets.set(name as (typeof SECRET_KEY_NAMES)[number], trimmed);
        }
      }
      deps.logger.info('Claves actualizadas desde Ajustes', { by: auth.account.id });
      deps.onKeysChanged?.();
      const body: KeysResponse = { keys: await deps.secrets.listMasked() };
      sendJson(res, 200, body);
      return true;
    }
  }

  const testMatch = /^\/api\/settings\/test\/([^/]+)$/.exec(pathname);
  if (testMatch && method === 'POST') {
    requireAdmin(auth);
    const service = decodeSegment(testMatch[1]!);
    if (!(TEST_SERVICES as readonly string[]).includes(service)) throw new HttpError(404, 'unknown_service', 'Servicio desconocido');
    sendJson(res, 200, await deps.tester.test(service as TestService));
    return true;
  }

  if (pathname === API_PATHS.calls && method === 'GET') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
    const from = toTimestamp(url.searchParams.get('from'));
    const to = toTimestamp(url.searchParams.get('to'));
    const q = url.searchParams.get('q')?.trim().toLowerCase();
    const direction = url.searchParams.get('direction');
    const before = toTimestamp(url.searchParams.get('before'));
    const requestedOperator = url.searchParams.get('operatorId') ?? undefined;
    if (direction !== null && !(DIRECTIONS as readonly string[]).includes(direction)) throw new HttpError(400, 'bad_query', 'Dirección no válida');
    const all = await deps.transcripts.listCalls({
      limit: 500,
      ...(before !== undefined ? { before } : {}),
      ...(direction ? { direction: direction as Direction } : {}),
      ...(auth.account.role === 'admin' ? (requestedOperator ? { operatorId: requestedOperator } : {}) : { operatorId: auth.account.id }),
    });
    const calls = all
      .filter((call) => (from === undefined || call.createdAt >= from) && (to === undefined || call.createdAt <= to))
      .filter((call) => matchesCallQuery(call, q))
      .slice(0, limit);
    const body: ListCallsResponse = { calls };
    sendJson(res, 200, body);
    return true;
  }

  const callMatch = /^\/api\/calls\/([^/]+)$/.exec(pathname);
  if (callMatch && method === 'GET') {
    const call = await findCall(decodeSegment(callMatch[1]!), auth, deps);
    const body: CallDetailResponse = { call, segments: await deps.transcripts.getSegments(call.id) };
    sendJson(res, 200, body);
    return true;
  }

  const audioMatch = /^\/api\/calls\/([^/]+)\/audio\/([^/]+)$/.exec(pathname);
  if (audioMatch && method === 'GET') {
    const call = await findCall(decodeSegment(audioMatch[1]!), auth, deps);
    const leg = decodeSegment(audioMatch[2]!);
    if (!(RECORDING_LEGS as readonly string[]).includes(leg)) throw new HttpError(404, 'not_found', 'Tramo desconocido');
    const source = await openRecording(deps, call.id, leg as RecordingLeg);
    if (!source) throw new HttpError(404, 'no_recording', 'Esta llamada no tiene grabación');
    const range = parseRange(req.headers.range, source.byteLength);
    // Same hardening headers as the JSON answers; the CSP keeps the WAV from being embedded anywhere.
    const base = { ...SECURITY_HEADERS, 'Content-Type': RECORDING_CONTENT_TYPE, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' };
    if (range === 'invalid') {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${source.byteLength}` });
      res.end();
      return true;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : source.byteLength - 1;
    const headers = range ? { ...base, 'Content-Range': `bytes ${start}-${end}/${source.byteLength}` } : base;
    res.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': end - start + 1 });
    // Streamed from disk in small pieces: a long call never has to fit in memory, however many players ask.
    const stream = source.stream(start, end);
    stream.on('error', (error) => {
      deps.logger.error('No se pudo leer la grabación', { callId: call.id, leg, error: String(error) });
      res.destroy();
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return true;
  }

  throw new HttpError(404, 'not_found', 'No existe esa ruta');
}

/** The recording leg as a byte source: streamed by the file store, or the in-memory WAV of any other store. */
async function openRecording(deps: ApiDeps, callId: string, leg: RecordingLeg): Promise<LegStream | null> {
  if (!deps.recordings) return null;
  if (deps.recordings.openLeg) return deps.recordings.openLeg(callId, leg);
  const wav = await deps.recordings.read(callId, leg);
  if (!wav) return null;
  return {
    byteLength: wav.byteLength,
    stream: (start, end) => Readable.from([Buffer.from(wav.subarray(start, end + 1))]),
  };
}

async function findCall(id: string, auth: Authed, deps: ApiDeps): Promise<CallRecord> {
  const call = await deps.transcripts.getCall(id);
  // Same answer for "does not exist" and "not yours" so ids cannot be probed.
  if (!call || !canSee(auth.account, call)) throw new HttpError(404, 'not_found', 'No se encuentra esa llamada');
  return call;
}

export { sendError };
