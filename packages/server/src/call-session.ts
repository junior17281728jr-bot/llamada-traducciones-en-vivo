import {
  AudioFrameType,
  LevelTrack,
  LevelsFrameBuilder,
  encodeAudioFrame,
  mergeLanguageSettings,
  type CallEndReason,
  type CallRecord,
  type ChannelCall,
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
  UNKNOWN_LANGUAGE_STATE,
} from '@tw/shared';

/** What a call session needs from the operator connection. Implementations must never throw. */
export interface OperatorLink {
  send(message: ServerMessage): void;
  sendBinary(data: Uint8Array): void;
}

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

/**
 * One answered call: the channel leg, the operator connection and the two translated directions.
 * Audio levels are measured here, on the real PCM of each leg, and sent as binary frames:
 * `PassengerIn` from `ChannelCall.onAudio` and `OperatorIn` from the microphone frames that arrive.
 */
export class CallSession {
  readonly callId: string;
  private readonly now: () => number;
  private readonly offs: Unsubscribe[] = [];
  private passengerPipe: DirectionPipeline | null = null;
  private operatorPipe: DirectionPipeline | null = null;
  private writer: RecordingWriter | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly passengerLevels = new LevelsFrameBuilder(LevelTrack.PassengerIn);
  private readonly operatorLevels = new LevelsFrameBuilder(LevelTrack.OperatorIn);
  private settings: LanguageSettings;
  private detected: LanguageState = UNKNOWN_LANGUAGE_STATE;
  private notice: LanguageNotice | null = null;
  private muted = false;
  private answeredAt = 0;
  private ended = false;
  private endedPromise: Promise<void> | null = null;
  private record: CallRecord;

  constructor(private readonly deps: CallSessionDeps) {
    this.callId = deps.call.id;
    this.now = deps.now ?? (() => Date.now());
    this.settings = deps.settings;
    this.record = deps.record;
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

  async start(): Promise<void> {
    const { call, pipelines, recordings, logger } = this.deps;
    this.answeredAt = this.now();
    if (recordings) {
      try {
        this.writer = await recordings.open(this.callId);
      } catch (error) {
        logger.error('No se pudo abrir la grabación', { callId: this.callId, error: String(error) });
      }
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

    this.offs.push(
      passenger.onSegment((segment) => this.onSegment(segment)),
      operator.onSegment((segment) => this.onSegment(segment)),
      passenger.onStage((event) => this.deps.link.send({ type: 'pipeline.stage', callId: this.callId, ...event })),
      operator.onStage((event) => this.deps.link.send({ type: 'pipeline.stage', callId: this.callId, ...event })),
      passenger.onAudio((pcm) => this.deps.link.sendBinary(encodeAudioFrame(AudioFrameType.TranslatedPassenger, pcm))),
      operator.onAudio((pcm) => call.sendAudio(pcm)),
      passenger.onLanguageState((event) => {
        this.detected = event.state;
        operator.setPassengerLanguageState(event.state);
        if (event.notice) this.notice = event.notice;
        else if (event.state.status !== 'uncertain') this.notice = null;
        this.sendLanguages();
      }),
      operator.onLanguageState((event) => {
        if (event.notice) this.notice = event.notice;
        this.sendLanguages();
      }),
      passenger.onError((error) => logger.warn('Fallo en el sentido pasajero a operador', { callId: this.callId, error: error.message })),
      operator.onError((error) => logger.warn('Fallo en el sentido operador a pasajero', { callId: this.callId, error: error.message })),
      call.onAudio((pcm) => this.onPassengerAudio(pcm)),
      call.onEnded((end) => void this.finish(end.reason)),
    );

    this.record = { ...this.record, state: 'active', answeredAt: this.answeredAt, recorded: this.writer !== null };
    await this.deps.transcripts.saveCall(this.record).catch((error: unknown) => logger.error('No se pudo guardar la llamada', { error: String(error) }));
    this.sendState();
    this.sendLanguages();
    this.heartbeat = setInterval(() => this.sendHeartbeats(), this.deps.heartbeatMs ?? 500);
  }

  /** Microphone audio from the operator (PCM16 16 kHz). Ignored while muted. */
  pushOperatorAudio(pcm: PcmChunk): void {
    if (this.ended || this.muted) return;
    for (const frame of this.operatorLevels.push(pcm)) this.deps.link.sendBinary(frame);
    this.writer?.write('operator', pcm);
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
    this.sendLanguages();
  }

  hangupByOperator(): Promise<void> {
    return this.deps.call.hangup();
  }

  /** Resolves when the session has finished closing everything. */
  whenEnded(): Promise<void> {
    return this.endedPromise ?? Promise.resolve();
  }

  private onPassengerAudio(pcm: PcmChunk): void {
    if (this.ended) return;
    for (const frame of this.passengerLevels.push(pcm)) this.deps.link.sendBinary(frame);
    this.writer?.write('passenger', pcm);
    this.passengerPipe?.pushAudio(pcm);
  }

  private onSegment(segment: TranscriptSegment): void {
    this.deps.link.send({ type: 'transcript.segment', segment });
    if (segment.final) {
      this.deps.transcripts
        .saveSegment(segment)
        .catch((error: unknown) => this.deps.logger.error('No se pudo guardar un segmento', { callId: this.callId, error: String(error) }));
    }
  }

  private sendState(): void {
    this.deps.link.send({
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
    this.deps.link.send({
      type: 'call.languages',
      callId: this.callId,
      settings: this.settings,
      detected: this.detected,
      notice: this.notice,
    });
  }

  /** Zero-window frames: "the server is alive and measuring, there is just no audio". */
  private sendHeartbeats(): void {
    const timeMs = this.now() - this.answeredAt;
    this.deps.link.sendBinary(this.passengerLevels.heartbeat(timeMs));
    this.deps.link.sendBinary(this.operatorLevels.heartbeat(timeMs));
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
      passengerLang: this.detected.lang ?? this.record.passengerLang,
      recorded: info != null,
    };
    await this.deps.transcripts.saveCall(this.record).catch((error: unknown) => this.deps.logger.error('No se pudo guardar la llamada', { error: String(error) }));
    this.deps.link.send({ type: 'call.ended', callId: this.callId, reason, durationMs });
    this.deps.onEnded({ callId: this.callId, reason, durationMs });
  }
}
