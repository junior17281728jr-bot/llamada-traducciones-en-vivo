/**
 * Fake `/sim` WebSocket server for tests: it speaks the shared simulator protocol like the real server
 * (same messages, same `ended/failed` on illegal operations, same `rejected` when the lines are full)
 * but with no pipeline behind it. Replies to `sim.say` are synthetic audio, never a translation.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  SIM_WS_PATH,
  base64ToPcm16,
  encodeMessage,
  parseSimClientMessage,
  pcm16ToBase64,
  synthesizeSpeechSignal,
  type CallEndReason,
  type Direction,
  type SimServerMessage,
} from '@tw/shared';

export interface FakeSimServerOptions {
  maxCalls?: number;
  /** Inbound calls become active on their own after `answerDelayMs`. */
  autoAnswer?: boolean;
  answerDelayMs?: number;
  /** After each `sim.say`, send synthetic audio back as if the operator had replied. */
  replyToSay?: boolean;
  replyDelayMs?: number;
  replyChunks?: number;
  replyChunkGapMs?: number;
  replyText?: (text: string, lang: string) => string;
  /** Attach the reply text to the first audio chunk (the real server does not). */
  replyIncludesText?: boolean;
}

export interface FakeCall {
  id: string;
  direction: Direction;
  remoteNumber: string;
  lang?: string;
  state: 'ringing' | 'active' | 'ended';
  reason?: CallEndReason;
  phone: FakePhone;
}

export interface FakeUtterance {
  callId: string;
  from: string;
  text: string;
  lang: string;
}

export class FakePhone {
  listening: string | null = null;
  call: FakeCall | null = null;
  receivedAudioBytes = 0;
  readonly sent: SimServerMessage[] = [];

  constructor(readonly ws: WebSocket) {}

  get live(): boolean {
    return this.call !== null && this.call.state !== 'ended';
  }

  send(message: SimServerMessage): void {
    this.sent.push(message);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encodeMessage(message));
  }

  sendState(call: FakeCall): void {
    this.send({
      type: 'sim.state',
      state: call.state,
      callId: call.id,
      direction: call.direction,
      remoteNumber: call.remoteNumber,
      ...(call.reason ? { reason: call.reason } : {}),
    });
  }
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

export class FakeSimServer {
  readonly phones = new Set<FakePhone>();
  readonly calls: FakeCall[] = [];
  readonly utterances: FakeUtterance[] = [];
  readonly rejected: FakeCall[] = [];
  readonly invalidMessages: string[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly options: Required<FakeSimServerOptions>;

  private constructor(
    private readonly http: Server,
    private readonly wss: WebSocketServer,
    readonly port: number,
    options: FakeSimServerOptions,
  ) {
    this.options = {
      maxCalls: options.maxCalls ?? 3,
      autoAnswer: options.autoAnswer ?? true,
      answerDelayMs: options.answerDelayMs ?? 20,
      replyToSay: options.replyToSay ?? true,
      replyDelayMs: options.replyDelayMs ?? 20,
      replyChunks: options.replyChunks ?? 3,
      replyChunkGapMs: options.replyChunkGapMs ?? 5,
      replyText: options.replyText ?? ((text) => `[respuesta simulada a] ${text}`),
      replyIncludesText: options.replyIncludesText ?? false,
    };
    wss.on('connection', (ws) => this.onConnection(ws));
  }

  static async start(options: FakeSimServerOptions = {}): Promise<FakeSimServer> {
    const http = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    const wss = new WebSocketServer({ noServer: true });
    http.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (pathname !== SIM_WS_PATH) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    });
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => {
        http.off('error', reject);
        resolve();
      });
    });
    const address = http.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return new FakeSimServer(http, wss, port, options);
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}${SIM_WS_PATH}`;
  }

  /** Base address without the path, as a user would type it. */
  get baseUrl(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  get liveCalls(): number {
    return this.calls.filter((call) => call.state !== 'ended').length;
  }

  get activeCalls(): FakeCall[] {
    return this.calls.filter((call) => call.state === 'active');
  }

  /** An operator dials out: rings on the first idle phone that is listening. */
  dial(number: string): FakeCall | null {
    const phone = [...this.phones].find((candidate) => candidate.listening !== null && !candidate.live);
    if (!phone) return null;
    const call: FakeCall = { id: randomUUID(), direction: 'outbound', remoteNumber: number, state: 'ringing', phone };
    if (phone.listening) call.lang = phone.listening;
    phone.call = call;
    this.calls.push(call);
    phone.sendState(call);
    return call;
  }

  answerInbound(callId: string): boolean {
    const call = this.calls.find((candidate) => candidate.id === callId);
    if (!call || call.state !== 'ringing') return false;
    this.activate(call);
    return true;
  }

  hangupFromOperator(callId: string, reason: CallEndReason = 'hangup_operator'): boolean {
    const call = this.calls.find((candidate) => candidate.id === callId);
    if (!call || call.state === 'ended') return false;
    this.end(call, reason);
    return true;
  }

  /** What the passenger hears. */
  sendAudioToPassenger(callId: string, pcm: Uint8Array, text?: string): boolean {
    const call = this.calls.find((candidate) => candidate.id === callId);
    if (!call || call.state !== 'active') return false;
    call.phone.send({ type: 'sim.audio', audio: pcm16ToBase64(pcm), ...(text !== undefined ? { text } : {}) });
    return true;
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  private later(ms: number, task: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      task();
    }, ms);
    this.timers.add(timer);
  }

  private onConnection(ws: WebSocket): void {
    const phone = new FakePhone(ws);
    this.phones.add(phone);
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const parsed = parseSimClientMessage(rawToString(data));
      if (!parsed.ok) {
        this.invalidMessages.push(parsed.error);
        return;
      }
      this.handle(phone, parsed.value);
    });
    ws.on('close', () => {
      if (phone.call && phone.call.state !== 'ended') this.end(phone.call, 'hangup_passenger');
      this.phones.delete(phone);
    });
    ws.on('error', () => undefined);
  }

  private handle(phone: FakePhone, message: ReturnType<typeof parseSimClientMessage> extends infer R ? (R extends { ok: true; value: infer V } ? V : never) : never): void {
    switch (message.type) {
      case 'sim.incoming': {
        if (phone.live) {
          phone.send({ type: 'sim.state', state: 'ended', callId: null, reason: 'failed' });
          return;
        }
        const call: FakeCall = { id: randomUUID(), direction: 'inbound', remoteNumber: message.from, lang: message.lang, state: 'ringing', phone };
        phone.call = call;
        this.calls.push(call);
        phone.sendState(call);
        if (this.liveCalls > this.options.maxCalls) {
          this.rejected.push(call);
          this.end(call, 'rejected');
          return;
        }
        if (this.options.autoAnswer) {
          this.later(this.options.answerDelayMs, () => {
            if (call.state === 'ringing') this.activate(call);
          });
        }
        return;
      }
      case 'sim.listen':
        phone.listening = message.lang;
        return;
      case 'sim.answer':
        if (phone.call && phone.call.direction === 'outbound' && phone.call.state === 'ringing') this.activate(phone.call);
        return;
      case 'sim.say': {
        const call = phone.call;
        if (!call || call.state !== 'active') {
          phone.send({ type: 'sim.state', state: 'ended', callId: null, reason: 'failed' });
          return;
        }
        this.utterances.push({ callId: call.id, from: call.remoteNumber, text: message.text, lang: message.lang });
        if (this.options.replyToSay) this.later(this.options.replyDelayMs, () => this.reply(call, message.text, message.lang));
        return;
      }
      case 'sim.audio':
        phone.receivedAudioBytes += base64ToPcm16(message.audio).byteLength;
        return;
      case 'sim.hangup':
        if (phone.call && phone.call.state !== 'ended') this.end(phone.call, 'hangup_passenger');
        return;
    }
  }

  private activate(call: FakeCall): void {
    if (call.state !== 'ringing') return;
    call.state = 'active';
    call.phone.sendState(call);
  }

  private end(call: FakeCall, reason: CallEndReason): void {
    if (call.state === 'ended') return;
    call.state = 'ended';
    call.reason = reason;
    call.phone.sendState(call);
  }

  private reply(call: FakeCall, text: string, lang: string): void {
    if (call.state !== 'active') return;
    const replyText = this.options.replyText(text, lang);
    const pcm = synthesizeSpeechSignal(replyText, { msPerChar: 10, pitchHz: 120 });
    const chunks = Math.max(1, this.options.replyChunks);
    const chunkBytes = Math.ceil(pcm.byteLength / chunks / 2) * 2;
    for (let index = 0; index < chunks; index++) {
      const part = pcm.subarray(index * chunkBytes, Math.min(pcm.byteLength, (index + 1) * chunkBytes));
      if (part.byteLength === 0) break;
      const withText = this.options.replyIncludesText && index === 0 ? replyText : undefined;
      this.later(index * this.options.replyChunkGapMs, () => this.sendAudioToPassenger(call.id, part, withText));
    }
  }
}
