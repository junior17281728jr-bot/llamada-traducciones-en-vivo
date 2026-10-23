import { LEVEL_WINDOW_MS, type EnvelopeWindow } from '@tw/shared';

/** One vertical bar of the waveform. `top <= bottom` in canvas coordinates (y grows downwards). */
export interface WaveBar {
  x: number;
  top: number;
  bottom: number;
}

/** Display gain. Speech is rarely above 30% of full scale; the gain only affects how tall bars are drawn. */
export const WAVE_DISPLAY_GAIN = 4;

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/**
 * Bars for the real windows, newest at the right edge. Digital silence (min = max = 0) gives a bar
 * of zero height on the centre line, so a lane without audio is a flat line. No smoothing, no
 * interpolation and no minimum height are added.
 */
export function waveformBars(
  windows: readonly EnvelopeWindow[],
  capacity: number,
  width: number,
  height: number,
  gain: number = WAVE_DISPLAY_GAIN,
): WaveBar[] {
  const mid = height / 2;
  const step = width / capacity;
  const offset = capacity - windows.length;
  return windows.map((window, index) => ({
    x: (offset + index) * step + step / 2,
    top: mid - clamp(window.max * gain, 0, 1) * mid,
    bottom: mid - clamp(window.min * gain, -1, 0) * mid,
  }));
}

/** True when every window is exact digital silence (or there are none). */
export function isFlat(windows: readonly EnvelopeWindow[]): boolean {
  return windows.every((window) => window.min === 0 && window.max === 0);
}

/** RMS above which a window counts as voice (about -36 dBFS). */
export const SPEAKING_RMS = 0.015;

/**
 * Decides "this person is speaking" from the windows themselves: true as soon as one window has
 * voice, false after `hangoverMs` of windows below the threshold. Time is counted in windows, not
 * in wall-clock, so it is deterministic and follows the audio, not the screen refresh.
 */
export class SpeakingDetector {
  private silentMs = Number.POSITIVE_INFINITY;

  constructor(
    private readonly threshold: number = SPEAKING_RMS,
    private readonly hangoverMs = 300,
  ) {}

  get speaking(): boolean {
    return this.silentMs < this.hangoverMs;
  }

  /** Returns true when `speaking` changed. */
  push(windows: readonly EnvelopeWindow[]): boolean {
    const before = this.speaking;
    for (const window of windows) {
      if (window.rms >= this.threshold) this.silentMs = 0;
      else if (this.silentMs < this.hangoverMs) this.silentMs += LEVEL_WINDOW_MS;
      if (this.silentMs >= this.hangoverMs) this.silentMs = Number.POSITIVE_INFINITY;
    }
    return before !== this.speaking;
  }

  reset(): boolean {
    const before = this.speaking;
    this.silentMs = Number.POSITIVE_INFINITY;
    return before;
  }
}
