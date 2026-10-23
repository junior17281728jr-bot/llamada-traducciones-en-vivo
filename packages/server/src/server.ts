import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { OPERATOR_WS_PATH, SIM_WS_PATH, type CallChannel } from '@tw/shared';
import { handleApi, type ApiDeps } from './api.js';
import { MockCallChannel } from './channel/mock-channel.js';
import { HttpError, SECURITY_HEADERS, sendError, sendJson } from './http-utils.js';
import { handleOperatorSocket, type OperatorSocketDeps } from './operator-socket.js';
import { handleSimSocket } from './sim-socket.js';
import { serveStatic } from './static.js';

export interface ServerDeps extends ApiDeps {
  channel: CallChannel;
  /** Folder with the compiled operator page to serve at `/` (same origin as the API); omitted = API only. */
  staticDir?: string;
  socket: Pick<OperatorSocketDeps, 'debug' | 'systemStatus' | 'localAudio'>;
}

function corsHeaders(req: IncomingMessage, allowed: string[]): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin) return {};
  if (allowed.length > 0 && !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'authorization, content-type, range',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Max-Age': '600',
  };
}

export interface RunningServer {
  server: Server;
  start(): Promise<number>;
  stop(): Promise<void>;
}

/**
 * HTTP API + operator WebSocket (`/operator`) + simulator WebSocket (`/sim`, only with the mock
 * channel, only from the same machine and never from a browser page). Operators authenticate with
 * bearer tokens, never cookies. Everything is plain HTTP/WS: outside 127.0.0.1 put a TLS proxy in
 * front (and do not forward `/sim` through it: behind a proxy every client looks local).
 */
export function createTelecomwayServer(deps: ServerDeps): RunningServer {
  const { config, logger } = deps;
  const operatorWss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  const simWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const mock = deps.channel instanceof MockCallChannel ? deps.channel : null;
  const alive = new WeakMap<WebSocket, boolean>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const cors = corsHeaders(req, config.allowedOrigins);
      try {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { ...SECURITY_HEADERS, ...cors });
          res.end();
          return;
        }
        const url = new URL(req.url ?? '/', 'http://localhost');
        for (const [name, value] of Object.entries(cors)) res.setHeader(name, value);
        if (await handleApi(req, res, url, deps)) return;
        if (deps.staticDir && (await serveStatic(req, res, url.pathname, deps.staticDir))) return;
        throw new HttpError(404, 'not_found', 'No existe esa ruta');
      } catch (error) {
        if (error instanceof HttpError) {
          sendError(res, error, cors);
        } else {
          logger.error('Error no controlado en la API', { error: String(error) });
          sendJson(res, 500, { error: { code: 'internal_error', message: 'Ha ocurrido un error interno' } }, cors);
        }
      }
    })();
  });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.length > 0 && !config.allowedOrigins.includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (pathname === OPERATOR_WS_PATH) {
      operatorWss.handleUpgrade(req, socket, head, (ws) => operatorWss.emit('connection', ws, req));
    } else if (pathname === SIM_WS_PATH && mock) {
      // Browsers always send Origin and the simulator CLI never does: a web page open on this machine must not
      // be able to ring fake calls or listen to translated audio through the local-only simulator socket.
      if (origin && !config.allowedOrigins.includes(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      simWss.handleUpgrade(req, socket, head, (ws) => simWss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  operatorWss.on('connection', (ws, req) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    handleOperatorSocket(ws, req, {
      config,
      logger,
      operators: deps.operators,
      sessions: deps.sessions,
      limiter: deps.limiter,
      manager: deps.manager,
      channelKind: config.channel,
      ...deps.socket,
    });
  });
  if (mock) simWss.on('connection', (ws, req) => handleSimSocket(ws, req, mock, logger));

  const heartbeat = setInterval(() => {
    for (const ws of operatorWss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 15_000);
  heartbeat.unref();

  return {
    server,
    start: () =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          resolve((server.address() as AddressInfo).port);
        });
      }),
    async stop() {
      clearInterval(heartbeat);
      await deps.manager.stop();
      for (const ws of operatorWss.clients) ws.terminate();
      for (const ws of simWss.clients) ws.terminate();
      await deps.channel.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
