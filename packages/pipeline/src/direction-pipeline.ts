/**
 * One translated direction of a call: audio in -> STT -> translation -> TTS -> audio out.
 *
 * - Segments are translated in order and spoken one after another, so the translated voice never
 *   overlaps and the output is a single continuous stream.
 * - Language settings are captured when a phrase is finalised: a change made later only affects the
 *   phrases that follow. A phrase already being translated or spoken finishes in its own language and
 *   the audio that is playing is never cut. The voice for the new language is warmed up in the
 *   background beforehand.
 * - Plan B (`fallback`, off unless the server enables it): when the main voice fails, the phrase is spoken with
 *   `fallbackTts` (the computer's own voice); while transcription, translation or every voice is down, the
 *   pipeline reports `originalVoice` and the call session relays the ORIGINAL voice instead, so nobody is left
 *   in silence. It recovers by itself when the service answers again.
 * - `operator_to_passenger` holds the operator's text (up to `holdMs`) until the passenger's language
 *   is usable, then falls back to a configured language and warns the operator.
 */
import {
  NO_FALLBACK,
  NO_FALLBACK_POLICY,
  normalizeLanguageCode,
  pcm16Rms,
  pcmDurationMs,
  speakerOfDirection,
  type DirectionPipeline,
  type DirectionPipelineConfig,
  type DirectionFallback,
  type FallbackPolicy,
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
  /** Plan B voice (the computer's own), used when `tts` fails and `fallback.systemVoice` is on. */
  fallbackTts?: TtsProvider;
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
  /**
   * After `sttRetries` failed attempts in a row the transcription stops retrying for a while (doubling from the
   * minimum up to the maximum) instead of hammering the service with every audio chunk. A settings change resets it.
   */
  sttBackoffMinMs: number;
  sttBackoffMaxMs: number;
  /** How long the `error` stage stays visible. */
  errorDisplayMs: number;
  /** Do not translate a phrase that is already in the target language. */
  skipSameLanguage: boolean;
  controller: Partial<LanguageControllerConfig>;
  /** Plan B allowed for this call (off by default). */
  fallback: FallbackPolicy;
  /** With a plan B voice available: longest wait for the first audio of the main voice before switching. */
  voiceFirstAudioTimeoutMs: number;
  /** After the main voice fails, the next phrases go straight to the plan B voice for this long, then it is tried again. */
  primaryVoiceCooldownMs: number;
  /** When no voice at all could speak, the original voice is relayed for this long before voices are tried again. */
  voiceRetryMs: number;
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
  sttBackoffMinMs: 5000,
  sttBackoffMaxMs: 60_000,
  errorDisplayMs: 3000,
  skipSameLanguage: true,
  controller: {},
  fallback: NO_FALLBACK_POLICY,
  voiceFirstAudioTimeoutMs: 6000,
  primaryVoiceCooldownMs: 60_000,
  voiceRetryMs: 30_000,
  now: () => Date.now(),
};

/** Why the original voice is being relayed. */
type Outage = 'stt' | 'translate' | 'voice';

const OUTAGE_DETAIL: Record<Outage, string> = {
  stt: 'La transcripción no responde: se oye la voz original, sin traducir.',
  translate: 'La traducción no responde: se oye la voz original, sin traducir.',
  voice: 'Ninguna voz pudo leer la traducción: se oye la voz original y la traducción queda en pantalla.',
};
const SYSTEM_VOICE_DETAIL = 'La voz de ElevenLabs falló: la traducción la lee la voz del ordenador.';

type VoiceKind = 'primary' | 'fallback';
type SpeakOutcome = { status: 'spoken' | 'partial' | 'silent'; error: Error | null };

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
  /** The phrase was said while the original voice was being relayed (plan B): it was already heard, it is not spoken again. */
  relayed: boolean;
}

interface Waiter {
  check: () => void;
  cancel: () => void;
}

const toError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));

/** Language the passenger speaks when it is known for sure: fixed by the operator, or detected and usable. */
function spokenLanguageFor(settings: LanguageSettings, state: LanguageState): LanguageCode | null {
  if (settings.passengerSpeaks.mode === 'fixed') return settings.passengerSpeaks.lang;
  const heard = heardLanguageFor({ ...settings, passengerHears: { mode: 'follow' } }, state);
  return heard.usable ? heard.lang : null;
}

/**
 * True when both ends of `direction` share one language for sure: the operator's language equals the
 * language the passenger speaks (passenger -> operator) or the language the passenger hears (operator ->
 * passenger). The call session then relays the ORIGINAL voice and this pipeline synthesises nothing; both
 * decide from the same inputs, so what one relays the other never speaks.
 */
export function directAudioFor(direction: PipelineDirection, settings: LanguageSettings, state: LanguageState): boolean {
  if (direction === 'passenger_to_operator') {
    const spoken = spokenLanguageFor(settings, state);
    return spoken !== null && spoken === settings.operatorLang;
  }
  const heard = heardLanguageFor(settings, state);
  return heard.usable && heard.lang === settings.operatorLang;
}

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
  private readonly fallbacks = new Emitter<DirectionFallback>();
  private fallbackState: DirectionFallback = NO_FALLBACK;
  private readonly outages = new Map<Outage, string>();
  private usingSystemVoice = false;
  private primaryVoiceDownUntil = 0;
  private voiceRetryTimer: ReturnType<typeof setTimeout> | null = null;

  private settings: LanguageSettings;
  /** What the passenger-side detection reports (mirrored from the other direction for `operator_to_passenger`). */
  private passengerState: LanguageState = UNKNOWN_LANGUAGE_STATE;

  private stt: SttSession | null = null;
  private sttLang: LanguageCode | undefined;
  private sttOffsetMs = 0;
  private sttOpening: Promise<void> | null = null;
  private sttBackoffMs = 0;
  private sttBackoffUntil = 0;
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
  private readonly fallbackTtsSessions = new Map<string, Promise<TtsSession>>();
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
  private lastStageDetail: string | undefined;

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

  onFallback(handler: (state: DirectionFallback) => void): Unsubscribe {
    return this.fallbacks.on(handler);
  }

  getFallback(): DirectionFallback {
    return this.fallbackState;
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
    // A changed setting (or key) deserves a fresh transcription attempt at once.
    this.sttBackoffUntil = 0;
    if (this.pending.length > 0) void this.ensureStt();
  }

  getLanguageState(): LanguageState {
    return this.passengerState;
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
    for (const sessionPromise of [...this.ttsSessions.values(), ...this.fallbackTtsSessions.values()]) {
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
    this.fallbackTtsSessions.clear();
    this.fallbacks.clear();
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
    if (this.stt || this.closed || this.options.now() < this.sttBackoffUntil) return Promise.resolve();
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
        // Back after an outage: the audio kept meanwhile was already heard as the original voice; translating
        // it now would repeat it late.
        if (this.outages.has('stt') && this.relayingOriginal()) {
          this.pending = [];
          this.pendingMs = 0;
        }
        this.attachStt(session, lang);
        this.sttBackoffMs = 0;
        this.sttBackoffUntil = 0;
        this.setOutage('stt', false);
        return;
      } catch (error) {
        if (this.closed) return;
        if (attempt >= this.options.sttRetries) {
          this.sttBackoffMs = Math.min(this.options.sttBackoffMaxMs, Math.max(this.options.sttBackoffMinMs, this.sttBackoffMs * 2));
          this.sttBackoffUntil = this.options.now() + this.sttBackoffMs;
          this.reportError(
            toError(error),
            `La transcripción no está disponible (${toError(error).message}); se volverá a intentar en ${Math.round(this.sttBackoffMs / 1000)} s`,
          );
          this.setOutage('stt', true);
          return;
        }
        this.reportError(toError(error), 'No se pudo conectar la transcripción');
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
      relayed: this.relayingOriginal(),
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

      // Same language on both ends. `relay` mirrors what the call session decides from the same inputs: while
      // it is true the session forwards the ORIGINAL voice, so nothing is synthesised here.
      const relay = directAudioFor(this.direction, job.settings, this.passengerState);
      const fixedSpoken = job.settings.passengerSpeaks.mode === 'fixed' ? job.settings.passengerSpeaks.lang : null;
      const source: LanguageCode | null = passengerSide ? (fixedSpoken ?? (relay ? target : job.sttLang)) : job.settings.operatorLang;
      const passthrough = this.options.skipSameLanguage && source !== null && source === target;
      // Automatic detection needs the translator's language signal too: a phrase the STT already places in the
      // operator's language still goes to the translator (which returns it unchanged) until the detection is
      // CONFIRMED, and a phrase the STT places in ANOTHER language while the original voice is relayed goes as
      // well, so a change of language is noticed and the relay stops. Once confirmed and agreeing, nothing is sent.
      const needsTranslator =
        !passthrough ||
        (passengerSide &&
          fixedSpoken === null &&
          (!relay || this.passengerState.status !== 'confirmed' || (job.sttLang !== null && job.sttLang !== target)));

      let translatedText: string | null = null;
      let detectedFrom: string | undefined;
      let failed = false;
      if (!needsTranslator) {
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
          this.setOutage('translate', false);
        } catch (error) {
          failed = true;
          this.reportError(toError(error), 'No se pudo traducir; se muestra el texto original', job.id);
          this.setOutage('translate', true);
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

      // Spoken unless the session is relaying the original voice for this direction (same language, known for sure,
      // or plan B while a service is down).
      if (!failed && !relay && translatedText && !job.relayed && !this.relayingOriginal()) {
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

  private ttsFor(lang: string, kind: VoiceKind = 'primary'): Promise<TtsSession> {
    const sessions = kind === 'primary' ? this.ttsSessions : this.fallbackTtsSessions;
    const provider = kind === 'primary' ? this.providers.tts : this.providers.fallbackTts;
    let promise = sessions.get(lang);
    if (!promise) {
      if (!provider) return Promise.reject(new Error('No hay voz de respaldo'));
      promise = provider.openSession({ lang }).then((session) => {
        session.onError((error) => {
          if (sessions.get(lang) === promise) sessions.delete(lang);
          this.reportError(error, kind === 'primary' ? 'Fallo en la voz traducida' : 'Fallo en la voz del ordenador');
        });
        return session;
      });
      sessions.set(lang, promise);
      promise.catch(() => {
        if (sessions.get(lang) === promise) sessions.delete(lang);
      });
    }
    return promise;
  }

  /** Forgets a voice session that did not answer, so the next phrase opens a fresh one. */
  private dropTts(lang: string, kind: VoiceKind, session: TtsSession): void {
    const sessions = kind === 'primary' ? this.ttsSessions : this.fallbackTtsSessions;
    sessions.delete(lang);
    session.cancel();
    void session.close().catch(() => undefined);
  }

  private fallbackVoiceAvailable(): boolean {
    return this.options.fallback.systemVoice && this.providers.fallbackTts !== undefined;
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
    // The plan B voice is warmed up too (on Windows it starts the voice process), quietly: it is only a backup.
    if (this.fallbackVoiceAvailable()) {
      void this.ttsFor(lang, 'fallback')
        .then((session) => session.prewarm())
        .catch(() => undefined);
    }
  }

  private async speakJob(job: Job, lang: LanguageCode, text: string): Promise<void> {
    let counted = false;
    const markAudioStarted = (): void => {
      if (counted) return;
      counted = true;
      this.awaitingAudio -= 1;
    };
    try {
      // The original voice started being relayed after this phrase was queued: speaking it now would overlap.
      if (this.closed || this.relayingOriginal()) return;
      const backup = this.fallbackVoiceAvailable();
      // Main voice first. While it is cooling down after a failure the plan B voice goes first, but the main voice is
      // still tried if the plan B one cannot speak (no voice for that language on this computer).
      const plan: VoiceKind[] = !backup ? ['primary'] : this.options.now() >= this.primaryVoiceDownUntil ? ['primary', 'fallback'] : ['fallback', 'primary'];
      let failure: Error | null = null;
      for (const kind of plan) {
        if (this.relayingOriginal()) return;
        const outcome = await this.speakWith(job, lang, text, kind, markAudioStarted, backup && kind === 'primary');
        if (this.closed) return;
        if (outcome.status !== 'silent') {
          // Spoken (or partly spoken: repeating it with another voice would say it twice).
          if (kind === 'primary') this.primaryVoiceDownUntil = 0;
          this.usingSystemVoice = kind === 'fallback';
          this.setOutage('voice', false);
          return;
        }
        failure = outcome.error ?? failure;
        if (kind === 'primary' && backup && this.primaryVoiceDownUntil <= this.options.now()) {
          this.primaryVoiceDownUntil = this.options.now() + this.options.primaryVoiceCooldownMs;
        }
      }
      if (failure) this.reportError(failure, 'No se pudo leer la traducción en voz alta; queda el texto en pantalla', job.id);
      this.setOutage('voice', true);
    } finally {
      markAudioStarted();
      this.speaking = false;
      this.updateStage(job.id);
    }
  }

  /** Speaks `text` with one voice. `silent`: nothing came out (failed, timed out or empty), so another voice may try. */
  private async speakWith(
    job: Job,
    lang: LanguageCode,
    text: string,
    kind: VoiceKind,
    markAudioStarted: () => void,
    withTimeout: boolean,
  ): Promise<SpeakOutcome> {
    let session: TtsSession;
    try {
      session = await this.ttsFor(lang, kind);
    } catch (error) {
      return { status: 'silent', error: toError(error) };
    }
    if (this.closed) return { status: 'silent', error: null };
    const startedAt = this.options.now();
    let firstByteAt: number | null = null;
    let error: Error | null = null;
    let timedOut = false;
    await Promise.race([
      new Promise<void>((resolve) => {
        const offs: Unsubscribe[] = [];
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (): void => {
          if (timer) {
            clearTimeout(timer);
            this.timers.delete(timer);
          }
          for (const off of offs) off();
          resolve();
        };
        offs.push(
          session.onAudio((pcm) => {
            if (this.closed) return;
            // Plan B started relaying the original voice mid-phrase: the rest of this translation is dropped.
            if (this.relayingOriginal()) {
              session.cancel();
              finish();
              return;
            }
            if (firstByteAt === null) {
              firstByteAt = this.options.now();
              if (timer) {
                clearTimeout(timer);
                this.timers.delete(timer);
                timer = null;
              }
              markAudioStarted();
              this.speaking = true;
              this.updateStage(job.id);
            }
            this.audio.emit(pcm);
          }),
          session.onDone(finish),
          session.onError((failure) => {
            error = failure;
            finish();
          }),
        );
        if (withTimeout) {
          timer = setTimeout(() => {
            if (firstByteAt !== null) return;
            timedOut = true;
            finish();
          }, this.options.voiceFirstAudioTimeoutMs);
          this.timers.add(timer);
        }
        session.speak(text);
        session.flush();
      }),
      this.closedSignal,
    ]);
    if (timedOut) {
      this.dropTts(lang, kind, session);
      error = new Error(`La voz no respondió en ${Math.round(this.options.voiceFirstAudioTimeoutMs / 1000)} s`);
    }
    if (firstByteAt !== null) {
      this.latencies.push({
        sttMs: null,
        translateMs: job.translateMs,
        ttsFirstByteMs: firstByteAt - startedAt,
        totalMs: firstByteAt - job.finalAt,
      });
      return { status: error ? 'partial' : 'spoken', error };
    }
    return { status: 'silent', error };
  }

  // ---------------------------------------------------------------------------
  // Plan B state
  // ---------------------------------------------------------------------------

  /** True while the call session must relay the original voice of this direction (plan B allowed and a service down). */
  private relayingOriginal(): boolean {
    return this.options.fallback.originalVoice && this.outages.size > 0;
  }

  private setOutage(kind: Outage, down: boolean): void {
    if (this.closed) return;
    if (down) {
      this.outages.delete(kind);
      this.outages.set(kind, OUTAGE_DETAIL[kind]);
    } else {
      this.outages.delete(kind);
    }
    if (kind === 'voice') {
      if (this.voiceRetryTimer) {
        clearTimeout(this.voiceRetryTimer);
        this.timers.delete(this.voiceRetryTimer);
        this.voiceRetryTimer = null;
      }
      // While the original voice is relayed nothing is spoken, so the voices get another chance after a while.
      if (down) {
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          this.voiceRetryTimer = null;
          this.setOutage('voice', false);
        }, this.options.voiceRetryMs);
        this.timers.add(timer);
        this.voiceRetryTimer = timer;
      }
    }
    this.publishFallback();
  }

  private publishFallback(): void {
    const originalVoice = this.relayingOriginal();
    const systemVoice = this.usingSystemVoice && this.fallbackVoiceAvailable();
    const detail = originalVoice ? [...this.outages.values()].at(-1)! : systemVoice ? SYSTEM_VOICE_DETAIL : null;
    const next: DirectionFallback = { systemVoice, originalVoice, detail };
    const previous = this.fallbackState;
    if (previous.systemVoice === next.systemVoice && previous.originalVoice === next.originalVoice && previous.detail === next.detail) return;
    this.fallbackState = next;
    this.fallbacks.emit(next);
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
    const detail = stage === 'error' ? this.errorDetail : undefined;
    // A new error while the error stage is already showing still deserves its own event (the text changed).
    if (stage === this.lastStage && detail === this.lastStageDetail) return;
    this.lastStage = stage;
    this.lastStageDetail = detail;
    this.stages.emit({
      direction: this.direction,
      stage,
      ...(segmentId ? { segmentId } : {}),
      ...(detail ? { detail } : {}),
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
