/**
 * Local control channel so `colgar` can reach the simulator processes running on this machine.
 * Each phone process listens on 127.0.0.1 at a random port and registers itself (port + token) in a
 * JSON file under the control directory; `colgar` reads those files and sends `{"accion":"colgar"}`.
 * A dead process leaves a stale file, which `colgar` removes when the connection is refused.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface PhoneRegistration {
  pid: number;
  port: number;
  token: string;
  numero: string;
  idioma: string;
  comando: string;
  iniciado: number;
}

export type HangupRequestResult = 'ok' | 'rechazado' | 'sin_respuesta' | 'no_disponible';

export const CONTROL_DIR_ENV = 'TW_SIM_CONTROL_DIR';

export function defaultControlDir(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env[CONTROL_DIR_ENV]?.trim();
  return custom ? custom : join(tmpdir(), 'telecomway-simulador');
}

export interface ControlServerOptions {
  dir: string;
  numero: string;
  idioma: string;
  comando: string;
  onHangup: () => void | Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function handleControlConnection(socket: Socket, token: string, onHangup: () => void | Promise<void>): void {
  let buffer = '';
  let answered = false;
  socket.setEncoding('utf8');
  socket.setTimeout(3000, () => socket.destroy());
  const reply = (value: object): void => {
    if (answered) return;
    answered = true;
    socket.end(`${JSON.stringify(value)}\n`);
  };
  const respond = async (line: string): Promise<void> => {
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      reply({ ok: false, error: 'JSON no válido' });
      return;
    }
    if (!isRecord(request) || request.token !== token) {
      reply({ ok: false, error: 'token incorrecto' });
      return;
    }
    if (request.accion === 'colgar') {
      try {
        await onHangup();
        reply({ ok: true });
      } catch (error) {
        reply({ ok: false, error: String(error) });
      }
      return;
    }
    reply({ ok: false, error: 'acción desconocida' });
  };
  socket.on('data', (chunk: string) => {
    if (answered) return;
    buffer += chunk;
    const newline = buffer.indexOf('\n');
    if (newline < 0) {
      if (buffer.length > 4096) socket.destroy();
      return;
    }
    void respond(buffer.slice(0, newline));
  });
  socket.on('error', () => socket.destroy());
}

/** Runs inside a phone process. */
export class ControlServer {
  private readonly sockets = new Set<Socket>();

  private constructor(
    private readonly server: Server,
    readonly file: string,
    readonly registration: PhoneRegistration,
  ) {
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  static async start(options: ControlServerOptions): Promise<ControlServer> {
    await mkdir(options.dir, { recursive: true });
    const token = randomBytes(16).toString('hex');
    const server = createServer();
    server.on('connection', (socket) => handleControlConnection(socket, token, options.onHangup));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const registration: PhoneRegistration = {
      pid: process.pid,
      port,
      token,
      numero: options.numero,
      idioma: options.idioma,
      comando: options.comando,
      iniciado: Date.now(),
    };
    const file = join(options.dir, `${process.pid}-${port}.json`);
    await writeFile(file, JSON.stringify(registration), { mode: 0o600 });
    return new ControlServer(server, file, registration);
  }

  async stop(): Promise<void> {
    await rm(this.file, { force: true }).catch(() => undefined);
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function isRegistration(value: unknown): value is PhoneRegistration {
  return (
    isRecord(value) &&
    typeof value.pid === 'number' &&
    typeof value.port === 'number' &&
    value.port > 0 &&
    value.port < 65536 &&
    typeof value.token === 'string' &&
    typeof value.numero === 'string' &&
    typeof value.idioma === 'string' &&
    typeof value.comando === 'string' &&
    typeof value.iniciado === 'number'
  );
}

export interface RegisteredPhone {
  file: string;
  registration: PhoneRegistration;
}

export async function listRegisteredPhones(dir: string): Promise<RegisteredPhone[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const phones: RegisteredPhone[] = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const file = join(dir, name);
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (isRegistration(parsed)) phones.push({ file, registration: parsed });
    } catch {
      // Unreadable or half-written file: ignore it.
    }
  }
  return phones;
}

/** Asks one phone process to hang up. */
export function requestHangup(registration: PhoneRegistration, timeoutMs = 3000): Promise<HangupRequestResult> {
  return new Promise((resolve) => {
    let buffer = '';
    let settled = false;
    const socket = connect({ port: registration.port, host: '127.0.0.1' });
    const finish = (result: HangupRequestResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish('sin_respuesta'), timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify({ accion: 'colgar', token: registration.token })}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response: unknown = JSON.parse(buffer.slice(0, newline));
        finish(isRecord(response) && response.ok === true ? 'ok' : 'rechazado');
      } catch {
        finish('rechazado');
      }
    });
    socket.once('error', () => finish('no_disponible'));
    socket.once('close', () => finish('sin_respuesta'));
  });
}

export interface HangupPhonesOptions {
  dir: string;
  /** Only phones registered with this number. */
  numero?: string;
  timeoutMs?: number;
}

export interface HangupPhonesOutcome {
  phone: RegisteredPhone;
  result: HangupRequestResult;
}

/** Hangs up every registered phone (or those with `numero`); stale registrations are deleted. */
export async function hangupPhones(options: HangupPhonesOptions): Promise<HangupPhonesOutcome[]> {
  const wanted = options.numero?.replace(/\s+/g, '');
  const phones = (await listRegisteredPhones(options.dir)).filter(
    (phone) => !wanted || phone.registration.numero.replace(/\s+/g, '') === wanted,
  );
  const outcomes: HangupPhonesOutcome[] = [];
  for (const phone of phones) {
    const result = await requestHangup(phone.registration, options.timeoutMs);
    if (result === 'no_disponible') await rm(phone.file, { force: true }).catch(() => undefined);
    outcomes.push({ phone, result });
  }
  return outcomes;
}
