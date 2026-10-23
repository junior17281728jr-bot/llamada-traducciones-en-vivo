/**
 * Local stand-in for the ElevenLabs realtime endpoints, for tests only. It speaks the protocol the way
 * `protocol.ts` describes it (UNVERIFIED, exactly like the client) on 127.0.0.1 and lets tests inject
 * refused upgrades, error messages, dropped connections and alternative field names.
 *
 * Transcripts are scripted: synthetic audio cannot be recognised by anything, so a test queues the text
 * with `say()` and the fake "hears" it at the pace of the audio that really arrives (like `ScriptedStt`).
 * Voices are deterministic tones (`synthesizeSpeechSignal`) encoded in the requested `output_format`.
 */
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  WireToInternal,
  base64ToPcm16,
  msToBytes,
  parseAudioFormat,
  pcm16Rms,
  pcm16ToAlaw,
  pcm16ToBase64,
  pcm16ToMulaw,
  pcmDurationMs,
  speechSignalDurationMs,
  synthesizeSpeechSignal,
  type WireCodec,
} from '@tw/shared';
import { ELEVENLABS_AUTH_HEADER, STT_CLIENT_MESSAGE_TYPE, STT_PATH, STT_QUERY, STT_SERVER_MESSAGE, TTS_QUERY } from '../protocol.js';

export interface ScriptedUtterance {
  text: string;
  lang: string;
  probability?: number;
}

export interface FakeSttBehavior {
  /** `canonical` sends text/language_code; `alternative` sends transcript/language. */
  fieldStyle?: 'canonical' | 'alternative';
  sendSessionStarted?: boolean;
  /** Also send `committed_transcript_with_timestamps` after each `committed_transcript`. */
  duplicateCommits?: boolean;
  /** Terminate the socket (no close frame) once this many audio chunks arrived. Fires once per server. */
  dropAfterChunks?: number | null;
  /** Send this error on the first audio chunk at or after this count (optionally closing with `close`). Fires once per server. */
  errorAfterChunks?: { count: number; type: string; message?: string; close?: number } | null;
  voicedRms?: number;
  /** Sent right after `session_started` (to exercise the unknown-message path). */
  extraMessages?: Record<string, unknown>[];
}

export interface FakeTtsBehavior {
  chunkMs?: number;
  /** Delay between audio chunks; 0 = as fast as possible. */
  paceMs?: number;
  /** Pitch per voice id; others use 180 Hz. */
  voicePitch?: Record<string, number>;
  /** Runs when a connection is accepted (index from 0), before any message: set failure flags here. */
  onConnection?: (connection: FakeTtsConnection, index: number) => void;
  /** Close after `isFinal`, as the real service is believed to do. */
  closeAfterFinal?: boolean;
}

export interface FakeElevenLabsOptions {
  /** Expected `xi-api-key`; null or undefined accepts any key. */
  apiKey?: string | null;
  stt?: FakeSttBehavior;
  tts?: FakeTtsBehavior;
  /** HTTP status to refuse the n-th upgrade of a kind (index from 0), or null to accept it. */
  refuseUpgrade?: (info: { kind: 'stt' | 'tts'; index: number; path: string }) => number | null;
}

const TTS_PATH_PATTERN = /^\/v1\/text-to-speech\/([^/]+)\/stream-input$/;
const STATUS_TEXT: Record<number, string> = { 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 500: 'Internal Server Error', 503: 'Service Unavailable' };

export function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

export class FakeElevenLabsServer {
  readonly sttSessions: FakeSttSession[] = [];
  readonly ttsConnections: FakeTtsConnection[] = [];
  readonly refused: { kind: 'stt' | 'tts'; status: number }[] = [];
  readonly sttBehavior: FakeSttBehavior;
  readonly ttsBehavior: FakeTtsBehavior;
  /** Audio chunks sent by all TTS connections so far (to order events in tests). */
  ttsChunksSent = 0;
  private readonly scripts = new Map<string, ScriptedUtterance[]>();
  private readonly upgrades = { stt: 0, tts: 0 };
  private sessionSeq = 0;

  private constructor(
    private readonly server: Server,
    private readonly wss: WebSocketServer,
    private readonly options: FakeElevenLabsOptions,
    readonly port: number,
  ) {
    this.sttBehavior = { ...options.stt };
    this.ttsBehavior = { ...options.tts };
    server.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head));
  }

  static start(options: FakeElevenLabsOptions = {}): Promise<FakeElevenLabsServer> {
    return new Promise((resolve, reject) => {
      const server = createServer((_request, response) => {
        response.statusCode = 426;
        response.end();
      });
      const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve(new FakeElevenLabsServer(server, wss, options, port));
      });
    });
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  /** Queues what the next voiced audio of the STT session with this `language_code` ('' or null = auto) will "say". */
  say(languageCode: string | null, utterance: ScriptedUtterance): void {
    const key = languageCode ?? '';
    const queue = this.scripts.get(key) ?? [];
    queue.push(utterance);
    this.scripts.set(key, queue);
  }

  takeScript(key: string): ScriptedUtterance | undefined {
    return this.scripts.get(key)?.shift();
  }

  returnScript(key: string, utterance: ScriptedUtterance): void {
    const queue = this.scripts.get(key) ?? [];
    queue.unshift(utterance);
    this.scripts.set(key, queue);
  }

  pitchFor(voiceId: string): number {
    return this.ttsBehavior.voicePitch?.[voiceId] ?? 180;
  }

  /** Internal-format PCM the client should emit for `text` spoken by `voiceId` with `format` on the wire. */
  expectedTtsAudio(text: string, voiceId: string, format: string): Uint8Array {
    const parsed = parseAudioFormat(format);
    const signal = synthesizeSpeechSignal(text.trim(), { sampleRate: parsed.sampleRate, pitchHz: this.pitchFor(voiceId) });
    return new WireToInternal(format).push(encode(signal, parsed.codec));
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const ttsMatch = TTS_PATH_PATTERN.exec(url.pathname);
    const kind: 'stt' | 'tts' | null = url.pathname === STT_PATH ? 'stt' : ttsMatch ? 'tts' : null;
    if (!kind) {
      refuse(socket, 404);
      return;
    }
    const expected = this.options.apiKey;
    if (expected != null && request.headers[ELEVENLABS_AUTH_HEADER] !== expected) {
      this.refused.push({ kind, status: 401 });
      refuse(socket, 401);
      return;
    }
    const index = this.upgrades[kind]++;
    const forced = this.options.refuseUpgrade?.({ kind, index, path: url.pathname }) ?? null;
    if (forced) {
      this.refused.push({ kind, status: forced });
      refuse(socket, forced);
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      if (kind === 'stt') {
        this.sttSessions.push(new FakeSttSession(this, ws, url.searchParams, request.headers, ++this.sessionSeq));
      } else {
        const connection = new FakeTtsConnection(this, ws, decodeURIComponent(ttsMatch![1]!), url.searchParams, request.headers);
        this.ttsConnections.push(connection);
        this.ttsBehavior.onConnection?.(connection, this.ttsConnections.length - 1);
      }
    });
  }
}

function refuse(socket: Duplex, status: number): void {
  socket.write(`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function encode(pcm: Uint8Array, codec: WireCodec): Uint8Array {
  switch (codec) {
    case 'pcm':
      return pcm;
    case 'ulaw':
      return pcm16ToMulaw(pcm);
    case 'alaw':
      return pcm16ToAlaw(pcm);
  }
}

interface ActiveUtterance {
  utterance: ScriptedUtterance;
  words: string[];
  startedAtMs: number;
  durationMs: number;
  revealed: number;
}

export class FakeSttSession {
  readonly languageCode: string;
  readonly audioFormat: string;
  readonly messages: Record<string, unknown>[] = [];
  chunks = 0;
  audioBytes = 0;
  commits = 0;
  closeCode: number | null = null;
  closeReason = '';
  /** Set when an injected failure ended the session: late chunks are ignored, as a dead server session would. */
  ended = false;
  private readonly wire: WireToInternal;
  private clockMs = 0;
  private active: ActiveUtterance | null = null;

  constructor(
    private readonly server: FakeElevenLabsServer,
    private readonly ws: WebSocket,
    readonly params: URLSearchParams,
    readonly headers: IncomingHttpHeaders,
    readonly id: number,
  ) {
    this.languageCode = params.get(STT_QUERY.languageCode) ?? '';
    this.audioFormat = params.get(STT_QUERY.audioFormat) ?? 'pcm_16000';
    this.wire = new WireToInternal(this.audioFormat);
    ws.on('error', () => undefined);
    ws.on('message', (data) => this.onMessage(rawToString(data)));
    ws.on('close', (code, reason) => {
      this.closeCode = code;
      this.closeReason = reason.toString();
      this.ended = true;
    });
    const behavior = server.sttBehavior;
    if (behavior.sendSessionStarted !== false) this.send({ message_type: STT_SERVER_MESSAGE.sessionStarted, session_id: `fake-stt-${id}` });
    for (const extra of behavior.extraMessages ?? []) this.send(extra);
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  /** Milliseconds of audio heard so far. */
  get heardMs(): number {
    return this.clockMs;
  }

  send(message: Record<string, unknown>): void {
    if (this.open) this.ws.send(JSON.stringify(message));
  }

  sendError(type: string, message?: string): void {
    this.send({ message_type: type, message: message ?? type });
  }

  terminate(): void {
    this.ws.terminate();
  }

  close(code = 1000, reason = ''): void {
    this.ws.close(code, reason);
  }

  private onMessage(text: string): void {
    if (this.ended) return;
    const message = JSON.parse(text) as Record<string, unknown>;
    if (this.messages.length < 10_000) this.messages.push(message);
    if (message.message_type !== STT_CLIENT_MESSAGE_TYPE) return;
    const audio = typeof message.audio_base_64 === 'string' ? message.audio_base_64 : '';
    if (audio) {
      const bytes = base64ToPcm16(audio);
      this.audioBytes += bytes.byteLength;
      this.chunks += 1;
      this.hear(this.wire.push(bytes));
      const behavior = this.server.sttBehavior;
      if (behavior.errorAfterChunks && this.chunks >= behavior.errorAfterChunks.count) {
        const injected = behavior.errorAfterChunks;
        behavior.errorAfterChunks = null;
        // Like a server whose session just ended: whatever was being heard is lost and must be sent again.
        if (this.active) this.server.returnScript(this.languageCode, this.active.utterance);
        this.active = null;
        this.ended = true;
        this.sendError(injected.type, injected.message);
        if (injected.close) this.close(injected.close, injected.type);
        return;
      }
      if (behavior.dropAfterChunks != null && this.chunks >= behavior.dropAfterChunks) {
        behavior.dropAfterChunks = null;
        if (this.active) this.server.returnScript(this.languageCode, this.active.utterance);
        this.active = null;
        this.ended = true;
        this.terminate();
        return;
      }
    }
    if (message.commit === true) {
      this.commits += 1;
      this.commitNow();
    }
  }

  private hear(pcm: Uint8Array): void {
    const voiced = pcm16Rms(pcm) >= (this.server.sttBehavior.voicedRms ?? 0.002);
    if (!this.active && voiced) {
      const utterance = this.server.takeScript(this.languageCode);
      if (utterance) {
        this.active = {
          utterance,
          words: utterance.text.split(/\s+/).filter(Boolean),
          startedAtMs: this.clockMs,
          durationMs: Math.max(1, speechSignalDurationMs(utterance.text)),
          revealed: 0,
        };
      }
    }
    this.clockMs += pcmDurationMs(pcm);
    const active = this.active;
    if (!active) return;
    const elapsed = this.clockMs - active.startedAtMs;
    if (elapsed >= active.durationMs) {
      this.finish(active);
      return;
    }
    const target = Math.min(active.words.length, Math.floor((active.words.length * elapsed) / active.durationMs));
    if (target > active.revealed) {
      active.revealed = target;
      this.send({ message_type: STT_SERVER_MESSAGE.partial, ...this.fields(active.words.slice(0, target).join(' '), active.utterance.lang) });
    }
  }

  private commitNow(): void {
    if (this.active) {
      this.finish(this.active);
      return;
    }
    const utterance = this.server.takeScript(this.languageCode);
    if (utterance) this.finish({ utterance, words: [], startedAtMs: this.clockMs, durationMs: 0, revealed: 0 });
  }

  private finish(active: ActiveUtterance): void {
    this.active = null;
    const { text, lang, probability } = active.utterance;
    const fields = { ...this.fields(text, lang), language_probability: probability ?? 0.95 };
    this.send({ message_type: STT_SERVER_MESSAGE.committed, ...fields });
    if (this.server.sttBehavior.duplicateCommits) {
      this.send({
        message_type: STT_SERVER_MESSAGE.committedWithTimestamps,
        ...fields,
        words: [{ text, start: active.startedAtMs / 1000, end: this.clockMs / 1000 }],
      });
    }
  }

  private fields(text: string, lang: string): Record<string, unknown> {
    return this.server.sttBehavior.fieldStyle === 'alternative' ? { transcript: text, language: lang } : { text, language_code: lang };
  }
}

export class FakeTtsConnection {
  readonly modelId: string | null;
  readonly outputFormat: string;
  readonly messages: Record<string, unknown>[] = [];
  init: Record<string, unknown> | null = null;
  readonly texts: string[] = [];
  keepalives = 0;
  flushes = 0;
  eosReceived = false;
  audioChunksSent = 0;
  closeCode: number | null = null;
  /** Server-wide TTS chunk count when this connection was accepted (ordering in tests). */
  readonly openedAtChunk: number;
  /** Failure injection (set from `onConnection`). */
  errorBeforeAudio: { error: string; message?: string; close?: number } | null = null;
  terminateAfterChunks: number | null = null;
  private buffer = '';
  private chain: Promise<void> = Promise.resolve();
  private readonly sampleRate: number;
  private readonly codec: WireCodec;

  constructor(
    private readonly server: FakeElevenLabsServer,
    private readonly ws: WebSocket,
    readonly voiceId: string,
    readonly params: URLSearchParams,
    readonly headers: IncomingHttpHeaders,
  ) {
    this.modelId = params.get(TTS_QUERY.modelId);
    this.outputFormat = params.get(TTS_QUERY.outputFormat) ?? 'pcm_16000';
    const parsed = parseAudioFormat(this.outputFormat);
    this.sampleRate = parsed.sampleRate;
    this.codec = parsed.codec;
    this.openedAtChunk = server.ttsChunksSent;
    ws.on('error', () => undefined);
    ws.on('message', (data) => this.onMessage(rawToString(data)));
    ws.on('close', (code) => {
      this.closeCode = code;
    });
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  /** Everything spoken on this connection, trimmed. */
  get spokenText(): string {
    return this.texts.join('').replace(/\s+/g, ' ').trim();
  }

  send(message: Record<string, unknown>): void {
    if (this.open) this.ws.send(JSON.stringify(message));
  }

  terminate(): void {
    this.ws.terminate();
  }

  close(code = 1000, reason = ''): void {
    this.ws.close(code, reason);
  }

  private onMessage(text: string): void {
    const message = JSON.parse(text) as Record<string, unknown>;
    this.messages.push(message);
    if (!this.init) {
      this.init = message;
      return;
    }
    if (message.text === '') {
      this.eosReceived = true;
      const pending = this.buffer;
      this.buffer = '';
      this.enqueue(() => this.generate(pending));
      this.enqueue(() => this.finishStream());
      return;
    }
    if (message.flush === true) {
      this.flushes += 1;
      const pending = this.buffer + (typeof message.text === 'string' && message.text.trim() ? message.text : '');
      this.buffer = '';
      this.enqueue(() => this.generate(pending));
      return;
    }
    if (typeof message.text === 'string') {
      if (message.text.trim() === '') {
        this.keepalives += 1;
        return;
      }
      this.texts.push(message.text);
      this.buffer += message.text;
    }
  }

  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch(() => undefined);
  }

  private async generate(text: string): Promise<void> {
    const clean = text.trim();
    if (!clean || !this.open) return;
    if (this.errorBeforeAudio) {
      const injected = this.errorBeforeAudio;
      this.errorBeforeAudio = null;
      this.send({ error: injected.error, message: injected.message ?? injected.error });
      if (injected.close) this.ws.close(injected.close, injected.error);
      return;
    }
    const behavior = this.server.ttsBehavior;
    const wire = encode(synthesizeSpeechSignal(clean, { sampleRate: this.sampleRate, pitchHz: this.server.pitchFor(this.voiceId) }), this.codec);
    const chunkBytes = Math.max(1, msToBytes(behavior.chunkMs ?? 40, this.sampleRate) / (this.codec === 'pcm' ? 1 : 2));
    for (let offset = 0; offset < wire.byteLength; offset += chunkBytes) {
      if (!this.open) return;
      if (this.terminateAfterChunks !== null && this.audioChunksSent >= this.terminateAfterChunks) {
        this.terminate();
        return;
      }
      this.send({ audio: pcm16ToBase64(wire.subarray(offset, Math.min(offset + chunkBytes, wire.byteLength))), isFinal: false, normalizedAlignment: null });
      this.audioChunksSent += 1;
      this.server.ttsChunksSent += 1;
      await new Promise<void>((resolve) => {
        if (behavior.paceMs) setTimeout(resolve, behavior.paceMs);
        else setImmediate(resolve);
      });
    }
  }

  private finishStream(): Promise<void> {
    if (!this.open) return Promise.resolve();
    this.send({ audio: null, isFinal: true });
    if (this.server.ttsBehavior.closeAfterFinal !== false) this.ws.close(1000);
    return Promise.resolve();
  }
}
