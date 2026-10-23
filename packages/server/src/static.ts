import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { SECURITY_HEADERS } from './http-utils.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
};

/** Headers for the operator page itself (not the JSON API): scripts, styles and audio are allowed. */
const PAGE_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

/**
 * Serves the compiled operator page (dist/renderer) from the same origin as the API, so the desktop
 * app (and a browser on the same machine) need no CORS and no second web server. Only GET/HEAD, only
 * files inside `dir`, `/` is index.html, hashed assets are cached, index.html never is.
 */
export async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string, dir: string): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const root = resolve(dir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = resolve(join(root, relative));
  if (target !== root && !target.startsWith(root + sep)) return false;
  let info;
  try {
    info = await stat(target);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;
  const type = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
  const hashed = /\/assets\//.test(target.replace(/\\/g, '/'));
  res.writeHead(200, {
    ...PAGE_HEADERS,
    'Content-Type': type,
    'Content-Length': info.size,
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  await new Promise<void>((done) => {
    const stream = createReadStream(target);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500, SECURITY_HEADERS);
      res.end();
      done();
    });
    stream.on('close', done);
    stream.pipe(res);
  });
  return true;
}
