/**
 * ElevenLabs Scribe v2 Realtime client behind `SttProvider` / `SttSession`.
 *
 * Audio enters as PCM16 16 kHz, is converted to the configured wire format and sent as base64 JSON
 * messages. Every chunk is kept until the server commits a transcript, so when the connection drops
 * mid-call the session reopens and replays what was not yet confirmed (bounded by `maxUnconfirmedMs`).
 * Protocol names live in `protocol.ts` (UNVERIFIED); this file only decides what to do with them.
 */
import {
  InternalToWire,
  normalizeLanguageCode,
  parseAudioFormat,
  pcm16Rms,
  pcm16ToBase64,
  pcmDurationMs,
  type Logger,
  type PcmChunk,
  type SttFinal,
  type SttPartial,
  type SttProvider,
  type SttSession,
  type SttSessionOptions,
  type Unsubscribe,
  type WireAudioFormat,
} from '@tw/shared';
import type { WebSocket } from 'ws';
import { Emitter } from '../util/emitter.js';
import { ElevenLabsConfigError, ElevenLabsError, MISSING_ELEVENLABS_KEY_MESSAGE, sttErrorFromType, toError, transportError } from './errors.js';
import {
  ELEVENLABS_AUTH_HEADER,
  ELEVENLABS_DEFAULT_BASE_URL,
  STT_DEFAULT_AUDIO_FORMAT,
  STT_DEFAULT_COMMIT_STRATEGY,
  STT_DEFAULT_MODEL,
  buildSttAudioMessage,
  buildSttUrl,
  parseSttServerMessage,
  type SttCommitStrategy,
  type SttServerEvent,
} from './protocol.js';
import { resolveApiKey, type ApiKeySource } from './settings.js';
import { closeSocket, defaultWebSocketFactory, describeUrl, openSocket, rawDataToString, sendJson, takeEarlyMessages, type WebSocketFactory } from './socket.js';

export interface ElevenLabsSttOptions {
  /** Resolved when each session opens, so a key changed in Settings applies to the next call. */
  getApiKey: ApiKeySource;
  baseUrl?: string;
  modelId?: string;
  audioFormat?: WireAudioFormat;
  commitStrategy?: SttCommitStrategy;
  vadSilenceSeconds?: number | null;
  includeTimestamps?: boolean;
  /** Reconnections allowed in a row; the counter resets after each committed transcript. */
  maxReconnects?: number;
  reconnectDelayMs?: number;
  /** Pause before reconnecting after `rate_limited`. */
  rateLimitDelayMs?: number;
  /** Audio kept for replay after a reconnection; older audio is dropped. */
  maxUnconfirmedMs?: number;
  connectTimeoutMs?: number;
  /** Chunks quieter than this RMS (0..1) do not start the clock of an utterance. */
  voicedRms?: number;
  /** A committed transcript identical to the previous one within this window is a duplicate (timestamps variant). */
  duplicateWindowMs?: number;
  logger?: Logger;
  webSocketFactory?: WebSocketFactory;
  now?: () => number;
}

interface SttSettings {
  baseUrl: string;
  modelId: string;
  audioFormat: WireAudioFormat;
  commitStrategy: SttCommitStrategy;
  vadSilenceSeconds: number | null;
  includeTimestamps: boolean;
  maxReconnects: number;
  reconnectDelayMs: number;
  rateLimitDelayMs: number;
  maxUnconfirmedMs: number;
  connectTimeoutMs: number;
  voicedRms: number;
  duplicateWindowMs: number;
  logger: Logger | undefined;
  webSocketFactory: WebSocketFactory;
  now: () => number;
}

/** Real speech to text (ElevenLabs). Not simulated: every session opens a WebSocket to `baseUrl`. */
export class ElevenLabsSttProvider implements SttProvider {
  readonly simulated = false;
  private readonly settings: SttSettings;

  constructor(private readonly options: ElevenLabsSttOptions) {
    this.settings = {
      baseUrl: options.baseUrl ?? ELEVENLABS_DEFAULT_BASE_URL,
      modelId: options.modelId ?? STT_DEFAULT_MODEL,
      audioFormat: options.audioFormat ?? STT_DEFAULT_AUDIO_FORMAT,
      commitStrategy: options.commitStrategy ?? STT_DEFAULT_COMMIT_STRATEGY,
      vadSilenceSeconds: options.vadSilenceSeconds ?? null,
      includeTimestamps: options.includeTimestamps ?? false,
      maxReconnects: options.maxReconnects ?? 3,
      reconnectDelayMs: options.reconnectDelayMs ?? 300,
      rateLimitDelayMs: options.rateLimitDelayMs ?? 1500,
      maxUnconfirmedMs: options.maxUnconfirmedMs ?? 15_000,
      connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
      voicedRms: options.voicedRms ?? 0.004,
      duplicateWindowMs: options.duplicateWindowMs ?? 1500,
      logger: options.logger,
      webSocketFactory: options.webSocketFactory ?? defaultWebSocketFactory,
      now: options.now ?? (() => Date.now()),
    };
    parseAudioFormat(this.settings.audioFormat);
  }

  async openSession(options: SttSessionOptions): Promise<SttSession> {
    const apiKey = await resolveApiKey(this.options.getApiKey);
    if (!apiKey) throw new ElevenLabsConfigError('stt', MISSING_ELEVENLABS_KEY_MESSAGE);
    const lang = options.lang ? (normalizeLanguageCode(options.lang) ?? options.lang) : undefined;
    const url = buildSttUrl({
      baseUrl: this.settings.baseUrl,
      modelId: this.settings.modelId,
      audioFormat: this.settings.audioFormat,
      commitStrategy: this.settings.commitStrategy,
      lang,
      includeTimestamps: this.settings.includeTimestamps,
      vadSilenceSeconds: this.settings.vadSilenceSeconds,
    });
    const session = new ElevenLabsSttSession(url, apiKey, this.settings);
    await session.connect();
    return session;
  }
}

interface RetainedChunk {
  audioBase64: string;
  ms: number;
}

export class ElevenLabsSttSession implements SttSession {
  private readonly partials = new Emitter<SttPartial>();
  private readonly finals = new Emitter<SttFinal>();
  private readonly errors = new Emitter<Error>();
  private readonly wire: InternalToWire | null;
  private readonly sampleRate: number;

  private ws: WebSocket | null = null;
  private clockMs = 0;
  private voicedStartMs: number | null = null;
  private lastFinalEndMs = 0;
  private unconfirmed: RetainedChunk[] = [];
  private unconfirmedMs = 0;
  private pendingCommit = false;
  private reconnects = 0;
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFinal: { text: string; at: number } | null = null;
  private lastSocketError: string | null = null;
  private unknownLogged = false;
  private closed = false;
  private dead = false;

  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly settings: SttSettings,
  ) {
    this.sampleRate = parseAudioFormat(settings.audioFormat).sampleRate;
    this.wire = settings.audioFormat === 'pcm_16000' ? null : new InternalToWire(settings.audioFormat);
  }

  /** Milliseconds of audio received so far (for tests and diagnostics). */
  get audioClockMs(): number {
    return this.clockMs;
  }

  /** Reconnections performed so far in the current run. */
  get reconnectCount(): number {
    return this.reconnects;
  }

  async connect(): Promise<void> {
    const ws = await this.openSocket();
    if (this.closed) {
      await closeSocket(ws);
      return;
    }
    this.attach(ws);
  }

  sendAudio(pcm: PcmChunk): void {
    if (this.closed || this.dead) return;
    if (this.voicedStartMs === null && pcm16Rms(pcm) >= this.settings.voicedRms) this.voicedStartMs = this.clockMs;
    const ms = pcmDurationMs(pcm);
    this.clockMs += ms;
    const bytes = this.wire ? this.wire.push(pcm) : pcm;
    if (bytes.byteLength === 0) return;
    const audioBase64 = pcm16ToBase64(bytes);
    this.retain({ audioBase64, ms });
    sendJson(this.ws, buildSttAudioMessage(audioBase64, false, this.sampleRate));
  }

  commit(): void {
    if (this.closed || this.dead) return;
    if (!sendJson(this.ws, buildSttAudioMessage('', true, this.sampleRate))) this.pendingCommit = true;
  }

  onPartial(handler: (partial: SttPartial) => void): Unsubscribe {
    return this.partials.on(handler);
  }

  onFinal(handler: (final: SttFinal) => void): Unsubscribe {
    return this.finals.on(handler);
  }

  onError(handler: (error: Error) => void): Unsubscribe {
    return this.errors.on(handler);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) await closeSocket(ws);
    this.unconfirmed = [];
    this.unconfirmedMs = 0;
    this.partials.clear();
    this.finals.clear();
    this.errors.clear();
  }

  // ---------------------------------------------------------------------------

  private openSocket(): Promise<WebSocket> {
    return openSocket(this.settings.webSocketFactory, 'stt', this.url, {
      headers: { [ELEVENLABS_AUTH_HEADER]: this.apiKey },
      handshakeTimeoutMs: this.settings.connectTimeoutMs,
    });
  }

  private attach(ws: WebSocket): void {
    this.ws = ws;
    this.lastSocketError = null;
    ws.on('message', (data) => {
      if (ws === this.ws) this.handleMessage(rawDataToString(data));
    });
    ws.on('error', (error: Error) => {
      if (ws === this.ws) this.lastSocketError = error.message;
    });
    ws.on('close', (code, reason) => this.handleClose(ws, code, rawDataToString(reason)));
    for (const data of takeEarlyMessages(ws)) {
      if (ws === this.ws) this.handleMessage(rawDataToString(data));
    }
  }

  private retain(chunk: RetainedChunk): void {
    this.unconfirmed.push(chunk);
    this.unconfirmedMs += chunk.ms;
    while (this.unconfirmedMs > this.settings.maxUnconfirmedMs && this.unconfirmed.length > 1) {
      this.unconfirmedMs -= this.unconfirmed.shift()!.ms;
    }
  }

  private handleMessage(text: string): void {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      this.settings.logger?.warn('Mensaje no JSON de la transcripción de ElevenLabs', { bytes: text.length });
      return;
    }
    const event = parseSttServerMessage(data);
    switch (event.kind) {
      case 'session_started':
        this.settings.logger?.debug('Sesión de transcripción de ElevenLabs iniciada', { sessionId: event.sessionId, url: describeUrl(this.url) });
        return;
      case 'partial': {
        const partialText = event.text.trim();
        if (partialText) this.partials.emit(event.lang ? { text: partialText, lang: event.lang } : { text: partialText });
        return;
      }
      case 'committed':
        this.handleCommitted(event);
        return;
      case 'error':
        this.handleProviderError(event);
        return;
      case 'unknown':
        if (!this.unknownLogged) {
          this.unknownLogged = true;
          this.settings.logger?.warn('Mensaje desconocido de la transcripción de ElevenLabs (se ignora; revisa protocol.ts)', { type: event.type, sample: text.slice(0, 300) });
        } else {
          this.settings.logger?.debug('Otro mensaje desconocido de la transcripción de ElevenLabs', { type: event.type });
        }
        return;
    }
  }

  private handleCommitted(event: Extract<SttServerEvent, { kind: 'committed' }>): void {
    const text = event.text.trim();
    const now = this.settings.now();
    if (text && this.lastFinal && this.lastFinal.text === text && now - this.lastFinal.at <= this.settings.duplicateWindowMs) {
      this.settings.logger?.debug('Transcripción confirmada repetida (variante con marcas de tiempo); se ignora');
      return;
    }
    const startMs = event.startMs ?? this.voicedStartMs ?? this.lastFinalEndMs;
    const endMs = Math.max(startMs, event.endMs ?? this.clockMs);
    this.lastFinalEndMs = endMs;
    this.voicedStartMs = null;
    this.unconfirmed = [];
    this.unconfirmedMs = 0;
    this.reconnects = 0;
    if (!text) return;
    this.lastFinal = { text, at: now };
    const final: SttFinal = { text, startMs, endMs };
    if (event.lang) final.lang = event.lang;
    if (event.probability !== null) final.langProbability = event.probability;
    this.finals.emit(final);
  }

  private handleProviderError(event: Extract<SttServerEvent, { kind: 'error' }>): void {
    const error = sttErrorFromType(event.type, event.message, event.policy);
    switch (event.policy) {
      case 'ignore':
        this.settings.logger?.debug('Aviso de la transcripción de ElevenLabs (sin efecto)', { type: event.type, message: event.message });
        return;
      case 'fatal':
        this.fail(error);
        return;
      case 'reconnect': {
        const ws = this.ws;
        this.ws = null;
        if (ws) void closeSocket(ws, 200);
        this.scheduleReconnect(error, event.type === 'rate_limited' ? this.settings.rateLimitDelayMs : this.settings.reconnectDelayMs);
        return;
      }
    }
  }

  private handleClose(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.ws) return;
    this.ws = null;
    if (this.closed || this.dead) return;
    const detail = reason || this.lastSocketError || `código ${code}`;
    this.scheduleReconnect(transportError('stt', `la conexión se cerró (${detail})`), this.settings.reconnectDelayMs);
  }

  private scheduleReconnect(cause: ElevenLabsError, delayMs: number): void {
    if (this.closed || this.dead || this.reconnecting) return;
    if (this.reconnects >= this.settings.maxReconnects) {
      this.fail(
        new ElevenLabsError('stt', 'transport', `Se perdió la transcripción de ElevenLabs y no se recuperó tras ${this.reconnects} reintentos: ${cause.message}`, {
          code: cause.code,
          recoverable: true,
          cause,
        }),
      );
      return;
    }
    this.reconnects += 1;
    this.reconnecting = true;
    this.settings.logger?.warn('Transcripción de ElevenLabs interrumpida; reconectando', {
      attempt: this.reconnects,
      reason: cause.message,
      unconfirmedMs: Math.round(this.unconfirmedMs),
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delayMs * this.reconnects);
  }

  private async reconnect(): Promise<void> {
    try {
      const ws = await this.openSocket();
      if (this.closed) {
        await closeSocket(ws);
        return;
      }
      this.attach(ws);
      this.reconnecting = false;
      for (const chunk of this.unconfirmed) sendJson(ws, buildSttAudioMessage(chunk.audioBase64, false, this.sampleRate));
      if (this.pendingCommit) {
        this.pendingCommit = false;
        sendJson(ws, buildSttAudioMessage('', true, this.sampleRate));
      }
      this.settings.logger?.info('Transcripción de ElevenLabs reconectada', { replayedMs: Math.round(this.unconfirmedMs) });
    } catch (error) {
      this.reconnecting = false;
      const failure = error instanceof ElevenLabsError ? error : transportError('stt', toError(error).message, error);
      if (!failure.recoverable) {
        this.fail(failure);
        return;
      }
      this.scheduleReconnect(failure, failure.kind === 'rate_limited' ? this.settings.rateLimitDelayMs : this.settings.reconnectDelayMs);
    }
  }

  private fail(error: ElevenLabsError): void {
    if (this.closed || this.dead) return;
    this.dead = true;
    const ws = this.ws;
    this.ws = null;
    if (ws) void closeSocket(ws, 200);
    this.settings.logger?.error('La transcripción de ElevenLabs falló', { kind: error.kind, code: error.code, message: error.message });
    this.errors.emit(error);
  }
}
