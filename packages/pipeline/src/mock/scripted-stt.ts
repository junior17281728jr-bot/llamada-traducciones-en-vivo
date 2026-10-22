import {
  normalizeLanguageCode,
  pcm16Rms,
  pcmDurationMs,
  speechSignalDurationMs,
  type PcmChunk,
  type SttFinal,
  type SttPartial,
  type SttProvider,
  type SttSession,
  type SttSessionOptions,
  type Unsubscribe,
} from '@tw/shared';
import { Emitter } from '../util/emitter.js';
import type { ScriptedUtterance, UtteranceBus } from './utterance-bus.js';

export interface ScriptedSttOptions {
  bus: UtteranceBus;
  /** Which queue of the bus this provider listens to (e.g. `${callId}:passenger`). */
  key: string;
  /** Chunks quieter than this RMS (0..1) are silence: they never start or advance an utterance. */
  voicedRms?: number;
  langProbability?: number;
}

/** SIMULATED speech to text: transcripts come from the bus, paced by the audio that really arrives. */
export class ScriptedStt implements SttProvider {
  readonly simulated = true;

  constructor(private readonly options: ScriptedSttOptions) {}

  openSession(_options: SttSessionOptions): Promise<SttSession> {
    return Promise.resolve(new ScriptedSttSession(this.options));
  }
}

interface ActiveUtterance {
  utterance: ScriptedUtterance;
  words: string[];
  startedAtMs: number;
  durationMs: number;
  revealed: number;
}

class ScriptedSttSession implements SttSession {
  private readonly partials = new Emitter<SttPartial>();
  private readonly finals = new Emitter<SttFinal>();
  private readonly errors = new Emitter<Error>();
  private readonly voicedRms: number;
  private readonly langProbability: number;
  private clockMs = 0;
  private active: ActiveUtterance | null = null;
  private closed = false;

  constructor(private readonly options: ScriptedSttOptions) {
    this.voicedRms = options.voicedRms ?? 0.002;
    this.langProbability = options.langProbability ?? 0.95;
  }

  sendAudio(pcm: PcmChunk): void {
    if (this.closed) return;
    const voiced = pcm16Rms(pcm) >= this.voicedRms;
    if (!this.active && voiced) {
      const utterance = this.options.bus.take(this.options.key);
      if (utterance) {
        this.active = {
          utterance,
          words: utterance.text.split(/\s+/).filter(Boolean),
          startedAtMs: this.clockMs,
          durationMs: Math.max(1, speechSignalDurationMs(utterance.text)),
          revealed: 0,
        };
      }
    }
    this.clockMs += pcmDurationMs(pcm);
    const active = this.active;
    if (!active) return;

    const elapsed = this.clockMs - active.startedAtMs;
    if (elapsed >= active.durationMs) {
      this.finish(active);
      return;
    }
    const target = Math.min(active.words.length, Math.floor((active.words.length * elapsed) / active.durationMs));
    if (target > active.revealed) {
      active.revealed = target;
      this.partials.emit({ text: active.words.slice(0, target).join(' '), lang: normalizeLanguageCode(active.utterance.lang) ?? undefined });
    }
  }

  commit(): void {
    if (this.active) this.finish(this.active);
  }

  onPartial(handler: (partial: SttPartial) => void): Unsubscribe {
    return this.partials.on(handler);
  }

  onFinal(handler: (final: SttFinal) => void): Unsubscribe {
    return this.finals.on(handler);
  }

  onError(handler: (error: Error) => void): Unsubscribe {
    return this.errors.on(handler);
  }

  close(): Promise<void> {
    this.closed = true;
    this.active = null;
    this.partials.clear();
    this.finals.clear();
    this.errors.clear();
    return Promise.resolve();
  }

  private finish(active: ActiveUtterance): void {
    this.active = null;
    this.finals.emit({
      text: active.utterance.text,
      lang: normalizeLanguageCode(active.utterance.lang) ?? undefined,
      langProbability: this.langProbability,
      startMs: active.startedAtMs,
      endMs: this.clockMs,
    });
  }
}
