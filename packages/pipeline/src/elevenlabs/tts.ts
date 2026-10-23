/**
 * ElevenLabs streaming text to speech ("stream-input" WebSocket) behind `TtsProvider` / `TtsSession`.
 *
 * One session per language (one voice). Inside it, each phrase travels on its own WebSocket: text is
 * sent as soon as `speak()` is called, `flush()` sends the flush and close messages, and the server's
 * `isFinal` is the only "all audio delivered" signal we know of (`TTS_PHRASE_END_NOTE`). As soon as a
 * phrase ends, and on `prewarm()`, the next connection is pre-opened in the background, so the next
 * phrase, or a new language chosen mid-call, starts without a connection gap. Idle connections send a
 * keep-alive because the server closes silent ones after about 20 s.
 *
 * Audio comes back in the configured `output_format` and leaves this class as PCM16 16 kHz mono.
 */
import {
  WireToInternal,
  base64ToPcm16,
  normalizeLanguageCode,
  parseAudioFormat,
  type Logger,
  type PcmChunk,
  type TtsProvider,
  type TtsSession,
  type TtsSessionOptions,
  type Unsubscribe,
  type WireAudioFormat,
} from '@tw/shared';
import type { WebSocket } from 'ws';
import { Emitter } from '../util/emitter.js';
import { ElevenLabsConfigError, ElevenLabsError, MISSING_ELEVENLABS_KEY_MESSAGE, toError, transportError } from './errors.js';
import {
  ELEVENLABS_AUTH_HEADER,
  ELEVENLABS_DEFAULT_BASE_URL,
  TTS_CLOSE_MESSAGE,
  TTS_DEFAULT_CHUNK_LENGTH_SCHEDULE,
  TTS_DEFAULT_MODEL,
  TTS_DEFAULT_OUTPUT_FORMAT,
  TTS_FLUSH_MESSAGE,
  TTS_KEEPALIVE_INTERVAL_MS,
  TTS_KEEPALIVE_MESSAGE,
  buildTtsInitMessage,
  buildTtsTextMessage,
  buildTtsUrl,
  classifyTtsFailure,
  parseTtsServerMessage,
} from './protocol.js';
import { missingVoiceMessage, resolveApiKey, type ApiKeySource } from './settings.js';
import { closeSocket, defaultWebSocketFactory, openSocket, rawDataToString, sendJson, takeEarlyMessages, type WebSocketFactory } from './socket.js';

export interface ElevenLabsTtsOptions {
  /** Resolved when each session opens, so a key changed in Settings applies to the next call. */
  getApiKey: ApiKeySource;
  /** `voice_id` for a normalised language code, or null when none is configured (no defaults on purpose). */
  voiceIdFor: (lang: string) => string | null;
  baseUrl?: string;
  modelId?: string;
  outputFormat?: WireAudioFormat;
  chunkLengthSchedule?: readonly number[];
  voiceSettings?: Readonly<Record<string, unknown>>;
  /** Interval of the keep-alive on idle connections; 0 disables it. */
  keepaliveMs?: number;
  connectTimeoutMs?: number;
  /** Times a phrase is sent again on a fresh connection when the previous one failed before any audio arrived. */
  phraseRetries?: number;
  retryDelayMs?: number;
  /** Pre-open the next connection as soon as a phrase ends. */
  standby?: boolean;
  logger?: Logger;
  webSocketFactory?: WebSocketFactory;
}

interface TtsSettings {
  baseUrl: string;
  modelId: string;
  outputFormat: WireAudioFormat;
  chunkLengthSchedule: readonly number[];
  voiceSettings: Readonly<Record<string, unknown>> | undefined;
  keepaliveMs: number;
  connectTimeoutMs: number;
  phraseRetries: number;
  retryDelayMs: number;
  standby: boolean;
  logger: Logger | undefined;
  webSocketFactory: WebSocketFactory;
}

/** Real text to speech (ElevenLabs). Not simulated: sessions open WebSockets to `baseUrl`. */
export class ElevenLabsTtsProvider implements TtsProvider {
  readonly simulated = false;
  private readonly settings: TtsSettings;

  constructor(private readonly options: ElevenLabsTtsOptions) {
    this.settings = {
      baseUrl: options.baseUrl ?? ELEVENLABS_DEFAULT_BASE_URL,
      modelId: options.modelId ?? TTS_DEFAULT_MODEL,
      outputFormat: options.outputFormat ?? TTS_DEFAULT_OUTPUT_FORMAT,
      chunkLengthSchedule: options.chunkLengthSchedule ?? TTS_DEFAULT_CHUNK_LENGTH_SCHEDULE,
      voiceSettings: options.voiceSettings,
      keepaliveMs: options.keepaliveMs ?? TTS_KEEPALIVE_INTERVAL_MS,
      connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
      phraseRetries: options.phraseRetries ?? 1,
      retryDelayMs: options.retryDelayMs ?? 250,
      standby: options.standby ?? true,
      logger: options.logger,
      webSocketFactory: options.webSocketFactory ?? defaultWebSocketFactory,
    };
    parseAudioFormat(this.settings.outputFormat);
  }

  /** Resolves the voice and the key now; the WebSocket opens lazily (`prewarm()` or the first `speak()`). */
  async openSession(options: TtsSessionOptions): Promise<TtsSession> {
    const code = normalizeLanguageCode(options.lang);
    const voiceId = code ? this.options.voiceIdFor(code) : null;
    if (!voiceId) throw new ElevenLabsConfigError('tts', missingVoiceMessage(options.lang));
    const apiKey = await resolveApiKey(this.options.getApiKey);
    if (!apiKey) throw new ElevenLabsConfigError('tts', MISSING_ELEVENLABS_KEY_MESSAGE);
    const url = buildTtsUrl({ baseUrl: this.settings.baseUrl, voiceId, modelId: this.settings.modelId, outputFormat: this.settings.outputFormat });
    return new ElevenLabsTtsSession(code ?? options.lang, url, apiKey, this.settings);
  }
}

interface Connection {
  id: number;
  ws: WebSocket;
  decoder: WireToInternal;
  /** Text sent on this connection; resent on a fresh one when it fails before any audio. */
  text: string;
  eosSent: boolean;
  audioBytes: number;
  keepalive: ReturnType<typeof setInterval> | null;
  /** Phrase generation at creation; audio of an older generation (after `cancel()`) is dropped. */
  generation: number;
  finished: boolean;
  lastError: string | null;
}

export class ElevenLabsTtsSession implements TtsSession {
  readonly lang: string;
  private readonly audio = new Emitter<PcmChunk>();
  private readonly done = new Emitter<void>();
  private readonly errors = new Emitter<Error>();

  /** Connection accepting text (standby or the phrase in progress before its close message). */
  private current: Connection | null = null;
  /** Connections that got the close message and are still delivering audio. */
  private draining: Connection[] = [];
  private opening: Promise<Connection> | null = null;
  private pendingTexts: string[] = [];
  private flushRequested = false;
  private generation = 0;
  private phraseRetriesUsed = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionSeq = 0;
  private unknownLogged = false;
  private closed = false;

  constructor(
    lang: string,
    private readonly url: string,
    private readonly apiKey: string,
    private readonly settings: TtsSettings,
  ) {
    this.lang = lang;
  }

  /** Connections opened so far (diagnostics and tests). */
  get openedConnections(): number {
    return this.connectionSeq;
  }

  /** True while an open or opening connection is ready for the next phrase. */
  get hasConnection(): boolean {
    return this.current !== null || this.opening !== null;
  }

  speak(text: string): void {
    if (this.closed) return;
    const clean = text.trim();
    if (!clean) return;
    this.pendingTexts.push(clean);
    this.pump();
  }

  flush(): void {
    if (this.closed) return;
    const phraseInProgress = this.pendingTexts.length > 0 || (this.current !== null && this.current.text.length > 0);
    if (!phraseInProgress) {
      if (this.draining.length === 0) {
        queueMicrotask(() => {
          if (!this.closed) this.done.emit();
        });
      }
      return;
    }
    this.flushRequested = true;
    this.pump();
  }

  cancel(): void {
    this.generation += 1;
    this.pendingTexts = [];
    this.flushRequested = false;
    this.phraseRetriesUsed = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const connections = [...this.draining, ...(this.current ? [this.current] : [])];
    this.draining = [];
    this.current = null;
    for (const connection of connections) void this.discard(connection, true);
  }

  async prewarm(): Promise<void> {
    if (this.closed) return;
    await this.ensureConnection();
  }

  onAudio(handler: (pcm: PcmChunk) => void): Unsubscribe {
    return this.audio.on(handler);
  }

  onDone(handler: () => void): Unsubscribe {
    return this.done.on(handler);
  }

  onError(handler: (error: Error) => void): Unsubscribe {
    return this.errors.on(handler);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.pendingTexts = [];
    this.flushRequested = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const connections = [...this.draining, ...(this.current ? [this.current] : [])];
    this.draining = [];
    this.current = null;
    await Promise.all(connections.map((connection) => this.discard(connection, false)));
    if (this.opening) {
      try {
        await this.discard(await this.opening, false);
      } catch {
        // The opener already reported the failure to whoever asked for the connection.
      }
    }
    this.audio.clear();
    this.done.clear();
    this.errors.clear();
  }

  // ---------------------------------------------------------------------------

  private pump(): void {
    if (this.closed) return;
    if (this.pendingTexts.length === 0 && !this.flushRequested) return;
    const connection = this.current;
    if (!connection) {
      // The opener itself pumps once the connection is up (or reports the failure exactly once).
      this.ensureConnection().catch(() => undefined);
      return;
    }
    this.stopKeepalive(connection);
    for (const text of this.pendingTexts.splice(0)) {
      connection.text = connection.text ? `${connection.text} ${text}` : text;
      sendJson(connection.ws, buildTtsTextMessage(text));
    }
    if (this.flushRequested) {
      this.flushRequested = false;
      sendJson(connection.ws, TTS_FLUSH_MESSAGE);
      sendJson(connection.ws, TTS_CLOSE_MESSAGE);
      connection.eosSent = true;
      this.current = null;
      this.draining.push(connection);
    }
  }

  private ensureConnection(): Promise<Connection> {
    if (this.current) return Promise.resolve(this.current);
    if (!this.opening) {
      const opening = this.open().finally(() => {
        if (this.opening === opening) this.opening = null;
      });
      this.opening = opening;
      // One continuation per attempt, however many speak()/flush()/prewarm() calls wait on it.
      opening.then(
        () => this.pump(),
        (error: unknown) => this.handleOpenFailure(error),
      );
    }
    return this.opening;
  }

  private async open(): Promise<Connection> {
    const ws = await openSocket(this.settings.webSocketFactory, 'tts', this.url, {
      headers: { [ELEVENLABS_AUTH_HEADER]: this.apiKey },
      handshakeTimeoutMs: this.settings.connectTimeoutMs,
    });
    if (this.closed) {
      await closeSocket(ws, 200);
      throw new ElevenLabsError('tts', 'session', 'La sesión de voz ya estaba cerrada.', { recoverable: false });
    }
    const connection: Connection = {
      id: ++this.connectionSeq,
      ws,
      decoder: new WireToInternal(this.settings.outputFormat),
      text: '',
      eosSent: false,
      audioBytes: 0,
      keepalive: null,
      generation: this.generation,
      finished: false,
      lastError: null,
    };
    ws.on('message', (data) => this.handleMessage(connection, rawDataToString(data)));
    ws.on('error', (error: Error) => {
      connection.lastError = error.message;
    });
    ws.on('close', (code, reason) => this.handleClose(connection, code, rawDataToString(reason)));
    for (const data of takeEarlyMessages(ws)) this.handleMessage(connection, rawDataToString(data));
    sendJson(ws, buildTtsInitMessage({ voiceSettings: this.settings.voiceSettings, chunkLengthSchedule: this.settings.chunkLengthSchedule }));
    this.current = connection;
    this.startKeepalive(connection);
    return connection;
  }

  private handleMessage(connection: Connection, text: string): void {
    if (connection.finished) return;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      this.settings.logger?.warn('Mensaje no JSON de la voz de ElevenLabs', { bytes: text.length });
      return;
    }
    const event = parseTtsServerMessage(data);
    switch (event.kind) {
      case 'audio': {
        if (event.audioBase64) {
          let bytes: Uint8Array;
          try {
            bytes = base64ToPcm16(event.audioBase64);
          } catch {
            this.failConnection(connection, new ElevenLabsError('tts', 'protocol', 'La voz de ElevenLabs envió audio que no se pudo decodificar.'));
            return;
          }
          connection.audioBytes += bytes.byteLength;
          const pcm = connection.decoder.push(bytes);
          if (pcm.byteLength > 0 && connection.generation === this.generation && !this.closed) this.audio.emit(pcm);
        }
        if (event.isFinal) this.finish(connection);
        return;
      }
      case 'final':
        this.finish(connection);
        return;
      case 'error':
        this.failConnection(connection, this.errorFor(event.code, event.message));
        return;
      case 'unknown':
        if (!this.unknownLogged) {
          this.unknownLogged = true;
          this.settings.logger?.warn('Mensaje desconocido de la voz de ElevenLabs (se ignora; revisa protocol.ts)', { sample: text.slice(0, 300) });
        }
        return;
    }
  }

  private errorFor(code: string | number | null, message: string): ElevenLabsError {
    const detail = code !== null && String(code) !== message ? `${code}: ${message}` : message;
    switch (classifyTtsFailure({ code, message })) {
      case 'auth':
        return new ElevenLabsError('tts', 'auth', `ElevenLabs rechazó la clave de API al sintetizar voz (${detail}). Revisa ELEVENLABS_API_KEY en Ajustes.`, { code });
      case 'quota':
        return new ElevenLabsError('tts', 'quota', `La cuenta de ElevenLabs no tiene cuota para sintetizar voz (${detail}).`, { code });
      case 'rate_limited':
        return new ElevenLabsError('tts', 'rate_limited', `ElevenLabs está limitando las peticiones de voz (${detail}); se reintentará.`, { code });
      case 'config':
        return new ElevenLabsConfigError('tts', `ElevenLabs rechazó la configuración de la voz (${detail}): revisa el voice_id, el modelo y el formato de salida.`, { code });
      case 'session':
        return new ElevenLabsError('tts', 'session', `La voz de ElevenLabs falló (${detail}).`, { code, recoverable: true });
    }
  }

  private finish(connection: Connection): void {
    if (connection.finished) return;
    connection.finished = true;
    this.stopKeepalive(connection);
    this.detach(connection);
    void closeSocket(connection.ws, 300);
    this.afterPhrase(connection);
  }

  private afterPhrase(connection: Connection): void {
    if (this.closed || connection.generation !== this.generation) return;
    if (!connection.eosSent) {
      this.settings.logger?.debug('ElevenLabs terminó una conexión de voz en espera', { id: connection.id });
      return;
    }
    this.phraseRetriesUsed = 0;
    this.done.emit();
    if (this.settings.standby && !this.closed && this.pendingTexts.length === 0) {
      this.ensureConnection().catch((error: unknown) =>
        this.settings.logger?.debug('No se pudo preparar la siguiente conexión de voz', { error: toError(error).message }),
      );
    }
  }

  private handleClose(connection: Connection, code: number, reason: string): void {
    if (connection.finished) return;
    connection.finished = true;
    this.stopKeepalive(connection);
    this.detach(connection);
    if (this.closed || connection.generation !== this.generation) return;
    const clean = code === 1000 || code === 1005;
    if (connection.eosSent && clean && (connection.audioBytes > 0 || connection.text.length === 0)) {
      // Clean end without an explicit `isFinal`: everything generated was delivered before the close.
      this.afterPhrase(connection);
      return;
    }
    if (!connection.text) {
      this.settings.logger?.debug('Conexión de voz en espera cerrada por el servidor', { code });
      return;
    }
    const detail = reason || connection.lastError || `código ${code}`;
    const kind = classifyTtsFailure({ code, message: reason });
    const failure =
      kind === 'auth' || kind === 'quota'
        ? this.errorFor(code, reason || `cierre ${code}`)
        : clean
          ? new ElevenLabsError('tts', 'session', `La voz de ElevenLabs cerró la conexión sin enviar audio (${detail}).`, { code, recoverable: true })
          : new ElevenLabsError('tts', 'transport', `La conexión de voz de ElevenLabs se cerró (${detail}).`, { code, recoverable: true });
    this.failConnection(connection, failure, true);
  }

  private failConnection(connection: Connection, error: ElevenLabsError, alreadyClosed = false): void {
    if (!connection.finished) {
      connection.finished = true;
      this.stopKeepalive(connection);
      this.detach(connection);
    }
    if (!alreadyClosed) void closeSocket(connection.ws, 200);
    if (this.closed || connection.generation !== this.generation) return;
    if (!connection.text) {
      this.settings.logger?.debug('Falló una conexión de voz en espera; se abrirá otra cuando haga falta', { error: error.message });
      return;
    }
    const canRetry = error.recoverable && connection.audioBytes === 0 && this.phraseRetriesUsed < this.settings.phraseRetries;
    if (canRetry) {
      this.phraseRetriesUsed += 1;
      this.settings.logger?.warn('La voz de ElevenLabs falló antes de enviar audio; se reintenta la frase', { attempt: this.phraseRetriesUsed, reason: error.message });
      this.pendingTexts.unshift(connection.text);
      if (connection.eosSent) this.flushRequested = true;
      this.retryLater();
      return;
    }
    this.phraseRetriesUsed = 0;
    this.pendingTexts = [];
    this.flushRequested = false;
    this.settings.logger?.error('La voz de ElevenLabs falló', { kind: error.kind, code: error.code, message: error.message, audioBytes: connection.audioBytes });
    this.errors.emit(error);
  }

  private handleOpenFailure(error: unknown): void {
    if (this.closed) return;
    const failure = error instanceof ElevenLabsError ? error : transportError('tts', toError(error).message, error);
    if (this.pendingTexts.length === 0 && !this.flushRequested) return;
    if (failure.recoverable && this.phraseRetriesUsed < this.settings.phraseRetries) {
      this.phraseRetriesUsed += 1;
      this.settings.logger?.warn('No se pudo abrir la voz de ElevenLabs; se reintenta', { attempt: this.phraseRetriesUsed, reason: failure.message });
      this.retryLater();
      return;
    }
    this.phraseRetriesUsed = 0;
    this.pendingTexts = [];
    this.flushRequested = false;
    this.settings.logger?.error('No se pudo abrir la voz de ElevenLabs', { kind: failure.kind, code: failure.code, message: failure.message });
    this.errors.emit(failure);
  }

  private retryLater(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.pump();
    }, this.settings.retryDelayMs);
  }

  private discard(connection: Connection, abrupt: boolean): Promise<void> {
    connection.finished = true;
    this.stopKeepalive(connection);
    if (abrupt) {
      connection.ws.terminate();
      return Promise.resolve();
    }
    return closeSocket(connection.ws, 300);
  }

  private detach(connection: Connection): void {
    if (this.current === connection) this.current = null;
    this.draining = this.draining.filter((item) => item !== connection);
  }

  private startKeepalive(connection: Connection): void {
    if (connection.keepalive || this.settings.keepaliveMs <= 0) return;
    connection.keepalive = setInterval(() => {
      if (connection.finished || connection.text) {
        this.stopKeepalive(connection);
        return;
      }
      sendJson(connection.ws, TTS_KEEPALIVE_MESSAGE);
    }, this.settings.keepaliveMs);
    connection.keepalive.unref();
  }

  private stopKeepalive(connection: Connection): void {
    if (!connection.keepalive) return;
    clearInterval(connection.keepalive);
    connection.keepalive = null;
  }
}
