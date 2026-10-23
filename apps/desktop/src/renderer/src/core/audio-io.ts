import { INTERNAL_SAMPLE_RATE, Resampler, float32ToPcm16, msToBytes, pcm16ToFloat32 } from '@tw/shared';

/** Browser audio the call client depends on. Tests replace it with a fake. */
export interface MicHandle {
  stop(): void;
}

export interface Playback {
  /** Queues PCM16 16 kHz mono for gapless playback. */
  play(pcm: Uint8Array): void;
  setVolume(volume: number): void;
  /**
   * Routes this playback to an output device. Rejects with a `PlaybackError` when the runtime cannot
   * choose outputs (`AudioContext.setSinkId` missing) or the device does not exist.
   */
  setSink(deviceId: string): Promise<void>;
  /** Drops what is queued and stops. */
  stop(): void;
}

export class MicError extends Error {
  constructor(
    readonly reason: 'denied' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

export class PlaybackError extends Error {
  constructor(
    readonly reason: 'unsupported' | 'not_found' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

export interface CaptureOptions {
  /** Input device; the system default when omitted. */
  deviceId?: string;
  /** Called once if the device stops on its own (unplugged, revoked); never after `stop()`. */
  onEnded?: () => void;
  /**
   * `true` (operator microphone): echo cancellation, noise suppression and automatic gain.
   * `false` (a virtual cable): the signal is taken as it is; processing would mangle another program's audio.
   */
  processing: boolean;
}

export interface AudioIO {
  /** Starts the operator microphone; `onPcm` receives PCM16 16 kHz mono in 20 ms chunks (the same samples that are sent). */
  startMic(onPcm: (pcm: Uint8Array) => void, deviceId?: string, onEnded?: () => void): Promise<MicHandle>;
  /** Captures any input device, with or without voice processing (see `CaptureOptions`). */
  startCapture(onPcm: (pcm: Uint8Array) => void, options: CaptureOptions): Promise<MicHandle>;
  /** The operator's headphones. */
  readonly playback: Playback;
  /** A second, independent output (its own `AudioContext`), e.g. the virtual cable another program listens to. */
  createPlayback(): Playback;
}

const FRAME_BYTES = msToBytes(20);

type SinkCapableContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

/** True when this runtime lets an `AudioContext` choose its output device. */
export function supportsOutputSelection(): boolean {
  if (typeof AudioContext === 'undefined') return false;
  return typeof (AudioContext.prototype as { setSinkId?: unknown }).setSinkId === 'function';
}

function sinkError(error: unknown, deviceId: string): PlaybackError {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotFoundError') {
    return new PlaybackError('not_found', `No se encuentra el dispositivo de salida elegido (${deviceId.slice(0, 8)}…). Vuelve a elegirlo en Ajustes > Audio.`);
  }
  return new PlaybackError('failed', 'No se pudo usar el dispositivo de salida elegido.');
}

/**
 * Gapless PCM playback on one `AudioContext`. `eagerSink` (virtual cable): `setSink` opens the context
 * at once and fails if the device cannot be used, so a call never starts "playing" into nowhere. Without
 * it (operator headphones) the sink is applied when the context is first needed.
 */
class WebAudioPlayback implements Playback {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private nextTime = 0;
  private volume = 1;
  private sinkId: string | null = null;
  private readonly sources = new Set<AudioBufferSourceNode>();

  constructor(private readonly eagerSink: boolean) {}

  play(pcm: Uint8Array): void {
    if (pcm.byteLength < 2) return;
    const context = this.ensureContext();
    if (context.state === 'suspended') void context.resume();
    const samples = pcm16ToFloat32(pcm);
    const buffer = context.createBuffer(1, samples.length, INTERNAL_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain!);
    // Small lead on the first chunk (and after an underrun) so consecutive chunks join without gaps.
    const startAt = Math.max(context.currentTime + 0.06, this.nextTime);
    source.start(startAt);
    this.nextTime = startAt + samples.length / INTERNAL_SAMPLE_RATE;
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  async setSink(deviceId: string): Promise<void> {
    if (!supportsOutputSelection()) {
      throw new PlaybackError('unsupported', 'Este equipo no permite elegir el dispositivo de salida de audio (falta AudioContext.setSinkId).');
    }
    this.sinkId = deviceId;
    const context = (this.context ?? (this.eagerSink ? this.ensureContext() : null)) as SinkCapableContext | null;
    if (!context?.setSinkId) return;
    try {
      await context.setSinkId(deviceId);
    } catch (error) {
      throw sinkError(error, deviceId);
    }
  }

  stop(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.nextTime = 0;
  }

  /** Stops and releases the context (second outputs are closed when the call ends). */
  close(): void {
    this.stop();
    const context = this.context;
    this.context = null;
    this.gain = null;
    if (context) void context.close().catch(() => undefined);
  }

  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' });
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.context.destination);
      const pending = this.sinkId;
      const context = this.context as SinkCapableContext;
      if (pending && context.setSinkId) void context.setSinkId(pending).catch(() => undefined);
    }
    return this.context;
  }
}

/** Real implementation on Web Audio: getUserMedia (with or without voice processing) and an AudioWorklet for capture. */
export class BrowserAudioIO implements AudioIO {
  readonly playback: Playback = new WebAudioPlayback(false);

  createPlayback(): Playback {
    const playback = new WebAudioPlayback(true);
    // `stop` on a secondary output also releases its AudioContext: nothing keeps a cable open after the call.
    return {
      play: (pcm) => playback.play(pcm),
      setVolume: (volume) => playback.setVolume(volume),
      setSink: (deviceId) => playback.setSink(deviceId),
      stop: () => playback.close(),
    };
  }

  startMic(onPcm: (pcm: Uint8Array) => void, deviceId?: string, onEnded?: () => void): Promise<MicHandle> {
    return this.startCapture(onPcm, { processing: true, ...(deviceId ? { deviceId } : {}), ...(onEnded ? { onEnded } : {}) });
  }

  async startCapture(onPcm: (pcm: Uint8Array) => void, options: CaptureOptions): Promise<MicHandle> {
    if (!navigator.mediaDevices?.getUserMedia) throw new MicError('unavailable', 'Este equipo no permite capturar audio');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: options.processing,
          noiseSuppression: options.processing,
          autoGainControl: options.processing,
          ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
        },
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') throw new MicError('denied', 'No hay permiso para usar el micrófono');
      if (options.deviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
        throw new MicError('unavailable', 'No se encuentra el dispositivo de entrada elegido');
      }
      throw new MicError('unavailable', 'No se encontró ningún micrófono');
    }

    const context = new AudioContext({ latencyHint: 'interactive' });
    try {
      await context.audioWorklet.addModule(new URL('mic-worklet.js', document.baseURI).href);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      await context.close();
      throw new MicError('unavailable', 'No se pudo preparar la captura de audio');
    }
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'tw-mic', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute);
    mute.connect(context.destination);

    const resampler = new Resampler(context.sampleRate, INTERNAL_SAMPLE_RATE);
    let pending = new Uint8Array(0);
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const converted = resampler.process(float32ToPcm16(event.data));
      const joined = new Uint8Array(pending.byteLength + converted.byteLength);
      joined.set(pending, 0);
      joined.set(converted, pending.byteLength);
      let offset = 0;
      while (joined.byteLength - offset >= FRAME_BYTES) {
        onPcm(joined.slice(offset, offset + FRAME_BYTES));
        offset += FRAME_BYTES;
      }
      pending = joined.slice(offset);
    };

    let stopped = false;
    // A device that disappears mid-call (unplugged, permission revoked) ends its track on its own.
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (!stopped) options.onEnded?.();
      });
    }

    return {
      stop: () => {
        stopped = true;
        node.port.onmessage = null;
        source.disconnect();
        node.disconnect();
        stream.getTracks().forEach((track) => track.stop());
        void context.close();
      },
    };
  }
}
