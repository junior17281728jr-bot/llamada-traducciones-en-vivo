/**
 * One translated direction of a call: audio in -> STT -> translation -> TTS -> audio out.
 *
 * - Segments are translated in order and spoken one after another, so the translated voice never
 *   overlaps and the output is a single continuous stream.
 * - Language settings are captured when a phrase is finalised: a change made later only affects the
 *   phrases that follow. A phrase already being translated or spoken finishes in its own language and
 *   the audio that is playing is never cut. The voice for the new language is warmed up in the
 *   background beforehand.
 * - `operator_to_passenger` holds the operator's text (up to `holdMs`) until the passenger's language
 *   is usable, then falls back to a configured language and warns the operator.
 */
import {
  normalizeLanguageCode,
  pcm16Rms,
  pcmDurationMs,
  speakerOfDirection,
  type DirectionPipeline,
  type DirectionPipelineConfig,
  type LanguageCode,
  type LanguageNotice,
  type LanguageSettings,
  type LanguageState,
  type LanguageStateEvent,
  type LatencySummary,
  type Logger,
  type PcmChunk,
  type PipelineDirection,
  type PipelineMetrics,
  type PipelineStage,
  type PipelineStageEvent,
  type SttPartial,
  type SttProvider,
  type SttSession,
  type TextTranslator,
  type TranscriptSegment,
  type TranslationContextTurn,
  type TtsProvider,
  type TtsSession,
  type Unsubscribe,
  UNKNOWN_LANGUAGE_STATE,
} from '@tw/shared';
import { heardLanguageFor, LanguageController, type LanguageControllerConfig } from './language/controller.js';
import { Emitter } from './util/emitter.js';

export interface DirectionPipelineProviders {
  stt: SttProvider;
  translator: TextTranslator;
  tts: TtsProvider;
}

export interface DirectionPipelineOptions {
  /** Longest the operator's text waits for the passenger's language before using the fallback. */
  holdMs: number;
  /** Final transcripts shorter than this are noise and are dropped. */
  minSegmentChars: number;
  /** Earlier phrases of this direction passed to the translator as context. */
  contextTurns: number;
  /** Input chunks quieter than this RMS (0..1) are not "receiving voice". */
  receivingRms: number;
  receivingHangoverMs: number;
  /** Audio kept while the STT connects or reconnects; the oldest audio is dropped beyond this. */
  maxBufferedMs: number;
  sttRetries: number;
  sttRetryDelayMs: number;
  /** How long the `error` stage stays visible. */
  errorDisplayMs: number;
  /** Do not translate a phrase that is already in the target language. */
  skipSameLanguage: boolean;
  controller: Partial<LanguageControllerConfig>;
  now: () => number;
  logger?: Logger;
}

export const DEFAULT_DIRECTION_PIPELINE_OPTIONS: DirectionPipelineOptions = {
  holdMs: 4000,
  minSegmentChars: 2,
  contextTurns: 6,
  receivingRms: 0.004,
  receivingHangoverMs: 400,
  maxBufferedMs: 10_000,
  sttRetries: 3,
  sttRetryDelayMs: 300,
  errorDisplayMs: 3000,
  skipSameLanguage: true,
  controller: {},
  now: () => Date.now(),
};

interface Job {
  id: string;
  text: string;
  sttLang: LanguageCode | null;
  sttProbability: number | null;
  startMs: number;
  endMs: number;
  /** Settings in force when the phrase was finalised. */
  settings: LanguageSettings;
  finalAt: number;
  context: TranslationContextTurn[];
  translateMs: number | null;
}

interface Waiter {
  check: () => void;
  cancel: () => void;
}

const toError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));

export class TranslationDirectionPipeline implements DirectionPipeline {
  readonly direction: PipelineDirection;

  private readonly callId: string;
  private readonly options: DirectionPipelineOptions;
  private readonly controller: LanguageController;
  private readonly createdAt: number;
  private readonly speaker: 'operator' | 'passenger';

  private readonly segments = new Emitter<TranscriptSegment>();
  private readonly stages = new Emitter<PipelineStageEvent>();
  private readonly languageStates = new Emitter<LanguageStateEvent>();
  private readonly audio = new Emitter<PcmChunk>();
  private readonly errors = new Emitter<Error>();

  private settings: LanguageSettings;
  /** What the passenger-side detection reports (mirrored from the other direction for `operator_to_passenger`). */
  private passengerState: LanguageState = UNKNOWN_LANGUAGE_STATE;

  private stt: SttSession | null = null;
  private sttLang: LanguageCode | undefined;
  private sttOffsetMs = 0;
  private sttOpening: Promise<void> | null = null;
  private reopening = false;
  private pending: PcmChunk[] = [];
  private pendingMs = 0;

  private currentSegmentId: string | null = null;
  private partialStartMs: number | null = null;
  private segmentSeq = 0;
  private recent: TranslationContextTurn[] = [];

  private translateChain: Promise<void> = Promise.resolve();
  private speechChain: Promise<void> = Promise.resolve();
  private readonly ttsSessions = new Map<string, Promise<TtsSession>>();
  private readonly waiters = new Set<Waiter>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  private receiving = false;
  private receivingTimer: ReturnType<typeof setTimeout> | null = null;
  private transcribing = false;
  private speaking = false;
  private inflight = 0;
  private awaitingAudio = 0;
  private errorUntil = 0;
  private errorDetail: string | undefined;
  private lastStage: PipelineStage = 'idle';

  private readonly latencies: LatencySummary[] = [];
  private closed = false;
  private readonly closedSignal: Promise<void>;
  private signalClosed!: () => void;

  constructor(
    config: DirectionPipelineConfig,
    private readonly providers: DirectionPipelineProviders,
    options: Partial<DirectionPipelineOptions> = {},
  ) {
    this.options = { ...DEFAULT_DIRECTION_PIPELINE_OPTIONS, ...options };
    this.direction = config.direction;
    this.callId = config.callId;
    this.speaker = speakerOfDirection(config.direction);
    this.settings = config.settings;
    this.createdAt = this.options.now();
    this.controller = new LanguageController(config.settings, { ...this.options.controller, now: this.options.now });
    this.closedSignal = new Promise<void>((resolve) => {
      this.signalClosed = resolve;
    });
    if (config.langHint && this.direction === 'passenger_to_operator') {
      this.controller.setHint(config.langHint);
    }
    this.passengerState = this.controller.getState();
  }

  // ---------------------------------------------------------------------------
  // DirectionPipeline
  // ---------------------------------------------------------------------------

  pushAudio(pcm: PcmChunk): void {
    if (this.closed) return;
    this.trackReceiving(pcm);
    if (this.stt) {
      this.stt.sendAudio(pcm);
      return;
    }
    this.bufferAudio(pcm);
    void this.ensureStt();
  }

  onSegment(handler: (segment: TranscriptSegment) => void): Unsubscribe {
    return this.segments.on(handler);
  }

  onStage(handler: (event: PipelineStageEvent) => void): Unsubscribe {
    return this.stages.on(handler);
  }

  onLanguageState(handler: (event: LanguageStateEvent) => void): Unsubscribe {
    return this.languageStates.on(handler);
  }

  onAudio(handler: (pcm: PcmChunk) => void): Unsubscribe {
    return this.audio.on(handler);
  }

  onError(handler: (error: Error) => void): Unsubscribe {
    return this.errors.on(handler);
  }

  applyLanguageSettings(settings: LanguageSettings): void {
    if (this.closed) return;
    this.settings = settings;
    const update = this.controller.applySettings(settings);
    if (this.direction === 'passenger_to_operator') {
      this.passengerState = this.controller.getState();
      if (update.changed) this.emitLanguageState(this.passengerState, null);
    }
    this.prewarmTargets();
    this.maybeReopenStt();
    this.releaseHold();
  }

  setPassengerLanguageState(state: LanguageState): void {
    if (this.closed) return;
    this.passengerState = state;
    this.controller.adoptState(state);
    this.prewarmTargets();
    this.releaseHold();
  }

  getMetrics(): PipelineMetrics {
    const list = this.latencies;
    const mean = (pick: (item: LatencySummary) => number | null): number | null => {
      const values = list.map(pick).filter((value): value is number => value !== null);
      return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
    };
    const totals = list
      .map((item) => item.totalMs)
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    const p95 = totals.length === 0 ? null : totals[Math.min(totals.length - 1, Math.ceil(totals.length * 0.95) - 1)]!;
    return {
      segments: list.length,
      last: list.length === 0 ? null : list[list.length - 1]!,
      average: {
        sttMs: mean((item) => item.sttMs),
        translateMs: mean((item) => item.translateMs),
        ttsFirstByteMs: mean((item) => item.ttsFirstByteMs),
        totalMs: mean((item) => item.totalMs),
      },
      p95TotalMs: p95,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.signalClosed();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.receivingTimer) clearTimeout(this.receivingTimer);
    for (const waiter of [...this.waiters]) waiter.cancel();
    const closing: Promise<unknown>[] = [];
    if (this.stt) closing.push(this.stt.close());
    for (const sessionPromise of this.ttsSessions.values()) {
      closing.push(
        sessionPromise.then(async (session) => {
          session.cancel();
          await session.close();
        }),
      );
    }
    await Promise.allSettled(closing);
    this.stt = null;
    this.ttsSessions.clear();
    this.segments.clear();
    this.stages.clear();
    this.languageStates.clear();
    this.audio.clear();
    this.errors.clear();
  }

  // ---------------------------------------------------------------------------
  // Speech to text
  // ---------------------------------------------------------------------------

  private desiredSttLang(): LanguageCode | undefined {
    if (this.direction === 'operator_to_passenger') return this.settings.operatorLang;
    return this.settings.passengerSpeaks.mode === 'fixed' ? this.settings.passengerSpeaks.lang : undefined;
  }

  private bufferAudio(pcm: PcmChunk): void {
    this.pending.push(pcm);
    this.pendingMs += pcmDurationMs(pcm);
    while (this.pendingMs > this.options.maxBufferedMs && this.pending.length > 1) {
      this.pendingMs -= pcmDurationMs(this.pending.shift()!);
    }
  }

  private ensureStt(): Promise<void> {
    if (this.stt || this.closed) return Promise.resolve();
    this.sttOpening ??= this.connectStt().finally(() => {
      this.sttOpening = null;
    });
    return this.sttOpening;
  }

  private async connectStt(): Promise<void> {
    const lang = this.desiredSttLang();
    for (let attempt = 0; ; attempt++) {
      try {
        const session = await this.providers.stt.openSession(lang ? { lang } : {});
        if (this.closed) {
          await session.close();
          return;
        }
        this.attachStt(session, lang);
        return;
      } catch (error) {
        this.reportError(toError(error), 'No se pudo conectar la transcripción');
        if (attempt >= this.options.sttRetries || this.closed) return;
        await this.sleep(this.options.sttRetryDelayMs * (attempt + 1));
        if (this.closed) return;
      }
    }
  }

  private attachStt(session: SttSession, lang: LanguageCode | undefined): void {
    this.stt = session;
    this.sttLang = lang;
    this.sttOffsetMs = this.options.now() - this.createdAt;
    session.onPartial((partial) => this.onSttPartial(session, partial));
    session.onFinal((final) => this.onSttFinal(session, final));
    session.onError((error) => this.onSttError(session, error));
    const buffered = this.pending;
    this.pending = [];
    this.pendingMs = 0;
    for (const chunk of buffered) session.sendAudio(chunk);
  }

  private onSttPartial(session: SttSession, partial: SttPartial): void {
    if (session !== this.stt || this.closed) return;
    const text = partial.text.trim();
    if (!text) return;
    const elapsed = this.options.now() - this.createdAt;
    this.currentSegmentId ??= this.newSegmentId();
    this.partialStartMs ??= elapsed;
    this.transcribing = true;
    this.updateStage(this.currentSegmentId);
    this.segments.emit({
      id: this.currentSegmentId,
      callId: this.callId,
      speaker: this.speaker,
      originalLang: normalizeLanguageCode(partial.lang) ?? this.knownSpokenLang(),
      originalText: text,
      translatedLang: null,
      translatedText: null,
      startMs: this.partialStartMs,
      endMs: elapsed,
      final: false,
      createdAt: this.options.now(),
    });
  }

  private onSttFinal(session: SttSession, final: { text: string; lang?: string; langProbability?: number; startMs: number; endMs: number }): void {
    if (session !== this.stt || this.closed) return;
    const text = final.text.trim();
    const id = this.currentSegmentId ?? this.newSegmentId();
    this.currentSegmentId = null;
    this.partialStartMs = null;
    this.transcribing = false;

    if (text.length < this.options.minSegmentChars) {
      this.updateStage();
      this.maybeReopenStt();
      return;
    }

    const job: Job = {
      id,
      text,
      sttLang: normalizeLanguageCode(final.lang),
      sttProbability: final.langProbability ?? null,
      startMs: final.startMs + this.sttOffsetMs,
      endMs: final.endMs + this.sttOffsetMs,
      settings: this.settings,
      finalAt: this.options.now(),
      context: [...this.recent],
      translateMs: null,
    };
    this.recent.push({ speaker: this.speaker, text });
    if (this.recent.length > this.options.contextTurns) this.recent.shift();

    this.inflight += 1;
    this.updateStage(id);
    this.translateChain = this.translateChain
      .then(() => this.translateJob(job))
      .catch((error: unknown) => this.reportError(toError(error), 'Fallo al procesar una frase'));
    this.maybeReopenStt();
  }

  private onSttError(session: SttSession, error: Error): void {
    if (session !== this.stt || this.closed) return;
    this.reportError(error, 'Se perdió la transcripción; reconectando');
    this.stt = null;
    this.transcribing = false;
    void session.close().catch(() => undefined);
    this.later(() => void this.ensureStt(), this.options.sttRetryDelayMs);
  }

  private maybeReopenStt(): void {
    if (!this.stt || this.reopening || this.closed || this.transcribing) return;
    if (this.sttLang === this.desiredSttLang()) return;
    void this.swapStt();
  }

  private async swapStt(): Promise<void> {
    this.reopening = true;
    try {
      const lang = this.desiredSttLang();
      const next = await this.providers.stt.openSession(lang ? { lang } : {});
      if (this.closed) {
        await next.close();
        return;
      }
      const old = this.stt;
      this.attachStt(next, lang);
      await old?.close();
    } catch (error) {
      this.reportError(toError(error), 'No se pudo cambiar el idioma de la transcripción');
    } finally {
      this.reopening = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Translation
  // ---------------------------------------------------------------------------

  private async translateJob(job: Job): Promise<void> {
    if (this.closed) return;
    const passengerSide = this.direction === 'passenger_to_operator';
    try {
      const target = passengerSide ? job.settings.operatorLang : await this.resolveHeardTarget(job);
      if (this.closed) return;

      const fixedSpoken = job.settings.passengerSpeaks.mode === 'fixed' ? job.settings.passengerSpeaks.lang : null;
      const source: LanguageCode | null = passengerSide ? (fixedSpoken ?? job.sttLang) : job.settings.operatorLang;
      const passthrough = this.options.skipSameLanguage && source !== null && source === target;

      let translatedText: string | null = null;
      let detectedFrom: string | undefined;
      let failed = false;
      if (passthrough) {
        translatedText = job.text;
      } else {
        const started = this.options.now();
        try {
          const from = passengerSide ? fixedSpoken : job.settings.operatorLang;
          const result = await this.providers.translator.translate({
            text: job.text,
            ...(from ? { from } : {}),
            to: target,
            context: job.context,
          });
          translatedText = result.text;
          detectedFrom = result.detectedFrom;
        } catch (error) {
          failed = true;
          this.reportError(toError(error), 'No se pudo traducir; se muestra el texto original', job.id);
        }
        job.translateMs = this.options.now() - started;
      }
      if (this.closed) return;

      if (passengerSide) {
        const update = this.controller.observe({
          text: job.text,
          sttLang: job.sttLang,
          sttProbability: job.sttProbability,
          translatorLang: detectedFrom,
        });
        this.passengerState = this.controller.getState();
        if (update.changed) this.emitLanguageState(this.passengerState, update.notice);
      }

      const originalLang = passengerSide
        ? (normalizeLanguageCode(detectedFrom) ?? job.sttLang ?? normalizeLanguageCode(this.passengerState.lang))
        : job.settings.operatorLang;
      this.segments.emit({
        id: job.id,
        callId: this.callId,
        speaker: this.speaker,
        originalLang,
        originalText: job.text,
        translatedLang: failed ? null : target,
        translatedText: failed ? null : translatedText,
        startMs: job.startMs,
        endMs: job.endMs,
        final: true,
        createdAt: this.options.now(),
      });

      if (!failed && !passthrough && translatedText) {
        this.awaitingAudio += 1;
        const text = translatedText;
        this.speechChain = this.speechChain
          .then(() => this.speakJob(job, target, text))
          .catch((error: unknown) => this.reportError(toError(error), 'Fallo al reproducir la traducción', job.id));
      }
    } finally {
      this.inflight -= 1;
      this.updateStage(job.id);
    }
  }

  private async resolveHeardTarget(job: Job): Promise<LanguageCode> {
    const heard = heardLanguageFor(job.settings, this.passengerState);
    if (heard.usable && heard.lang) return heard.lang;
    const usable = await this.waitForUsable(job.settings, this.options.holdMs);
    if (usable) return usable;
    const best = heardLanguageFor(job.settings, this.passengerState).lang ?? this.controller.fallbackLang;
    if (!this.closed) this.emitLanguageState(this.passengerState, this.controller.fallbackNotice(best));
    return best;
  }

  private waitForUsable(settings: LanguageSettings, ms: number): Promise<LanguageCode | null> {
    return new Promise((resolve) => {
      const finish = (value: LanguageCode | null): void => {
        clearTimeout(timer);
        this.timers.delete(timer);
        this.waiters.delete(waiter);
        resolve(value);
      };
      const waiter: Waiter = {
        check: () => {
          const heard = heardLanguageFor(settings, this.passengerState);
          if (heard.usable && heard.lang) finish(heard.lang);
        },
        cancel: () => finish(null),
      };
      const timer = setTimeout(() => finish(null), ms);
      this.timers.add(timer);
      this.waiters.add(waiter);
      waiter.check();
    });
  }

  private releaseHold(): void {
    for (const waiter of [...this.waiters]) waiter.check();
  }

  // ---------------------------------------------------------------------------
  // Text to speech
  // ---------------------------------------------------------------------------

  private ttsFor(lang: string): Promise<TtsSession> {
    let promise = this.ttsSessions.get(lang);
    if (!promise) {
      promise = this.providers.tts.openSession({ lang }).then((session) => {
        session.onError((error) => {
          this.ttsSessions.delete(lang);
          this.reportError(error, 'Fallo en la voz traducida');
        });
        return session;
      });
      this.ttsSessions.set(lang, promise);
      promise.catch(() => this.ttsSessions.delete(lang));
    }
    return promise;
  }

  /** Warms up the voice of the language the next phrases will use, so a language change leaves no gap. */
  private prewarmTargets(): void {
    const lang =
      this.direction === 'passenger_to_operator'
        ? this.settings.operatorLang
        : heardLanguageFor(this.settings, this.passengerState).lang;
    if (!lang || this.closed) return;
    void this.ttsFor(lang)
      .then((session) => session.prewarm())
      .catch((error: unknown) => this.reportError(toError(error), 'No se pudo preparar la voz'));
  }

  private async speakJob(job: Job, lang: LanguageCode, text: string): Promise<void> {
    let counted = false;
    const markAudioStarted = (): void => {
      if (counted) return;
      counted = true;
      this.awaitingAudio -= 1;
    };
    try {
      if (this.closed) return;
      const session = await this.ttsFor(lang);
      const startedAt = this.options.now();
      let firstByteAt: number | null = null;
      await Promise.race([
        new Promise<void>((resolve) => {
          const offs: Unsubscribe[] = [];
          const finish = (): void => {
            for (const off of offs) off();
            resolve();
          };
          offs.push(
            session.onAudio((pcm) => {
              if (this.closed) return;
              if (firstByteAt === null) {
                firstByteAt = this.options.now();
                markAudioStarted();
                this.speaking = true;
                this.updateStage(job.id);
              }
              this.audio.emit(pcm);
            }),
            session.onDone(finish),
            session.onError(finish),
          );
          session.speak(text);
          session.flush();
        }),
        this.closedSignal,
      ]);
      if (firstByteAt !== null) {
        this.latencies.push({
          sttMs: null,
          translateMs: job.translateMs,
          ttsFirstByteMs: firstByteAt - startedAt,
          totalMs: firstByteAt - job.finalAt,
        });
      }
    } finally {
      markAudioStarted();
      this.speaking = false;
      this.updateStage(job.id);
    }
  }

  // ---------------------------------------------------------------------------
  // Stages, language events, errors
  // ---------------------------------------------------------------------------

  private trackReceiving(pcm: PcmChunk): void {
    if (pcm16Rms(pcm) < this.options.receivingRms) return;
    if (this.receivingTimer) clearTimeout(this.receivingTimer);
    this.receivingTimer = setTimeout(() => {
      this.receiving = false;
      this.updateStage();
    }, this.options.receivingHangoverMs);
    if (!this.receiving) {
      this.receiving = true;
      this.updateStage();
    }
  }

  private currentStage(): PipelineStage {
    if (this.errorUntil > this.options.now()) return 'error';
    if (this.speaking) return 'speaking';
    if (this.inflight > 0 || this.awaitingAudio > 0) return 'translating';
    if (this.transcribing) return 'transcribing';
    if (this.receiving) return 'receiving';
    return 'idle';
  }

  private updateStage(segmentId?: string): void {
    const stage = this.currentStage();
    if (stage === this.lastStage) return;
    this.lastStage = stage;
    this.stages.emit({
      direction: this.direction,
      stage,
      ...(segmentId ? { segmentId } : {}),
      ...(stage === 'error' && this.errorDetail ? { detail: this.errorDetail } : {}),
    });
  }

  private reportError(error: Error, detail: string, segmentId?: string): void {
    this.options.logger?.warn(detail, { direction: this.direction, error: error.message });
    this.errorDetail = detail;
    this.errorUntil = this.options.now() + this.options.errorDisplayMs;
    this.updateStage(segmentId);
    this.later(() => this.updateStage(), this.options.errorDisplayMs + 5);
    this.errors.emit(error);
  }

  private emitLanguageState(state: LanguageState, notice: LanguageNotice | null): void {
    this.languageStates.emit({ state, notice });
  }

  private knownSpokenLang(): LanguageCode | null {
    return this.direction === 'operator_to_passenger' ? this.settings.operatorLang : normalizeLanguageCode(this.passengerState.lang);
  }

  private newSegmentId(): string {
    this.segmentSeq += 1;
    return `${this.callId}:${this.direction}:${this.segmentSeq}`;
  }

  private later(action: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) action();
    }, ms);
    this.timers.add(timer);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.later(resolve, ms));
  }
}
