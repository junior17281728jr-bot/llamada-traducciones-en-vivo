import { INTERNAL_SAMPLE_RATE, Resampler, float32ToPcm16, msToBytes, pcm16ToFloat32 } from '@tw/shared';

/** Browser audio the call client depends on. Tests replace it with a fake. */
export interface MicHandle {
  stop(): void;
}

export interface Playback {
  /** Queues PCM16 16 kHz mono for gapless playback. */
  play(pcm: Uint8Array): void;
  setVolume(volume: number): void;
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

export interface AudioIO {
  /** Starts the microphone; `onPcm` receives PCM16 16 kHz mono in 20 ms chunks (the same samples that are sent). */
  startMic(onPcm: (pcm: Uint8Array) => void, deviceId?: string): Promise<MicHandle>;
  readonly playback: Playback;
}

const FRAME_BYTES = msToBytes(20);

/** Real implementation on Web Audio: getUserMedia with echo cancellation, an AudioWorklet for capture. */
export class BrowserAudioIO implements AudioIO {
  private playbackContext: AudioContext | null = null;
  private gain: GainNode | null = null;
  private nextTime = 0;
  private volume = 1;
  private sinkId: string | null = null;
  private readonly sources = new Set<AudioBufferSourceNode>();

  readonly playback: Playback = {
    play: (pcm) => this.play(pcm),
    setVolume: (volume) => {
      this.volume = Math.min(1, Math.max(0, volume));
      if (this.gain) this.gain.gain.value = this.volume;
    },
    setSink: async (deviceId) => {
      this.sinkId = deviceId;
      const context = this.playbackContext as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
      if (context?.setSinkId) await context.setSinkId(deviceId);
    },
    stop: () => {
      for (const source of this.sources) {
        try {
          source.stop();
        } catch {
          /* already stopped */
        }
      }
      this.sources.clear();
      this.nextTime = 0;
    },
  };

  async startMic(onPcm: (pcm: Uint8Array) => void, deviceId?: string): Promise<MicHandle> {
    if (!navigator.mediaDevices?.getUserMedia) throw new MicError('unavailable', 'Este equipo no permite usar el micrófono');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') throw new MicError('denied', 'No hay permiso para usar el micrófono');
      throw new MicError('unavailable', 'No se encontró ningún micrófono');
    }

    const context = new AudioContext({ latencyHint: 'interactive' });
    try {
      await context.audioWorklet.addModule(new URL('mic-worklet.js', document.baseURI).href);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      await context.close();
      throw new MicError('unavailable', 'No se pudo preparar la captura del micrófono');
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

    return {
      stop: () => {
        node.port.onmessage = null;
        source.disconnect();
        node.disconnect();
        stream.getTracks().forEach((track) => track.stop());
        void context.close();
      },
    };
  }

  private ensurePlayback(): AudioContext {
    if (!this.playbackContext) {
      this.playbackContext = new AudioContext({ latencyHint: 'interactive' });
      this.gain = this.playbackContext.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.playbackContext.destination);
      if (this.sinkId) void this.playback.setSink(this.sinkId);
    }
    return this.playbackContext;
  }

  private play(pcm: Uint8Array): void {
    if (pcm.byteLength < 2) return;
    const context = this.ensurePlayback();
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
}
