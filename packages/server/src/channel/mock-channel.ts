import { randomUUID } from 'node:crypto';
import {
  INTERNAL_BYTES_PER_SECOND,
  base64ToPcm16,
  msToBytes,
  pcm16ToBase64,
  silencePcm16,
  synthesizeSpeechSignal,
  type CallChannel,
  type CallEndReason,
  type CanDialResult,
  type ChannelCall,
  type ChannelCallEnd,
  type Direction,
  type PcmChunk,
  type Unsubscribe,
} from '@tw/shared';

type Handler<T> = (value: T) => void;

class Hub<T> {
  private readonly handlers = new Set<Handler<T>>();
  on(handler: Handler<T>): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
  emit(value: T): void {
    for (const handler of [...this.handlers]) handler(value);
  }
  clear(): void {
    this.handlers.clear();
  }
}

export interface MockChannelOptions {
  /** 1 = real time. Tests raise it so a phrase of several seconds takes milliseconds. */
  speed?: number;
  /** Longest simulated audio queued per call (the simulated phone cannot get ahead of real time by more than this). */
  maxQueuedMs?: number;
}

export interface MockUtterance {
  callId: string;
  text: string;
  lang: string;
}

const FRAME_MS = 20;
const FRAME_BYTES = msToBytes(FRAME_MS);
const PASSENGER_PITCH_HZ = 200;
const PHONE_NUMBER = /^\+?[0-9 ()\-.]{3,32}$/;

/**
 * SIMULATED channel: passengers are fake phones (`MockPhone`) driven from code or from the WebSocket
 * simulator. The audio is synthetic (speech-like tones, digital silence between phrases) so waveforms
 * move exactly when a simulated passenger "speaks". Nothing here is a real telephone line.
 */
export class MockCallChannel implements CallChannel {
  readonly kind = 'mock' as const;
  readonly simulated = true;

  private readonly incoming = new Hub<ChannelCall>();
  private readonly utterances = new Hub<MockUtterance>();
  private readonly phones = new Set<MockPhone>();
  private started = false;

  constructor(readonly options: MockChannelOptions = {}) {}

  start(): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    this.started = false;
    await Promise.all([...this.phones].map((phone) => phone.hangup('server_shutdown')));
    this.phones.clear();
    this.incoming.clear();
    this.utterances.clear();
  }

  onIncoming(handler: (call: ChannelCall) => void): Unsubscribe {
    return this.incoming.on(handler);
  }

  /** Server wiring: the text of what a simulated passenger says (the simulated STT needs it out of band). */
  onUtterance(handler: (utterance: MockUtterance) => void): Unsubscribe {
    return this.utterances.on(handler);
  }

  canDial(number: string): Promise<CanDialResult> {
    if (!PHONE_NUMBER.test(number.trim())) return Promise.resolve({ allowed: false, reason: 'invalid_number' });
    if (![...this.phones].some((phone) => phone.isListening())) {
      return Promise.resolve({
        allowed: false,
        reason: 'unavailable',
        message: 'No hay ningún pasajero simulado escuchando. Arranca uno con el simulador (comando "escuchar").',
      });
    }
    return Promise.resolve({ allowed: true });
  }

  dial(number: string): Promise<ChannelCall> {
    const phone = [...this.phones].find((candidate) => candidate.isListening());
    if (!phone) return Promise.reject(new Error('No hay ningún pasajero simulado escuchando'));
    return Promise.resolve(phone.receiveCall(number.trim()));
  }

  /** Makes the simulated passenger of `callId` say `text` (used by the `debug.say` message). */
  sayAsPassenger(callId: string, text: string, lang: string): boolean {
    const phone = [...this.phones].find((candidate) => candidate.call?.id === callId && candidate.call.active);
    if (!phone) return false;
    phone.say(text, lang);
    return true;
  }

  /** Creates a simulated phone. The WebSocket simulator creates one per socket. */
  createPhone(): MockPhone {
    const phone = new MockPhone(this);
    this.phones.add(phone);
    return phone;
  }

  /** @internal */
  _emitIncoming(call: MockChannelCall): void {
    this.incoming.emit(call);
  }

  /** @internal */
  _emitUtterance(utterance: MockUtterance): void {
    this.utterances.emit(utterance);
  }

  /** @internal */
  _forget(phone: MockPhone): void {
    this.phones.delete(phone);
  }

  /** @internal */
  get _isStarted(): boolean {
    return this.started;
  }
}

export interface PhoneState {
  state: 'ringing' | 'active' | 'ended' | 'idle';
  callId: string | null;
  direction?: Direction;
  remoteNumber?: string;
  reason?: CallEndReason;
}

/** One simulated passenger phone. */
export class MockPhone {
  private readonly heard = new Hub<PcmChunk>();
  private readonly states = new Hub<PhoneState>();
  private listening: string | null = null;
  private current: MockChannelCall | null = null;

  constructor(private readonly channel: MockCallChannel) {}

  get call(): MockChannelCall | null {
    return this.current;
  }

  isListening(): boolean {
    return this.listening !== null && (this.current === null || this.current.ended);
  }

  /** What the passenger hears (the operator's translated voice). */
  onHeard(handler: (pcm: PcmChunk) => void): Unsubscribe {
    return this.heard.on(handler);
  }

  onState(handler: (state: PhoneState) => void): Unsubscribe {
    return this.states.on(handler);
  }

  /** The passenger calls in. The call rings until an operator (or the server) answers it. */
  incoming(from: string, lang: string): MockChannelCall {
    if (this.current && !this.current.ended) throw new Error('Este teléfono simulado ya tiene una llamada');
    const call = new MockChannelCall(this, 'inbound', from, lang);
    this.current = call;
    this.states.emit({ state: 'ringing', callId: call.id, direction: 'inbound', remoteNumber: from });
    this.channel._emitIncoming(call);
    return call;
  }

  /** Idle phone: the next outbound call dialed by an operator rings here. */
  listen(lang: string): void {
    this.listening = lang;
  }

  /** @internal */
  receiveCall(number: string): MockChannelCall {
    const call = new MockChannelCall(this, 'outbound', number, this.listening ?? undefined);
    this.current = call;
    this.states.emit({ state: 'ringing', callId: call.id, direction: 'outbound', remoteNumber: number });
    return call;
  }

  /** Picks up an outbound call that is ringing here. */
  answer(): void {
    if (this.current?.direction === 'outbound') this.current._markAnswered();
  }

  /** The passenger says `text`: synthetic speech-like audio plus the text for the simulated STT. */
  say(text: string, lang: string, audio?: PcmChunk): void {
    const call = this.current;
    if (!call || call.ended || !call.active) throw new Error('No hay una llamada activa en este teléfono simulado');
    const signal = audio ?? synthesizeSpeechSignal(text, { pitchHz: PASSENGER_PITCH_HZ });
    this.channel._emitUtterance({ callId: call.id, text, lang });
    call._queueAudio(signal);
  }

  /** Continuous audio from the simulator (may include digital silence). */
  pushAudio(pcm: PcmChunk): void {
    this.current?._queueAudio(pcm);
  }

  async hangup(reason: CallEndReason = 'hangup_passenger'): Promise<void> {
    await this.current?._end(reason);
  }

  /** @internal */
  _heard(pcm: PcmChunk): void {
    this.heard.emit(pcm);
  }

  /** @internal */
  _state(state: PhoneState): void {
    this.states.emit(state);
  }

  async dispose(): Promise<void> {
    await this.hangup('hangup_passenger');
    this.listening = null;
    this.heard.clear();
    this.states.clear();
    this.channel._forget(this);
  }

  get speed(): number {
    return this.channel.options.speed ?? 1;
  }

  get maxQueuedMs(): number {
    return this.channel.options.maxQueuedMs ?? 60_000;
  }
}

export class MockChannelCall implements ChannelCall {
  readonly id = randomUUID();
  private readonly audio = new Hub<PcmChunk>();
  private readonly answered = new Hub<void>();
  private readonly endedHub = new Hub<ChannelCallEnd>();
  private queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private isActive = false;
  private isEnded = false;

  constructor(
    private readonly phone: MockPhone,
    readonly direction: Direction,
    readonly remoteNumber: string,
    readonly langHint?: string,
  ) {}

  get active(): boolean {
    return this.isActive;
  }

  get ended(): boolean {
    return this.isEnded;
  }

  answer(): Promise<void> {
    if (this.direction === 'inbound') this._markAnswered();
    return Promise.resolve();
  }

  reject(): Promise<void> {
    return this._end('rejected');
  }

  hangup(): Promise<void> {
    return this._end('hangup_operator');
  }

  sendAudio(pcm: PcmChunk): void {
    if (this.isActive && !this.isEnded) this.phone._heard(pcm);
  }

  onAudio(handler: (pcm: PcmChunk) => void): Unsubscribe {
    return this.audio.on(handler);
  }

  onAnswered(handler: () => void): Unsubscribe {
    return this.answered.on(handler);
  }

  onEnded(handler: (end: ChannelCallEnd) => void): Unsubscribe {
    return this.endedHub.on(handler);
  }

  /** @internal */
  _markAnswered(): void {
    if (this.isActive || this.isEnded) return;
    this.isActive = true;
    this.phone._state({ state: 'active', callId: this.id, direction: this.direction, remoteNumber: this.remoteNumber });
    this.timer = setInterval(() => this.tick(), Math.max(1, FRAME_MS / this.phone.speed));
    this.answered.emit();
  }

  /** @internal */
  _queueAudio(pcm: PcmChunk): void {
    if (this.isEnded) return;
    const maxBytes = (this.phone.maxQueuedMs / 1000) * INTERNAL_BYTES_PER_SECOND;
    if (this.queuedBytes + pcm.byteLength > maxBytes) return;
    this.queue.push(pcm);
    this.queuedBytes += pcm.byteLength;
  }

  /** @internal */
  async _end(reason: CallEndReason): Promise<void> {
    if (this.isEnded) return;
    this.isEnded = true;
    this.isActive = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue = [];
    this.phone._state({ state: 'ended', callId: this.id, direction: this.direction, remoteNumber: this.remoteNumber, reason });
    this.endedHub.emit({ reason });
    this.audio.clear();
    this.answered.clear();
    this.endedHub.clear();
  }

  /** Emits exactly one 20 ms frame per tick: queued speech if there is some, digital silence otherwise. */
  private tick(): void {
    if (this.isEnded) return;
    let frame: Uint8Array;
    if (this.queuedBytes > 0) {
      frame = this.takeFrame();
    } else {
      frame = silencePcm16(FRAME_MS);
    }
    this.audio.emit(frame);
  }

  private takeFrame(): Uint8Array {
    const out = new Uint8Array(FRAME_BYTES);
    let filled = 0;
    while (filled < FRAME_BYTES && this.queue.length > 0) {
      const head = this.queue[0]!;
      const take = Math.min(head.byteLength, FRAME_BYTES - filled);
      out.set(head.subarray(0, take), filled);
      filled += take;
      this.queuedBytes -= take;
      if (take === head.byteLength) this.queue.shift();
      else this.queue[0] = head.subarray(take);
    }
    return out;
  }
}

/** Helper for the WebSocket simulator: encodes what the passenger hears. */
export const encodeHeard = (pcm: PcmChunk): string => pcm16ToBase64(pcm);
export const decodeSimAudio = (base64: string): Uint8Array => base64ToPcm16(base64);
