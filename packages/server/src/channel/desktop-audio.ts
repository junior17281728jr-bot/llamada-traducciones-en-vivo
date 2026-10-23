import { randomUUID } from 'node:crypto';
import { Emitter } from '@tw/pipeline';
import type {
  CallChannel,
  CallEndReason,
  CanDialResult,
  ChannelCall,
  ChannelCallEnd,
  PcmChunk,
  Unsubscribe,
} from '@tw/shared';

/**
 * "Modo audio del PC": the call happens in another program on the operator's computer (e.g. WhatsApp
 * Desktop) and only its AUDIO reaches us, through virtual audio cables. The desktop app captures the
 * cable that carries the other program's output (the passenger) and sends it as `PassengerLocal`
 * frames; the operator's translated voice goes back as `TranslatedToPassenger` frames, which the app
 * plays into the cable the other program uses as microphone.
 *
 * Nothing here is a telephone line: there are no incoming calls, nothing can be dialed, and the call is
 * answered and hung up by hand in the other program. UNVERIFIED with real WhatsApp and real cables:
 * only exercised with synthetic audio over the operator WebSocket.
 */

export interface StartLocalCallOptions {
  operatorId: string;
  /** What the history shows instead of a phone number (e.g. "WhatsApp"). */
  label: string;
  /** Passenger language the operator chose before starting, if any. */
  langHint?: string;
  /** Receives the operator's translated voice; the manager relays it to the app as `TranslatedToPassenger`. */
  onToPassenger: (pcm: PcmChunk) => void;
}

/** What the call manager needs from the desktop-audio channel. */
export interface LocalCallChannel {
  readonly simulated: boolean;
  startLocalCall(options: StartLocalCallOptions): DesktopAudioCall;
}

const NO_DIAL_MESSAGE =
  'Este servidor no tiene línea telefónica: en el modo audio del PC la llamada se hace y se contesta en el otro programa (por ejemplo WhatsApp) y aquí solo se traduce su audio.';

export class DesktopAudioChannel implements CallChannel, LocalCallChannel {
  readonly kind = 'desktop-audio' as const;
  /** Real audio from the operator's computer, not a simulator. */
  readonly simulated = false;

  private readonly calls = new Set<DesktopAudioCall>();
  private stopped = false;

  start(): Promise<void> {
    this.stopped = false;
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.calls].map((call) => call._end('server_shutdown')));
    this.calls.clear();
  }

  /** Local calls never "enter": the operator starts them from the app. The handler is never called. */
  onIncoming(_handler: (call: ChannelCall) => void): Unsubscribe {
    return () => undefined;
  }

  canDial(_number: string): Promise<CanDialResult> {
    return Promise.resolve({ allowed: false, reason: 'unsupported', message: NO_DIAL_MESSAGE });
  }

  dial(_number: string): Promise<ChannelCall> {
    return Promise.reject(new Error(NO_DIAL_MESSAGE));
  }

  /** Number of local calls in progress (for tests and diagnostics). */
  get activeCalls(): number {
    return this.calls.size;
  }

  /** Creates a local call. It is already "ringing" from our side: the manager answers it at once. */
  startLocalCall(options: StartLocalCallOptions): DesktopAudioCall {
    if (this.stopped) throw new Error('El canal de audio del PC está detenido');
    const call = new DesktopAudioCall(options, () => this.calls.delete(call));
    this.calls.add(call);
    return call;
  }
}

/** One translated session fed by the operator's computer. `remoteNumber` is the label chosen by the operator. */
export class DesktopAudioCall implements ChannelCall {
  readonly id = randomUUID();
  readonly direction = 'local' as const;
  readonly remoteNumber: string;
  readonly langHint?: string;
  readonly operatorId: string;

  private readonly audio = new Emitter<PcmChunk>();
  private readonly answered = new Emitter<void>();
  private readonly endedHub = new Emitter<ChannelCallEnd>();
  private isActive = false;
  private isEnded = false;

  constructor(
    private readonly options: StartLocalCallOptions,
    private readonly onForget: () => void,
  ) {
    this.remoteNumber = options.label;
    this.operatorId = options.operatorId;
    if (options.langHint) this.langHint = options.langHint;
  }

  get active(): boolean {
    return this.isActive;
  }

  get ended(): boolean {
    return this.isEnded;
  }

  /** Immediate: there is nobody to pick up, the other program already has the call. */
  answer(): Promise<void> {
    if (!this.isActive && !this.isEnded) {
      this.isActive = true;
      this.answered.emit();
    }
    return Promise.resolve();
  }

  reject(): Promise<void> {
    return this._end('cancelled');
  }

  hangup(): Promise<void> {
    return this._end('hangup_operator');
  }

  /** Operator voice translated for the passenger: goes back to the app, to be played into the cable. */
  sendAudio(pcm: PcmChunk): void {
    if (this.isActive && !this.isEnded) this.options.onToPassenger(pcm);
  }

  /** Passenger audio captured by the app from the cable (`PassengerLocal` frames). Dropped before answer or after the end. */
  pushPassengerAudio(pcm: PcmChunk): void {
    if (this.isActive && !this.isEnded) this.audio.emit(pcm);
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
  _end(reason: CallEndReason): Promise<void> {
    if (this.isEnded) return Promise.resolve();
    this.isEnded = true;
    this.isActive = false;
    this.endedHub.emit({ reason });
    this.audio.clear();
    this.answered.clear();
    this.endedHub.clear();
    this.onForget();
    return Promise.resolve();
  }
}
