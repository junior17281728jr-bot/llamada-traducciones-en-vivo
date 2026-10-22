import {
  languageSettingsFromPreferences,
  mergeLanguageSettings,
  normalizeLanguageCode,
  type CallChannel,
  type CallEndReason,
  type CallRecord,
  type ChannelCall,
  type ErrorCode,
  type Logger,
  type OperatorInfo,
  type OperatorPreferences,
  type OperatorRole,
  type OperatorStatus,
  type PartialLanguageSettings,
  type PcmChunk,
  type PipelineFactory,
  type PreferencesStore,
  type RecordingStore,
  type ServerMessage,
  type TranscriptStore,
  type Unsubscribe,
} from '@tw/shared';
import { CallSession, type OperatorLink } from './call-session.js';
import type { ServerConfig } from './config.js';

export interface CallManagerDeps {
  config: Pick<ServerConfig, 'maxConcurrentCalls' | 'ringTimeoutSeconds' | 'autoAccept' | 'fallbackLang'>;
  channel: CallChannel;
  pipelines: PipelineFactory;
  transcripts: TranscriptStore;
  recordings: RecordingStore | null;
  preferences: PreferencesStore;
  logger: Logger;
  now?: () => number;
  /** Seconds an outbound call may ring before it is dropped as unanswered. */
  outboundRingSeconds?: number;
}

interface ManagedOperator {
  id: string;
  name: string;
  role: OperatorRole;
  link: OperatorLink;
  preferences: OperatorPreferences;
  status: OperatorStatus;
  currentCallId: string | null;
  lastFreeAt: number;
}

interface Ringing {
  call: ChannelCall;
  record: CallRecord;
  tried: Set<string>;
  operatorId: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** The passenger hung up while it was ringing or being answered. */
  gone: boolean;
  offEnded: Unsubscribe;
}

interface PendingOutbound {
  call: ChannelCall;
  record: CallRecord;
  operatorId: string;
  settings: ReturnType<typeof languageSettingsFromPreferences>;
  timer: ReturnType<typeof setTimeout> | null;
  offs: Unsubscribe[];
}

export type ConnectResult = { ok: true; info: OperatorInfo } | { ok: false; code: 'already_connected' };

/**
 * Decides which operator gets which call and keeps the number of simultaneous calls under the limit.
 * Inbound calls go to the free operator who has been free the longest; each operator rings for
 * `ringTimeoutSeconds`, then the call moves on to the next one. All calls use the same company number.
 */
export class CallManager {
  private readonly operators = new Map<string, ManagedOperator>();
  private readonly ringing = new Map<string, Ringing>();
  private readonly pending = new Map<string, PendingOutbound>();
  private readonly sessions = new Map<string, CallSession>();
  private offIncoming: Unsubscribe | null = null;
  private stopped = false;

  constructor(private readonly deps: CallManagerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  start(): void {
    this.offIncoming = this.deps.channel.onIncoming((call) => void this.handleIncoming(call));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.offIncoming?.();
    for (const ringing of [...this.ringing.values()]) {
      this.clearRinging(ringing);
      await ringing.call.reject().catch(() => undefined);
    }
    for (const pending of [...this.pending.values()]) {
      if (pending.timer) clearTimeout(pending.timer);
      await pending.call.hangup().catch(() => undefined);
    }
    await Promise.allSettled([...this.sessions.values()].map(async (session) => {
      await session.hangupByOperator();
      await session.whenEnded();
    }));
  }

  get activeCalls(): number {
    return this.sessions.size + this.pending.size + this.ringing.size;
  }

  get maxCalls(): number {
    return this.deps.config.maxConcurrentCalls;
  }

  // ---------------------------------------------------------------------------
  // Operators
  // ---------------------------------------------------------------------------

  async connectOperator(account: { id: string; name: string; role: OperatorRole }, link: OperatorLink): Promise<ConnectResult> {
    if (this.operators.has(account.id)) return { ok: false, code: 'already_connected' };
    const preferences = await this.deps.preferences.get(account.id);
    if (this.operators.has(account.id)) return { ok: false, code: 'already_connected' };
    const operator: ManagedOperator = {
      id: account.id,
      name: account.name,
      role: account.role,
      link,
      preferences,
      status: 'available',
      currentCallId: null,
      lastFreeAt: this.now(),
    };
    this.operators.set(account.id, operator);
    this.broadcastPresence();
    return { ok: true, info: this.info(operator) };
  }

  /** Called when an operator's preferences change while connected. */
  async refreshPreferences(operatorId: string): Promise<void> {
    const operator = this.operators.get(operatorId);
    if (operator) operator.preferences = await this.deps.preferences.get(operatorId);
  }

  disconnectOperator(operatorId: string): void {
    const operator = this.operators.get(operatorId);
    if (!operator) return;
    const session = [...this.sessions.values()].find((candidate) => candidate.operatorId === operatorId);
    const pending = [...this.pending.values()].find((candidate) => candidate.operatorId === operatorId);
    const offered = [...this.ringing.values()].find((candidate) => candidate.operatorId === operatorId);
    this.operators.delete(operatorId);
    if (session) void session.hangupByOperator();
    if (pending) void pending.call.hangup();
    if (offered) {
      offered.tried.add(operatorId);
      this.clearTimer(offered);
      offered.operatorId = null;
      void this.offer(offered);
    }
    this.broadcastPresence();
  }

  operatorInfos(): OperatorInfo[] {
    return [...this.operators.values()].map((operator) => this.info(operator));
  }

  presenceMessage(): ServerMessage {
    return { type: 'presence', operators: this.operatorInfos(), activeCalls: this.activeCalls, maxCalls: this.maxCalls };
  }

  // ---------------------------------------------------------------------------
  // Inbound calls
  // ---------------------------------------------------------------------------

  private async handleIncoming(call: ChannelCall): Promise<void> {
    if (this.stopped) {
      await call.reject().catch(() => undefined);
      return;
    }
    const record = this.baseRecord(call, null);
    if (this.activeCalls >= this.maxCalls) {
      this.deps.logger.warn('Llamada rechazada: todas las líneas ocupadas', { callId: call.id });
      await this.rejectUnserved(call, record, 'busy');
      return;
    }
    const ringing: Ringing = {
      call,
      record,
      tried: new Set(),
      operatorId: null,
      timer: null,
      gone: false,
      offEnded: () => undefined,
    };
    ringing.offEnded = call.onEnded((end) => {
      ringing.gone = true;
      this.clearRinging(ringing);
      const operator = ringing.operatorId ? this.operators.get(ringing.operatorId) : undefined;
      if (operator) {
        this.release(operator);
        operator.link.send({ type: 'call.ended', callId: call.id, reason: end.reason, durationMs: 0 });
      }
      void this.saveEnded(record, end.reason);
      this.broadcastPresence();
    });
    this.ringing.set(call.id, ringing);
    await this.offer(ringing);
  }

  /** Offers the call to the next free operator, or gives up when there is none. */
  private async offer(ringing: Ringing): Promise<void> {
    if (ringing.gone || this.stopped) return;
    const candidate = [...this.operators.values()]
      .filter((operator) => operator.status === 'available' && !ringing.tried.has(operator.id))
      .sort((a, b) => a.lastFreeAt - b.lastFreeAt)[0];
    if (!candidate) {
      this.deps.logger.warn('Llamada sin operador disponible', { callId: ringing.call.id });
      this.clearRinging(ringing);
      await this.rejectUnserved(ringing.call, ringing.record, 'no_answer');
      return;
    }
    ringing.operatorId = candidate.id;
    candidate.status = 'ringing';
    candidate.currentCallId = ringing.call.id;
    const autoAccept = candidate.preferences.autoAccept || this.deps.config.autoAccept;
    candidate.link.send({
      type: 'call.incoming',
      callId: ringing.call.id,
      from: ringing.call.remoteNumber,
      ...(ringing.call.langHint ? { langHint: ringing.call.langHint } : {}),
      ringTimeoutSeconds: this.deps.config.ringTimeoutSeconds,
      autoAccept,
    });
    this.broadcastPresence();
    ringing.timer = setTimeout(() => this.onRingTimeout(ringing, candidate), this.deps.config.ringTimeoutSeconds * 1000);
    if (autoAccept) await this.accept(candidate.id, ringing.call.id);
  }

  private onRingTimeout(ringing: Ringing, operator: ManagedOperator): void {
    if (ringing.gone || ringing.operatorId !== operator.id) return;
    ringing.tried.add(operator.id);
    ringing.operatorId = null;
    ringing.timer = null;
    this.release(operator);
    operator.link.send({ type: 'call.ended', callId: ringing.call.id, reason: 'no_answer', durationMs: 0 });
    void this.offer(ringing);
  }

  async accept(operatorId: string, callId: string): Promise<void> {
    const operator = this.operators.get(operatorId);
    const ringing = this.ringing.get(callId);
    if (!operator) return;
    if (!ringing || ringing.operatorId !== operatorId) {
      this.sendError(operator, 'unknown_call', 'Esa llamada ya no está disponible', callId);
      return;
    }
    this.clearTimer(ringing);
    try {
      await ringing.call.answer();
    } catch (error) {
      this.deps.logger.error('No se pudo contestar la llamada', { callId, error: String(error) });
      this.sendError(operator, 'internal_error', 'No se pudo contestar la llamada', callId);
      ringing.tried.add(operatorId);
      ringing.operatorId = null;
      this.release(operator);
      await this.offer(ringing);
      return;
    }
    if (ringing.gone || !this.operators.has(operatorId)) {
      this.clearRinging(ringing);
      return;
    }
    this.clearRinging(ringing);
    operator.status = 'in_call';
    operator.currentCallId = callId;
    await this.startSession(operator, ringing.call, { ...ringing.record, operatorId }, languageSettingsFromPreferences(operator.preferences, this.deps.config.fallbackLang));
  }

  reject(operatorId: string, callId: string): void {
    const operator = this.operators.get(operatorId);
    const ringing = this.ringing.get(callId);
    if (!operator || !ringing || ringing.operatorId !== operatorId) return;
    this.clearTimer(ringing);
    ringing.tried.add(operatorId);
    ringing.operatorId = null;
    this.release(operator);
    void this.offer(ringing);
  }

  // ---------------------------------------------------------------------------
  // Outbound calls
  // ---------------------------------------------------------------------------

  async dial(operatorId: string, number: string, languages?: PartialLanguageSettings): Promise<void> {
    const operator = this.operators.get(operatorId);
    if (!operator) return;
    if (operator.status !== 'available') {
      this.sendError(operator, 'operator_busy', 'Ya estás en una llamada');
      return;
    }
    if (this.activeCalls >= this.maxCalls) {
      this.sendError(operator, 'max_calls_reached', 'Todas las líneas están ocupadas');
      return;
    }
    const can = await this.deps.channel.canDial(number);
    if (!can.allowed) {
      const code: ErrorCode =
        can.reason === 'permission_required' ? 'dial_permission_required' : can.reason === 'invalid_number' ? 'invalid_number' : 'dial_failed';
      this.sendError(operator, code, can.message ?? dialMessage(can.reason));
      return;
    }
    operator.status = 'ringing';
    this.broadcastPresence();
    let call: ChannelCall;
    try {
      call = await this.deps.channel.dial(number);
    } catch (error) {
      this.deps.logger.error('No se pudo marcar', { error: String(error) });
      this.release(operator);
      this.sendError(operator, 'dial_failed', 'No se pudo realizar la llamada');
      return;
    }
    const base = languageSettingsFromPreferences(operator.preferences, this.deps.config.fallbackLang);
    const settings = languages ? mergeLanguageSettings(base, languages) : base;
    const record = this.baseRecord(call, operatorId);
    const pending: PendingOutbound = { call, record, operatorId, settings, timer: null, offs: [] };
    this.pending.set(call.id, pending);
    operator.currentCallId = call.id;
    operator.link.send({
      type: 'call.state',
      callId: call.id,
      state: 'ringing',
      direction: 'outbound',
      remoteNumber: call.remoteNumber,
      answeredAt: null,
      muted: false,
      simulated: this.deps.channel.simulated,
    });
    pending.offs.push(
      call.onAnswered(() => {
        this.clearPending(pending);
        if (!this.operators.has(operatorId)) {
          void call.hangup();
          return;
        }
        operator.status = 'in_call';
        void this.startSession(operator, call, record, settings);
      }),
      call.onEnded((end) => {
        this.clearPending(pending);
        if (this.sessions.has(call.id)) return;
        this.release(operator);
        operator.link.send({ type: 'call.ended', callId: call.id, reason: end.reason, durationMs: 0 });
        void this.saveEnded(record, end.reason);
        this.broadcastPresence();
      }),
    );
    pending.timer = setTimeout(() => {
      void call.hangup().then(() => undefined);
    }, (this.deps.outboundRingSeconds ?? 60) * 1000);
    this.broadcastPresence();
  }

  // ---------------------------------------------------------------------------
  // Active calls
  // ---------------------------------------------------------------------------

  hangup(operatorId: string, callId: string): void {
    const session = this.sessions.get(callId);
    if (session && session.operatorId === operatorId) {
      void session.hangupByOperator();
      return;
    }
    const pending = this.pending.get(callId);
    if (pending && pending.operatorId === operatorId) void pending.call.hangup();
  }

  setLanguages(operatorId: string, callId: string, patch: PartialLanguageSettings): void {
    this.ownedSession(operatorId, callId)?.setLanguages(patch);
  }

  mute(operatorId: string, callId: string, muted: boolean): void {
    this.ownedSession(operatorId, callId)?.setMuted(muted);
  }

  pushOperatorAudio(operatorId: string, pcm: PcmChunk): void {
    const operator = this.operators.get(operatorId);
    if (!operator?.currentCallId) return;
    this.sessions.get(operator.currentCallId)?.pushOperatorAudio(pcm);
  }

  /** The session of the operator's current call, if there is one. */
  sessionOf(operatorId: string): CallSession | undefined {
    const operator = this.operators.get(operatorId);
    return operator?.currentCallId ? this.sessions.get(operator.currentCallId) : undefined;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private ownedSession(operatorId: string, callId: string): CallSession | undefined {
    const session = this.sessions.get(callId);
    if (session && session.operatorId === operatorId) return session;
    const operator = this.operators.get(operatorId);
    if (operator) this.sendError(operator, 'unknown_call', 'No hay una llamada activa con ese identificador', callId);
    return undefined;
  }

  private async startSession(
    operator: ManagedOperator,
    call: ChannelCall,
    record: CallRecord,
    settings: ReturnType<typeof languageSettingsFromPreferences>,
  ): Promise<void> {
    const session = new CallSession({
      call,
      operatorId: operator.id,
      link: operator.link,
      settings,
      pipelines: this.deps.pipelines,
      transcripts: this.deps.transcripts,
      recordings: this.deps.recordings,
      logger: this.deps.logger,
      simulated: this.deps.channel.simulated,
      record,
      ...(this.deps.now ? { now: this.deps.now } : {}),
      onEnded: ({ callId }) => {
        this.sessions.delete(callId);
        const current = this.operators.get(operator.id);
        if (current) this.release(current);
        this.broadcastPresence();
      },
    });
    this.sessions.set(call.id, session);
    this.broadcastPresence();
    try {
      await session.start();
    } catch (error) {
      this.deps.logger.error('No se pudo iniciar la sesión de llamada', { callId: call.id, error: String(error) });
      this.sendError(operator, 'internal_error', 'No se pudo iniciar la traducción de la llamada', call.id);
      await call.hangup().catch(() => undefined);
    }
  }

  private release(operator: ManagedOperator): void {
    operator.status = 'available';
    operator.currentCallId = null;
    operator.lastFreeAt = this.now();
  }

  private clearTimer(ringing: Ringing): void {
    if (ringing.timer) clearTimeout(ringing.timer);
    ringing.timer = null;
  }

  private clearRinging(ringing: Ringing): void {
    this.clearTimer(ringing);
    ringing.offEnded();
    this.ringing.delete(ringing.call.id);
  }

  private clearPending(pending: PendingOutbound): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    for (const off of pending.offs) off();
    pending.offs = [];
    this.pending.delete(pending.call.id);
  }

  private async rejectUnserved(call: ChannelCall, record: CallRecord, reason: CallEndReason): Promise<void> {
    await call.reject().catch(() => undefined);
    await this.saveEnded(record, reason);
    this.broadcastPresence();
  }

  private async saveEnded(record: CallRecord, reason: CallEndReason): Promise<void> {
    const endedAt = this.now();
    await this.deps.transcripts
      .saveCall({ ...record, state: 'ended', endedAt, endReason: reason })
      .catch((error: unknown) => this.deps.logger.error('No se pudo guardar la llamada', { error: String(error) }));
  }

  private baseRecord(call: ChannelCall, operatorId: string | null): CallRecord {
    return {
      id: call.id,
      direction: call.direction,
      remoteNumber: call.remoteNumber,
      operatorId,
      passengerLang: normalizeLanguageCode(call.langHint),
      state: call.direction === 'inbound' ? 'ringing' : 'dialing',
      createdAt: this.now(),
      answeredAt: null,
      endedAt: null,
      endReason: null,
      recorded: false,
    };
  }

  private info(operator: ManagedOperator): OperatorInfo {
    return {
      id: operator.id,
      name: operator.name,
      role: operator.role,
      status: operator.status,
      currentCallId: operator.currentCallId,
      autoAccept: operator.preferences.autoAccept || this.deps.config.autoAccept,
    };
  }

  private broadcastPresence(): void {
    const message = this.presenceMessage();
    for (const operator of this.operators.values()) operator.link.send(message);
  }

  private sendError(operator: ManagedOperator, code: ErrorCode, message: string, callId?: string): void {
    operator.link.send({ type: 'error', code, message, ...(callId ? { callId } : {}) });
  }
}

function dialMessage(reason: 'permission_required' | 'invalid_number' | 'unsupported' | 'unavailable'): string {
  switch (reason) {
    case 'permission_required':
      return 'El pasajero tiene que dar permiso antes de recibir llamadas de este canal.';
    case 'invalid_number':
      return 'El número no es válido.';
    case 'unsupported':
      return 'Este canal no permite llamadas salientes.';
    case 'unavailable':
      return 'El canal no está disponible ahora mismo.';
  }
}
