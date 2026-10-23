/**
 * Thin layer over `ws`: opens a socket and turns handshake failures into typed errors. Tests run
 * against local WebSocket servers, so the default factory is the real `ws` client; the factory
 * is injectable for anything exotic.
 */
import type { IncomingMessage, ClientRequest } from 'node:http';
import { WebSocket, type RawData } from 'ws';
import { errorFromUpgradeStatus, transportError, type ElevenLabsService } from './errors.js';

export interface SocketOptions {
  headers: Record<string, string>;
  handshakeTimeoutMs: number;
}

export type WebSocketFactory = (url: string, options: SocketOptions) => WebSocket;

export const defaultWebSocketFactory: WebSocketFactory = (url, options) =>
  new WebSocket(url, { headers: options.headers, handshakeTimeout: options.handshakeTimeoutMs, perMessageDeflate: false });

/** Host and path only (no query, never credentials), for logs. */
export function describeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return 'url inválida';
  }
}

export function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

/**
 * Messages that arrive between `open` and the moment the caller attaches its `message` handler
 * (the server's first frames often share the packet with the handshake and are emitted on the next
 * tick, before a promise continuation runs). `takeEarlyMessages` hands them over exactly once.
 */
const earlyMessages = new WeakMap<WebSocket, { buffered: RawData[]; collector: (data: RawData) => void }>();

/** Removes the early-message collector and returns what it caught, in order. Call it right after attaching the real handler. */
export function takeEarlyMessages(ws: WebSocket): RawData[] {
  const entry = earlyMessages.get(ws);
  if (!entry) return [];
  earlyMessages.delete(ws);
  ws.off('message', entry.collector);
  return entry.buffered;
}

/**
 * Connects and resolves once the socket is open. A refused upgrade (401, 429...) rejects with the
 * matching `ElevenLabsError`; connection errors and handshake timeouts reject as `transport`.
 * The returned socket already has a no-op `error` listener so a late error can never crash the process,
 * and it buffers early messages until `takeEarlyMessages` is called.
 */
export function openSocket(factory: WebSocketFactory, service: ElevenLabsService, url: string, options: SocketOptions): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = factory(url, options);
    } catch (error) {
      reject(transportError(service, `${describeUrl(url)}: ${(error as Error).message}`, error));
      return;
    }
    ws.on('error', noop);
    const buffered: RawData[] = [];
    const collector = (data: RawData): void => {
      buffered.push(data);
    };
    ws.on('message', collector);
    earlyMessages.set(ws, { buffered, collector });
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      ws.off('open', onOpen);
      ws.off('error', onError);
      ws.off('unexpected-response', onUnexpected);
      ws.off('close', onClose);
      action();
    };
    const onOpen = (): void => settle(() => resolve(ws));
    const onError = (error: Error): void => settle(() => reject(transportError(service, `${describeUrl(url)}: ${error.message}`, error)));
    const onUnexpected = (_request: ClientRequest, response: IncomingMessage): void => {
      const status = response.statusCode ?? 0;
      response.resume();
      ws.terminate();
      settle(() => reject(errorFromUpgradeStatus(service, status)));
    };
    const onClose = (code: number): void => settle(() => reject(transportError(service, `${describeUrl(url)}: la conexión se cerró antes de abrirse (código ${code})`)));
    ws.once('open', onOpen);
    ws.once('error', onError);
    ws.once('unexpected-response', onUnexpected);
    ws.once('close', onClose);
  });
}

/** Sends JSON if the socket is open; returns false otherwise. */
export function sendJson(ws: WebSocket | null, message: unknown): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
}

/** Closes politely and resolves when the socket reports `close` (or after `timeoutMs`). */
export function closeSocket(ws: WebSocket, timeoutMs = 500): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      ws.terminate();
      resolve();
    }, timeoutMs);
    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    else ws.close(1000);
  });
}

function noop(): void {}
