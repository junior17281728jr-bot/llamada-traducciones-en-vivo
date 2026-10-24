import { msToBytes, normalizeLanguageCode, type PcmChunk, type TtsProvider, type TtsSession, type TtsSessionOptions, type Unsubscribe } from '@tw/shared';
import { Emitter } from '../util/emitter.js';
import { SystemVoiceError, type SystemVoiceEngine } from './engines.js';

export interface SystemTtsOptions {
  /** Size of the audio chunks emitted. */
  chunkMs?: number;
}

/**
 * Text to speech with the computer's own voice (plan B when ElevenLabs fails). Each `flush` synthesises
 * everything queued in one go, then emits it in small chunks. Not streaming: the first audio arrives when
 * the whole phrase is ready (a few hundred milliseconds on a normal computer).
 */
export class SystemTtsProvider implements TtsProvider {
  readonly simulated = false;

  constructor(
    readonly engine: SystemVoiceEngine,
    private readonly options: SystemTtsOptions = {},
  ) {}

  openSession(options: TtsSessionOptions): Promise<TtsSession> {
    if (this.engine.platform === 'none') {
      return Promise.reject(new SystemVoiceError('unsupported', 'Este sistema no tiene voz del ordenador (solo Mac y Windows)'));
    }
    return Promise.resolve(new SystemTtsSession(options.lang, this.engine, this.options.chunkMs ?? 100));
  }
}

class SystemTtsSession implements TtsSession {
  private readonly audio = new Emitter<PcmChunk>();
  private readonly done = new Emitter<void>();
  private readonly errors = new Emitter<Error>();
  private queued: string[] = [];
  private generation = 0;
  private closed = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    readonly lang: string,
    private readonly engine: SystemVoiceEngine,
    private readonly chunkMs: number,
  ) {}

  speak(text: string): void {
    if (text.trim()) this.queued.push(text.trim());
  }

  flush(): void {
    if (this.closed) return;
    const text = this.queued.join(' ');
    this.queued = [];
    const generation = this.generation;
    this.chain = this.chain.then(() => this.run(text, generation));
  }

  cancel(): void {
    this.generation += 1;
    this.queued = [];
  }

  async prewarm(): Promise<void> {
    await this.engine.voices();
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

  close(): Promise<void> {
    this.closed = true;
    this.cancel();
    this.audio.clear();
    this.done.clear();
    this.errors.clear();
    return Promise.resolve();
  }

  private async run(text: string, generation: number): Promise<void> {
    const current = (): boolean => !this.closed && generation === this.generation;
    if (!text) {
      if (current()) this.done.emit();
      return;
    }
    const lang = normalizeLanguageCode(this.lang);
    try {
      if (!lang) throw new SystemVoiceError('no_voice', `«${this.lang}» no es un idioma conocido`);
      const pcm = await this.engine.synthesize(text, lang);
      if (!current()) return;
      const step = Math.max(2, msToBytes(this.chunkMs));
      for (let offset = 0; offset < pcm.byteLength; offset += step) {
        if (!current()) return;
        this.audio.emit(pcm.slice(offset, Math.min(offset + step, pcm.byteLength)));
      }
      if (current()) this.done.emit();
    } catch (error) {
      if (current()) this.errors.emit(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
