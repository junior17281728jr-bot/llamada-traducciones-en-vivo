import type { IncomingMessage } from 'node:http';
import { WebSocket, type RawData } from 'ws';
import {
  MAX_CONTROL_MESSAGE_LENGTH,
  PROTOCOL_VERSION,
  SERVER_ACCEPTED_FRAME_TYPES,
  decodeAudioFrame,
  encodeMessage,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type Logger,
  type ServerMessage,
} from '@tw/shared';
import type { CallManager } from './call-manager.js';
import type { OperatorLink } from './call-session.js';
import type { ServerConfig } from './config.js';
import { LoginRateLimiter, OperatorStore, SessionStore, type OperatorAccount } from './auth.js';

/** Hooks that exist only with simulated providers; their absence disables `debug.say`. */
export interface DebugHooks {
  sayAsPassenger(callId: string, text: string, lang: string): boolean;
  sayAsOperator(operatorId: string, callId: string, text: string, lang: string): boolean;
}

export interface OperatorSocketDeps {
  config: ServerConfig;
  logger: Logger;
  operators: OperatorStore;
  sessions: SessionStore;
  limiter: LoginRateLimiter;
  manager: CallManager;
  channelKind: ServerConfig['channel'];
  debug?: DebugHooks;
  systemStatus: () => Extract<ServerMessage, { type: 'system.status' }>;
}

const AUTH_TIMEOUT_MS = 10_000;
const MAX_BAD_FRAMES = 50;
const BACKPRESSURE_BYTES = 512 * 1024;

/** One operator app connection: authenticates, then relays control messages and microphone audio. */
export function handleOperatorSocket(ws: WebSocket, req: IncomingMessage, deps: OperatorSocketDeps): void {
  const ip = req.socket.remoteAddress ?? 'unknown';
  let operatorId: string | null = null;
  let badFrames = 0;
  let tokens = 200;
  let lastRefill = Date.now();

  const sendMessage = (message: ServerMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encodeMessage(message));
  };
  const link: OperatorLink = {
    send: sendMessage,
    sendBinary: (data) => {
      if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < BACKPRESSURE_BYTES) ws.send(data, { binary: true });
    },
  };
  const fail = (code: ErrorCode, message: string, callId?: string): void =>
    sendMessage({ type: 'error', code, message, ...(callId ? { callId } : {}) });

  const authTimer = setTimeout(() => ws.close(4001, 'auth timeout'), AUTH_TIMEOUT_MS);

  const admit = async (account: OperatorAccount, token: string): Promise<void> => {
    const result = await deps.manager.connectOperator({ id: account.id, name: account.name, role: account.role }, link);
    if (!result.ok) {
      sendMessage({ type: 'auth.error', code: 'already_connected', message: 'Este usuario ya tiene otra sesión abierta' });
      ws.close(4003, 'already connected');
      return;
    }
    clearTimeout(authTimer);
    operatorId = account.id;
    sendMessage({
      type: 'auth.ok',
      operator: result.info,
      token,
      server: {
        protocolVersion: PROTOCOL_VERSION,
        providers: deps.config.providers,
        channel: deps.channelKind,
        debug: deps.debug !== undefined,
        maxCalls: deps.config.maxConcurrentCalls,
      },
    });
    sendMessage(deps.manager.presenceMessage());
    sendMessage(deps.systemStatus());
  };

  const authenticate = async (message: Extract<ClientMessage, { type: 'auth.login' | 'auth.resume' }>): Promise<void> => {
    if (message.type === 'auth.resume') {
      const resolved = deps.sessions.resolve(message.token);
      if ('error' in resolved) {
        const expired = resolved.error === 'expired';
        sendMessage({ type: 'auth.error', code: expired ? 'token_expired' : 'token_invalid', message: 'La sesión no es válida. Inicia sesión de nuevo.' });
        return;
      }
      const account = await deps.operators.get(resolved.session.operatorId);
      if (!account) {
        sendMessage({ type: 'auth.error', code: 'token_invalid', message: 'La sesión no es válida. Inicia sesión de nuevo.' });
        return;
      }
      await admit(account, message.token);
      return;
    }
    const key = `${ip}|${message.username.toLowerCase()}`;
    if (deps.limiter.isBlocked(key)) {
      sendMessage({ type: 'auth.error', code: 'rate_limited', message: 'Demasiados intentos fallidos. Espera unos minutos.' });
      return;
    }
    const account = await deps.operators.authenticate(message.username, message.password);
    if (!account) {
      deps.limiter.recordFailure(key);
      sendMessage({ type: 'auth.error', code: 'invalid_credentials', message: 'Usuario o contraseña incorrectos' });
      return;
    }
    deps.limiter.recordSuccess(key);
    await admit(account, deps.sessions.create(account.id).token);
  };

  const handleControl = (message: ClientMessage, id: string): void => {
    const manager = deps.manager;
    switch (message.type) {
      case 'call.accept':
        void manager.accept(id, message.callId);
        break;
      case 'call.reject':
        manager.reject(id, message.callId);
        break;
      case 'call.hangup':
        manager.hangup(id, message.callId);
        break;
      case 'call.dial':
        void manager.dial(id, message.number, message.languages);
        break;
      case 'call.setLanguages':
        manager.setLanguages(id, message.callId, message.settings);
        break;
      case 'call.mute':
        manager.mute(id, message.callId, message.muted);
        break;
      case 'debug.say': {
        const callId = manager.sessionOf(id)?.callId;
        if (!deps.debug) return fail('debug_disabled', 'Solo disponible con proveedores simulados');
        if (!callId) return fail('unknown_call', 'No hay una llamada activa');
        const ok =
          message.as === 'operator'
            ? deps.debug.sayAsOperator(id, callId, message.text, message.lang)
            : deps.debug.sayAsPassenger(callId, message.text, message.lang);
        if (!ok) fail('unknown_call', 'No se pudo simular la voz en esta llamada', callId);
        break;
      }
      case 'auth.login':
      case 'auth.resume':
        fail('bad_message', 'Ya has iniciado sesión');
        break;
    }
  };

  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      if (!operatorId) return;
      const bytes = rawToBytes(data);
      const frame = decodeAudioFrame(bytes, SERVER_ACCEPTED_FRAME_TYPES);
      if (!frame.ok) {
        if (++badFrames >= MAX_BAD_FRAMES) ws.close(1008, 'too many bad frames');
        return;
      }
      deps.manager.pushOperatorAudio(operatorId, frame.value.pcm.slice());
      return;
    }

    const now = Date.now();
    tokens = Math.min(200, tokens + ((now - lastRefill) / 1000) * 100);
    lastRefill = now;
    if (--tokens < 0) {
      ws.close(1008, 'rate limit');
      return;
    }

    const raw = rawToBytes(data);
    if (raw.byteLength > MAX_CONTROL_MESSAGE_LENGTH) return fail('bad_message', 'Mensaje demasiado grande');
    const parsed = parseClientMessage(Buffer.from(raw).toString('utf8'));
    if (!parsed.ok) return fail('bad_message', 'Mensaje no válido');
    const message = parsed.value;

    if (!operatorId) {
      if (message.type !== 'auth.login' && message.type !== 'auth.resume') return fail('not_authenticated', 'Primero hay que iniciar sesión');
      void authenticate(message).catch((error: unknown) => {
        deps.logger.error('Fallo al autenticar un operador', { error: String(error) });
        fail('internal_error', 'No se pudo iniciar sesión');
      });
      return;
    }
    try {
      handleControl(message, operatorId);
    } catch (error) {
      deps.logger.error('Fallo al procesar un mensaje del operador', { type: message.type, error: String(error) });
      fail('internal_error', 'No se pudo procesar el mensaje');
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (operatorId) deps.manager.disconnectOperator(operatorId);
  });
  ws.on('error', (error) => deps.logger.warn('Error en un socket de operador', { error: error.message }));
}

function rawToBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
