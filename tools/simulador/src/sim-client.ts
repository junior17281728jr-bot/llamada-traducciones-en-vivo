/**
 * WebSocket client of the server's passenger simulator (`/sim`). One client = one simulated phone.
 * Every outgoing message is validated with the shared schema; every incoming one is parsed with it.
 */
import { WebSocket, type RawData } from 'ws';
import {
  SIM_WS_PATH,
  SimClientMessageSchema,
  base64ToPcm16,
  bytesToMs,
  encodeMessage,
  parseSimServerMessage,
  type LanguageCode,
  type SimClientMessage,
  type SimServerMessage,
} from '@tw/shared';

export type SimState = Extract<SimServerMessage, { type: 'sim.state' }>;

/** One continuous stretch of audio the passenger heard: chunks closer than `burstGapMs` are merged. */
export interface HeardBurst {
  ms: number;
  chunks: number;
  startedAt: number;
  endedAt: number;
  text?: string;
}

export interface HeardChunk {
  ms: number;
  bytes: number;
  text?: string;
}

export interface SimClientEvents {
  state: SimState;
  audio: HeardChunk;
  heard: HeardBurst;
  close: { code: number; reason: string };
  error: Error;
  /** The server sent something the shared protocol does not accept. */
  protocolError: string;
}

export interface SimClientOptions {
  /** Server address: `ws://127.0.0.1:8787`, with or without the `/sim` path (`http://` is accepted too). */
  url: string;
  /** Quiet time that closes a heard burst. */
  burstGapMs?: number;
  connectTimeoutMs?: number;
  now?: () => number;
}

export class SimClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimClientError';
  }
}

type Handler<T> = (value: T) => void;

class TypedEmitter<Events extends object> {
  private readonly handlers = new Map<keyof Events, Set<Handler<never>>>();

  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => {
      set.delete(handler as Handler<never>);
    };
  }

  emit<K extends keyof Events>(event: K, value: Events[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) (handler as Handler<Events[K]>)(value);
  }
}

/** Normalises what the user typed into the exact `/sim` URL. */
export function normalizeServerUrl(input: string): string {
  let text = input.trim();
  if (!text) throw new SimClientError('Falta la dirección del servidor');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `ws://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new SimClientError(`Dirección del servidor no válida: ${input}`);
  }
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new SimClientError(`La dirección del servidor debe empezar por ws:// (recibido ${url.protocol}//)`);
  }
  if (url.pathname === '' || url.pathname === '/') url.pathname = SIM_WS_PATH;
  if (url.pathname !== SIM_WS_PATH) {
    throw new SimClientError(`La ruta del simulador es ${SIM_WS_PATH}; recibido ${url.pathname}`);
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

interface OpenBurst extends HeardBurst {
  timer: ReturnType<typeof setTimeout> | null;
}

export class SimClient {
  private readonly emitter = new TypedEmitter<SimClientEvents>();
  private readonly history: SimState[] = [];
  private readonly now: () => number;
  private readonly burstGapMs: number;
  private burst: OpenBurst | null = null;
  private lastBurst: HeardBurst | null = null;
  private heardMsTotal = 0;
  private heardBurstCount = 0;
  private closed = false;
  private closeInfo: { code: number; reason: string } | null = null;

  private constructor(
    readonly url: string,
    private readonly ws: WebSocket,
    options: SimClientOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.burstGapMs = options.burstGapMs ?? 600;
    this.attach();
  }

  static connect(options: SimClientOptions): Promise<SimClient> {
    const url = normalizeServerUrl(options.url);
    const timeoutMs = options.connectTimeoutMs ?? 5000;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new SimClientError(`${url} no respondió en ${timeoutMs} ms`));
      }, timeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(new SimClient(url, ws, options));
      });
      ws.once('error', (error: Error) => {
        clearTimeout(timer);
        reject(new SimClientError(`No se pudo conectar con ${url}: ${error.message}`));
      });
      ws.once('unexpected-response', (_request, response) => {
        clearTimeout(timer);
        ws.terminate();
        reject(new SimClientError(`El servidor respondió ${response.statusCode ?? '?'} en ${url}: ¿está arrancado en modo simulado (CHANNEL=mock)?`));
      });
    });
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  get states(): readonly SimState[] {
    return this.history;
  }

  get lastState(): SimState | null {
    return this.history.at(-1) ?? null;
  }

  get callId(): string | null {
    return this.lastState?.callId ?? null;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get closeReason(): { code: number; reason: string } | null {
    return this.closeInfo;
  }

  /** Total audio heard so far (closed bursts only). */
  get heardMs(): number {
    return this.heardMsTotal;
  }

  get heardBursts(): number {
    return this.heardBurstCount;
  }

  get lastHeard(): HeardBurst | null {
    return this.lastBurst;
  }

  on<K extends keyof SimClientEvents>(event: K, handler: (value: SimClientEvents[K]) => void): () => void {
    return this.emitter.on(event, handler);
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  send(message: SimClientMessage): void {
    const check = SimClientMessageSchema.safeParse(message);
    if (!check.success) {
      const detail = check.error.issues.map((issue) => `${issue.path.join('.') || '(raíz)'}: ${issue.message}`).join('; ');
      throw new SimClientError(`Mensaje no válido para el servidor: ${detail}`);
    }
    if (this.ws.readyState !== WebSocket.OPEN) throw new SimClientError('La conexión con el servidor está cerrada');
    this.ws.send(encodeMessage(check.data));
  }

  incoming(from: string, lang: LanguageCode): void {
    this.send({ type: 'sim.incoming', from, lang });
  }

  listen(lang: LanguageCode): void {
    this.send({ type: 'sim.listen', lang });
  }

  answer(): void {
    this.send({ type: 'sim.answer' });
  }

  /** The passenger says `text`; the server synthesises the (speech-like, NOT real) audio for it. */
  say(text: string, lang: LanguageCode): void {
    this.send({ type: 'sim.say', text, lang });
  }

  hangup(): void {
    this.send({ type: 'sim.hangup' });
  }

  // ---------------------------------------------------------------------------
  // Waiting
  // ---------------------------------------------------------------------------

  /**
   * First state, among those received from index `since` on or in the future, that satisfies `predicate`.
   * Resolves null on timeout or when the connection closes. Without `timeoutMs` it waits indefinitely.
   */
  waitForState(predicate: (state: SimState) => boolean, timeoutMs?: number, since = 0): Promise<SimState | null> {
    for (let index = since; index < this.history.length; index++) {
      const state = this.history[index]!;
      if (predicate(state)) return Promise.resolve(state);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const done = (value: SimState | null): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        offState();
        offClose();
        resolve(value);
      };
      const timer = timeoutMs === undefined ? null : setTimeout(() => done(null), timeoutMs);
      const offState = this.on('state', (state) => {
        if (predicate(state)) done(state);
      });
      const offClose = this.on('close', () => done(null));
    });
  }

  /**
   * Next heard burst to close. With `sinceBursts` (a value of `heardBursts` taken earlier) a burst that
   * already closed after that point resolves immediately. Null on timeout or close.
   */
  waitForHeard(timeoutMs: number, sinceBursts?: number): Promise<HeardBurst | null> {
    if (sinceBursts !== undefined && this.heardBurstCount > sinceBursts && this.lastBurst) {
      return Promise.resolve(this.lastBurst);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const done = (value: HeardBurst | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        offHeard();
        offClose();
        resolve(value);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      const offHeard = this.on('heard', (burst) => done(burst));
      const offClose = this.on('close', () => done(null));
    });
  }

  /** Closes the burst in progress now (before a summary, or when the call has ended). */
  flushHeard(): void {
    this.flushBurst();
  }

  waitForClose(timeoutMs?: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = timeoutMs === undefined ? null : setTimeout(() => done(false), timeoutMs);
      const done = (value: boolean): void => {
        if (timer) clearTimeout(timer);
        off();
        resolve(value);
      };
      const off = this.on('close', () => done(true));
    });
  }

  /** Closes the socket; the server treats a closed simulator socket as the passenger hanging up. */
  async close(timeoutMs = 1000): Promise<void> {
    if (this.closed) return;
    if (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, 'fin');
    const closed = await this.waitForClose(timeoutMs);
    if (!closed) this.ws.terminate();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private attach(): void {
    this.ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const parsed = parseSimServerMessage(rawToString(data));
      if (!parsed.ok) {
        this.emitter.emit('protocolError', parsed.error);
        return;
      }
      this.handle(parsed.value);
    });
    this.ws.on('close', (code: number, reason: Buffer) => {
      this.closed = true;
      this.flushBurst();
      this.closeInfo = { code, reason: reason.toString('utf8') };
      this.emitter.emit('close', this.closeInfo);
    });
    this.ws.on('error', (error: Error) => this.emitter.emit('error', error));
  }

  private handle(message: SimServerMessage): void {
    if (message.type === 'sim.state') {
      this.history.push(message);
      this.emitter.emit('state', message);
      return;
    }
    let bytes: number;
    try {
      bytes = base64ToPcm16(message.audio).byteLength;
    } catch (error) {
      this.emitter.emit('protocolError', `sim.audio con base64 no válido: ${String(error)}`);
      return;
    }
    const ms = bytesToMs(bytes);
    const chunk: HeardChunk = { ms, bytes, ...(message.text !== undefined ? { text: message.text } : {}) };
    this.emitter.emit('audio', chunk);
    this.addToBurst(chunk);
  }

  private addToBurst(chunk: HeardChunk): void {
    const at = this.now();
    if (!this.burst) this.burst = { ms: 0, chunks: 0, startedAt: at, endedAt: at, timer: null };
    const burst = this.burst;
    burst.ms += chunk.ms;
    burst.chunks += 1;
    burst.endedAt = at;
    if (chunk.text) burst.text = burst.text ? `${burst.text} ${chunk.text}` : chunk.text;
    if (burst.timer) clearTimeout(burst.timer);
    burst.timer = setTimeout(() => this.flushBurst(), this.burstGapMs);
  }

  private flushBurst(): void {
    const open = this.burst;
    if (!open) return;
    if (open.timer) clearTimeout(open.timer);
    this.burst = null;
    const burst: HeardBurst = {
      ms: open.ms,
      chunks: open.chunks,
      startedAt: open.startedAt,
      endedAt: open.endedAt,
      ...(open.text !== undefined ? { text: open.text } : {}),
    };
    this.heardMsTotal += burst.ms;
    this.heardBurstCount += 1;
    this.lastBurst = burst;
    this.emitter.emit('heard', burst);
  }
}
