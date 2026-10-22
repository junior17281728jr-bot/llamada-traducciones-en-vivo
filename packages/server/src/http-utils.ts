import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiErrorBody } from '@tw/shared';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'same-site',
};

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...headers,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, error: HttpError, headers: Record<string, string> = {}): void {
  const body: ApiErrorBody = { error: { code: error.code, message: error.message } };
  sendJson(res, error.status, body, headers);
}

/** Reads a JSON body of at most `limit` bytes; anything else is a 4xx. */
export async function readJsonBody(req: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'El contenido debe ser application/json');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new HttpError(413, 'payload_too_large', 'El mensaje es demasiado grande');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_json', 'El cuerpo no es un JSON válido');
  }
}

/** Parses a single `bytes=a-b` range. Null when absent or unsatisfiable shapes we do not serve. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';
  const [, from, to] = match;
  let start: number;
  let end: number;
  if (from === '' && to === '') return 'invalid';
  if (from === '') {
    const suffix = Number(to);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(from);
    end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  }
  if (!(start <= end) || start >= size) return 'invalid';
  return { start, end };
}
