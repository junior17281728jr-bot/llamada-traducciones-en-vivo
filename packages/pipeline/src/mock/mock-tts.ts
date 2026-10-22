import {
  msToBytes,
  normalizeLanguageCode,
  synthesizeSpeechSignal,
  type PcmChunk,
  type TtsProvider,
  type TtsSession,
  type TtsSessionOptions,
  type Unsubscribe,
} from '@tw/shared';
import { Emitter } from '../util/emitter.js';

const PITCH_BY_LANGUAGE: Record<string, number> = { es: 120, en: 180, fr: 230, it: 280, pt: 330, de: 380 };

/** Pitch of the SIMULATED voice for a language: tests use it to tell which language a chunk was spoken in. */
export function mockVoicePitchHz(lang: string): number {
  const code = normalizeLanguageCode(lang) ?? lang;
  return PITCH_BY_LANGUAGE[code] ?? 450;
}

export interface MockTtsOptions {
  /** Chunk length of the audio emitted. */
  chunkMs?: number;
  /** Emit chunks at playback speed (demo) instead of as fast as possible (tests). */
  realtime?: boolean;
  /** Milliseconds between chunks when `realtime` is on (default: `chunkMs`). Lets tests keep a phrase "in progress" briefly. */
  paceMs?: number;
  /** Called every time a session is opened (tests count connections). */
  onOpen?: (lang: string) => void;
}

/** SIMULATED text to speech: a speech-like tone per word whose pitch depends on the language. */
export class MockTts implements TtsProvider {
  readonly simulated = true;

  constructor(private readonly options: MockTtsOptions = {}) {}

  openSession(options: TtsSessionOptions): Promise<TtsSession> {
    this.options.onOpen?.(options.lang);
    return Promise.resolve(new MockTtsSession(options.lang, this.options));
  }
}

class MockTtsSession implements TtsSession {
  private readonly audio = new Emitter<PcmChunk>();
  private readonly done = new Emitter<void>();
  private readonly errors = new Emitter<Error>();
  private readonly chunkMs: number;
  private queued: string[] = [];
  private generation = 0;
  private running = false;
  private closed = false;

  constructor(
    readonly lang: string,
    private readonly options: MockTtsOptions,
  ) {
    this.chunkMs = options.chunkMs ?? 20;
  }

  speak(text: string): void {
    if (text.trim()) this.queued.push(text);
  }

  flush(): void {
    if (this.closed) return;
    if (this.queued.length === 0 && !this.running) {
      queueMicrotask(() => {
        if (!this.closed) this.done.emit();
      });
      return;
    }
    void this.run();
  }

  cancel(): void {
    this.generation += 1;
    this.queued = [];
    this.running = false;
  }

  prewarm(): Promise<void> {
    return Promise.resolve();
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

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const generation = this.generation;
    const chunkBytes = Math.max(2, msToBytes(this.chunkMs));
    while (this.queued.length > 0) {
      const text = this.queued.shift()!;
      const signal = synthesizeSpeechSignal(text, { pitchHz: mockVoicePitchHz(this.lang) });
      for (let offset = 0; offset < signal.byteLength; offset += chunkBytes) {
        if (generation !== this.generation || this.closed) return;
        this.audio.emit(signal.slice(offset, Math.min(offset + chunkBytes, signal.byteLength)));
        await this.pace();
      }
    }
    if (generation !== this.generation || this.closed) return;
    this.running = false;
    this.done.emit();
  }

  private pace(): Promise<void> {
    return new Promise((resolve) => {
      if (this.options.realtime) setTimeout(resolve, this.options.paceMs ?? this.chunkMs);
      else setImmediate(resolve);
    });
  }
}
