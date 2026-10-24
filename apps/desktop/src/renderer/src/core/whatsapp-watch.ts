import { pcm16Rms, pcmDurationMs } from '@tw/shared';

/**
 * "Entrada automática de WhatsApp". WhatsApp gives no signal to other programs when a call comes in, so the
 * only honest way to notice it is the sound itself: WhatsApp's speaker is cable A, and when cable A carries
 * voice (or the ringtone) for long enough, the call enters the app on its own. When cable A stays silent for
 * a long time during a call, the call has very likely ended in WhatsApp.
 */

/** RMS (0..1) above which a 20 ms window of cable A counts as sound. Around -36 dBFS: speech, not line hiss. */
export const CABLE_VOICE_RMS = 0.015;

export interface VoiceTriggerOptions {
  thresholdRms: number;
  /** Sound needed within `windowMs` to start a call. */
  triggerMs: number;
  windowMs: number;
  /** After a call (or a refused start) the cable must be quiet this long before it can start another one. */
  armQuietMs: number;
}

/** About 0.6 s of sound within 1.5 s: a ringtone or a few words, not a short notification ding. */
export const DEFAULT_VOICE_TRIGGER: VoiceTriggerOptions = { thresholdRms: CABLE_VOICE_RMS, triggerMs: 600, windowMs: 1500, armQuietMs: 2500 };

/** Decides, window by window, when the sound on cable A is a call coming in. */
export class VoiceTrigger {
  private readonly options: VoiceTriggerOptions;
  private readonly history: { voiced: boolean; ms: number }[] = [];
  private historyMs = 0;
  private quietMs = 0;
  private isArmed: boolean;
  /** RMS of the last window, for the meter on screen. */
  level = 0;

  constructor(options: Partial<VoiceTriggerOptions> = {}, armed = true) {
    this.options = { ...DEFAULT_VOICE_TRIGGER, ...options };
    this.isArmed = armed;
  }

  get armed(): boolean {
    return this.isArmed;
  }

  /** The next call needs a quiet cable first (the previous one may still be going on in WhatsApp). */
  requireQuiet(): void {
    this.isArmed = false;
    this.quietMs = 0;
    this.history.length = 0;
    this.historyMs = 0;
  }

  /** True when this window completes enough sound to start a call. */
  push(pcm: Uint8Array): boolean {
    const ms = pcmDurationMs(pcm);
    if (ms <= 0) return false;
    this.level = pcm16Rms(pcm);
    const voiced = this.level >= this.options.thresholdRms;
    if (!this.isArmed) {
      this.quietMs = voiced ? 0 : this.quietMs + ms;
      if (this.quietMs >= this.options.armQuietMs) this.isArmed = true;
      return false;
    }
    this.history.push({ voiced, ms });
    this.historyMs += ms;
    while (this.historyMs > this.options.windowMs && this.history.length > 1) this.historyMs -= this.history.shift()!.ms;
    const voicedMs = this.history.reduce((sum, entry) => sum + (entry.voiced ? entry.ms : 0), 0);
    if (voicedMs < this.options.triggerMs) return false;
    this.history.length = 0;
    this.historyMs = 0;
    return true;
  }
}

/** How long cable A has been silent during a call. */
export class SilenceMeter {
  private silent = 0;
  constructor(private readonly thresholdRms: number = CABLE_VOICE_RMS) {}

  push(pcm: Uint8Array): void {
    if (pcm16Rms(pcm) >= this.thresholdRms) this.silent = 0;
    else this.silent += pcmDurationMs(pcm);
  }

  get silentMs(): number {
    return this.silent;
  }

  reset(): void {
    this.silent = 0;
  }
}

/** Keeps the last `maxMs` of audio, so the first words before the call entered are not lost. */
export class PreRoll {
  private chunks: Uint8Array[] = [];
  private totalMs = 0;
  constructor(private readonly maxMs: number) {}

  push(pcm: Uint8Array): void {
    this.chunks.push(pcm);
    this.totalMs += pcmDurationMs(pcm);
    while (this.totalMs > this.maxMs && this.chunks.length > 1) this.totalMs -= pcmDurationMs(this.chunks.shift()!);
  }

  drain(): Uint8Array[] {
    const out = this.chunks;
    this.chunks = [];
    this.totalMs = 0;
    return out;
  }
}

/** Seconds of silence on cable A before the app offers to close the call (0 = never). */
export const DEFAULT_AUTO_END_SECONDS = 30;
/** Countdown shown before closing a silent call. */
export const AUTO_END_COUNTDOWN_MS = 10_000;
