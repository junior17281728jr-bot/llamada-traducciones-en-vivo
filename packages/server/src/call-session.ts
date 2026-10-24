import { directAudioFor } from '@tw/pipeline';
import {
  AudioFrameType,
  LevelTrack,
  LevelsFrameBuilder,
  encodeAudioFrame,
  mergeLanguageSettings,
  type CallEndReason,
  type CallRecord,
  type ChannelCall,
  type DirectionFallback,
  type DirectionPipeline,
  type LanguageNotice,
  type LanguageSettings,
  type LanguageState,
  type Logger,
  type PartialLanguageSettings,
  type PcmChunk,
  type PipelineFactory,
  type RecordingStore,
  type RecordingWriter,
  type ServerMessage,
  type TranscriptSegment,
  type TranscriptStore,
  type Unsubscribe,
  NO_FALLBACK,
  UNKNOWN_LANGUAGE_STATE,
} from '@tw/shared';

/** What a call session needs from the operator connection. Implementations must never throw. */
export interface OperatorLink {
  send(message: ServerMessage): void;
  sendBinary(data: Uint8Array): void;
}

/** Link of an operator whose connection dropped: everything is discarded until the app reconnects. */
export const DETACHED_LINK: OperatorLink = { send: () => undefined, sendBinary: () => undefined };

export interface CallSessionDeps {
  call: ChannelCall;
  operatorId: string;
  link: OperatorLink;
  settings: LanguageSettings;
  pipelines: PipelineFactory;
  transcripts: TranscriptStore;
  recordings: RecordingStore | null;
  logger: Logger;
  simulated: boolean;
  /** Summary saved at the start and updated at the end. */
  record: CallRecord;
  now?: () => number;
  heartbeatMs?: number;
  onEnded: (info: { callId: string; reason: CallEndReason; durationMs: number }) => void;
}

/** Which directions relay the ORIGINAL voice because both ends share the language (see `directAudioFor`). */
export interface DirectAudio {
  passengerToOperator: boolean;
  operatorToPassenger: boolean;
}

/**
 * One answered call: the channel leg, the operator connection and the two translated directions.
 * Audio levels are measured here, on the real PCM of each leg, and sent as binary frames:
 * `PassengerIn` from `ChannelCall.onAudio` and `OperatorIn` from the microphone frames that arrive.
 *
 * Same language on both ends (a Spanish-speaking passenger, or Manual with the same language twice): the
 * pipelines translate nothing and synthesise nothing, so this session relays the original voice instead,
 * passenger -> operator as `OriginalPassenger` (0x03) frames and operator -> passenger as the microphone
 * itself. `directAudioFor` decides from the same settings and detection the pipelines use.
 */
export class CallSession {
  readonly callId: string;
  private readonly now: () => number;
  private readonly offs: Unsubscribe[] = [];
  private link: OperatorLink;
  private passengerPipe: DirectionPipeline | null = null;
  private operatorPipe: DirectionPipeline | null = null;
  private writer: RecordingWriter | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly passengerLevels = new LevelsFrameBuilder(LevelTrack.PassengerIn);
  private readonly operatorLevels = new LevelsFrameBuilder(LevelTrack.OperatorIn);
  private settings: LanguageSettings;
  private detected: LanguageState = UNKNOWN_LANGUAGE_STATE;
  private notice: LanguageNotice | null = null;
  private direct: DirectAudio = { passengerToOperator: false, operatorToPassenger: false };
  /** Plan B of each direction (system voice, original voice relayed while a service is down). */
  private fallback: { passengerToOperator: DirectionFallback; operatorToPassenger: DirectionFallback } = {
    passengerToOperator: NO_FALLBACK,
    operatorToPassenger: NO_FALLBACK,
  };
  private muted = false;
  private answeredAt = 0;
  private ended = false;
  private endedPromise: Promise<void> | null = null;
  /** Reason chosen by the server (e.g. `connection_lost`) that wins over what the channel reports. */
  private endingReason: CallEndReason | null = null;
  private record: CallRecord;

  constructor(private readonly deps: CallSessionDeps) {
    this.callId = deps.call.id;
    this.now = deps.now ?? (() => Date.now());
    this.settings = deps.settings;
    this.record = deps.record;
    this.link = deps.link;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  get operatorId(): string {
    return this.deps.operatorId;
  }

  get languageSettings(): LanguageSettings {
    return this.settings;
  }

  /** Which directions relay the original voice right now. */
  get directAudio(): DirectAudio {
    return this.direct;
  }

  async start(): Promise<void> {
    const { call, pipelines, recordings, logger } = this.deps;
    this.answeredAt = this.now();
    // Subscribed before any await: a hang-up that arrives while the recording folder is being created
    // must still end this session (the channel fires `onEnded` exactly once, to whoever listens then).
    this.offs.push(call.onEnded((end) => void this.finish(this.endingReason ?? end.reason)));
    if (recordings) {
      let writer: RecordingWriter | null = null;
      try {
        writer = await recordings.open(this.callId);
      } catch (error) {
        logger.error('No se pudo abrir la grabación', { callId: this.callId, error: String(error) });
      }
      if (this.ended) {
        // The passenger hung up while the recording was being opened: nothing else starts.
        await writer?.close().catch(() => undefined);
        return;
      }
      this.writer = writer;
    }

    const passenger = pipelines.createDirectionPipeline({
      callId: this.callId,
      direction: 'passenger_to_operator',
      settings: this.settings,
      ...(call.langHint ? { langHint: call.langHint } : {}),
    });
    const operator = pipelines.createDirectionPipeline({
      callId: this.callId,
      direction: 'operator_to_passenger',
      settings: this.settings,
    });
    this.passengerPipe = passenger;
    this.operatorPipe = operator;
    // The passenger pipeline may already know something (a channel hint): start from its view, and give it to
    // the other direction too, so the relay decision and the pipelines agree from the first phrase.
    this.detected = passenger.getLanguageState?.() ?? UNKNOWN_LANGUAGE_STATE;
    operator.setPassengerLanguageState(this.detected);
    this.updateDirectAudio();

    this.offs.push(
      passenger.onSegment((segment) => this.onSegment(segment)),
      operator.onSegment((segment) => this.onSegment(segment)),
      passenger.onStage((event) => this.link.send({ type: 'pipeline.stage', callId: this.callId, ...event })),
      operator.onStage((event) => this.link.send({ type: 'pipeline.stage', callId: this.callId, ...event })),
      passenger.onAudio((pcm) => this.link.sendBinary(encodeAudioFrame(AudioFrameType.TranslatedPassenger, pcm))),
      operator.onAudio((pcm) => call.sendAudio(pcm)),
      passenger.onLanguageState((event) => {
        this.detected = event.state;
        operator.setPassengerLanguageState(event.state);
        if (event.notice) this.notice = event.notice;
        else if (event.state.status !== 'uncertain') this.notice = null;
        this.updateDirectAudio();
        this.sendLanguages();
      }),
      operator.onLanguageState((event) => {
        if (event.notice) this.notice = event.notice;
        this.sendLanguages();
      }),
      ...(passenger.onFallback ? [passenger.onFallback((state) => this.onFallback('passengerToOperator', state))] : []),
      ...(operator.onFallback ? [operator.onFallback((state) => this.onFallback('operatorToPassenger', state))] : []),
      passenger.onError((error) => logger.warn('Fallo en el sentido pasajero a operador', { callId: this.callId, error: error.message })),
      operator.onError((error) => logger.warn('Fallo en el sentido operador a pasajero', { callId: this.callId, error: error.message })),
      call.onAudio((pcm) => this.onPassengerAudio(pcm)),
    );

    this.record = { ...this.record, state: 'active', answeredAt: this.answeredAt, passengerLang: this.passengerLangForRecord(), recorded: this.writer !== null };
    await this.deps.transcripts.saveCall(this.record).catch((error: unknown) => logger.error('No se pudo guardar la llamada', { error: String(error) }));
    if (this.ended) return;
    this.sendState();
    this.sendLanguages();
    this.heartbeat = setInterval(() => this.sendHeartbeats(), this.deps.heartbeatMs ?? 500);
  }

  /** Microphone audio from the operator (PCM16 16 kHz). Ignored while muted. */
  pushOperatorAudio(pcm: PcmChunk): void {
    if (this.ended || this.muted) return;
    for (const frame of this.operatorLevels.push(pcm)) this.link.sendBinary(frame);
    this.writer?.write('operator', pcm);
    // Same language: the passenger hears the operator's own voice; the pipeline only transcribes.
    if (this.direct.operatorToPassenger) this.deps.call.sendAudio(pcm);
    this.operatorPipe?.pushAudio(pcm);
  }

  setMuted(muted: boolean): void {
    if (this.ended || this.muted === muted) return;
    this.muted = muted;
    this.sendState();
  }

  /** Live language change from the operator; applies to the next phrases. */
  setLanguages(patch: PartialLanguageSettings): void {
    if (this.ended) return;
    this.settings = mergeLanguageSettings(this.settings, patch);
    this.notice = null;
    this.operatorPipe?.applyLanguageSettings(this.settings);
    this.passengerPipe?.applyLanguageSettings(this.settings);
    this.detected = this.passengerPipe?.getLanguageState?.() ?? this.detected;
    this.updateDirectAudio();
    this.sendLanguages();
  }

  hangupByOperator(): Promise<void> {
    return this.deps.call.hangup();
  }

  /** Ends the call from the server side with `reason` in the history and in the message to the operator. */
  terminate(reason: CallEndReason): Promise<void> {
    if (this.ended) return this.whenEnded();
    this.endingReason = reason;
    return this.deps.call.hangup();
  }

  /** The operator's connection dropped: messages go nowhere until `attachLink`. */
  detachLink(): void {
    this.link = DETACHED_LINK;
  }

  /** The operator's app is back (same operator, new socket): the screen gets the whole picture again. */
  attachLink(link: OperatorLink): void {
    this.link = link;
    this.resync();
  }

  /** Resends state and languages so a freshly (re)connected app shows the call. */
  resync(): void {
    if (this.ended) return;
    this.sendState();
    this.sendLanguages();
    if (this.fallback.passengerToOperator !== NO_FALLBACK || this.fallback.operatorToPassenger !== NO_FALLBACK) this.sendFallback();
  }

  /** Resolves when the session has finished closing everything. */
  whenEnded(): Promise<void> {
    return this.endedPromise ?? Promise.resolve();
  }

  /** History: the detected language, else the one the operator fixed, else what the channel hinted. */
  private passengerLangForRecord(): string | null {
    if (this.detected.lang) return this.detected.lang;
    if (this.settings.passengerSpeaks.mode === 'fixed') return this.settings.passengerSpeaks.lang;
    return this.record.passengerLang;
  }

  private onPassengerAudio(pcm: PcmChunk): void {
    if (this.ended) return;
    for (const frame of this.passengerLevels.push(pcm)) this.link.sendBinary(frame);
    this.writer?.write('passenger', pcm);
    // Same language: the operator hears the passenger's own voice; the pipeline only transcribes.
    if (this.direct.passengerToOperator) this.link.sendBinary(encodeAudioFrame(AudioFrameType.OriginalPassenger, pcm));
    this.passengerPipe?.pushAudio(pcm);
  }

  /**
   * Same language on both ends, or plan B while transcription/translation/voice is down: that direction relays
   * the ORIGINAL voice. The pipeline speaks nothing meanwhile, so the two never overlap.
   */
  private updateDirectAudio(): void {
    this.direct = {
      passengerToOperator: directAudioFor('passenger_to_operator', this.settings, this.detected) || this.fallback.passengerToOperator.originalVoice,
      operatorToPassenger: directAudioFor('operator_to_passenger', this.settings, this.detected) || this.fallback.operatorToPassenger.originalVoice,
    };
  }

  private onFallback(direction: 'passengerToOperator' | 'operatorToPassenger', state: DirectionFallback): void {
    if (this.ended) return;
    this.fallback = { ...this.fallback, [direction]: state };
    const before = this.direct;
    this.updateDirectAudio();
    this.deps.logger.warn('Plan B de la traducción', { callId: this.callId, direction, ...state });
    this.sendFallback();
    if (before.passengerToOperator !== this.direct.passengerToOperator || before.operatorToPassenger !== this.direct.operatorToPassenger) this.sendLanguages();
  }

  private sendFallback(): void {
    this.link.send({ type: 'call.fallback', callId: this.callId, ...this.fallback });
  }

  private onSegment(segment: TranscriptSegment): void {
    this.link.send({ type: 'transcript.segment', segment });
    if (segment.final) {
      this.deps.transcripts
        .saveSegment(segment)
        .catch((error: unknown) => this.deps.logger.error('No se pudo guardar un segmento', { callId: this.callId, error: String(error) }));
    }
  }

  private sendState(): void {
    this.link.send({
      type: 'call.state',
      callId: this.callId,
      state: this.ended ? 'ended' : 'active',
      direction: this.deps.call.direction,
      remoteNumber: this.deps.call.remoteNumber,
      answeredAt: this.answeredAt,
      muted: this.muted,
      simulated: this.deps.simulated,
    });
  }

  private sendLanguages(): void {
    this.link.send({
      type: 'call.languages',
      callId: this.callId,
      settings: this.settings,
      detected: this.detected,
      notice: this.notice,
      directAudio: this.direct,
    });
  }

  /** Zero-window frames: "the server is alive and measuring, there is just no audio". */
  private sendHeartbeats(): void {
    const timeMs = this.now() - this.answeredAt;
    this.link.sendBinary(this.passengerLevels.heartbeat(timeMs));
    this.link.sendBinary(this.operatorLevels.heartbeat(timeMs));
  }

  private finish(reason: CallEndReason): Promise<void> {
    this.endedPromise ??= this.doFinish(reason);
    return this.endedPromise;
  }

  private async doFinish(reason: CallEndReason): Promise<void> {
    this.ended = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const off of this.offs) off();
    this.offs.length = 0;
    await Promise.allSettled([this.passengerPipe?.close(), this.operatorPipe?.close()]);
    const info = await this.writer?.close().catch((error: unknown) => {
      this.deps.logger.error('No se pudo cerrar la grabación', { callId: this.callId, error: String(error) });
      return null;
    });
    const endedAt = this.now();
    const durationMs = Math.max(0, endedAt - this.answeredAt);
    this.record = {
      ...this.record,
      state: 'ended',
      endedAt,
      endReason: reason,
      passengerLang: this.passengerLangForRecord(),
      recorded: info != null,
    };
    await this.deps.transcripts.saveCall(this.record).catch((error: unknown) => this.deps.logger.error('No se pudo guardar la llamada', { error: String(error) }));
    this.link.send({ type: 'call.ended', callId: this.callId, reason, durationMs });
    this.deps.onEnded({ callId: this.callId, reason, durationMs });
  }
}
