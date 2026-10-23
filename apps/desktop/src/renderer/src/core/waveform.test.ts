import { describe, expect, it } from 'vitest';
import { LEVEL_WINDOW_MS, type EnvelopeWindow } from '@tw/shared';
import { SPEAKING_RMS, SpeakingDetector, isFlat, waveformBars } from './waveform';

const SILENCE: EnvelopeWindow = { min: 0, max: 0, rms: 0 };
const loud: EnvelopeWindow = { min: -0.2, max: 0.25, rms: 0.1 };

describe('waveformBars', () => {
  it('draws digital silence as a flat line on the centre', () => {
    const bars = waveformBars([SILENCE, SILENCE, SILENCE], 10, 200, 100);
    expect(bars).toHaveLength(3);
    for (const bar of bars) {
      expect(bar.top).toBe(50);
      expect(bar.bottom).toBe(50);
    }
    expect(isFlat([SILENCE, SILENCE])).toBe(true);
  });

  it('is aligned to the right edge, newest last, and scales real min/max symmetrically around the centre', () => {
    const bars = waveformBars([loud, SILENCE], 4, 400, 100, 2);
    expect(bars.map((bar) => bar.x)).toEqual([250, 350]);
    expect(bars[0]!.top).toBeCloseTo(50 - 0.5 * 50);
    expect(bars[0]!.bottom).toBeCloseTo(50 + 0.4 * 50);
    expect(isFlat([loud, SILENCE])).toBe(false);
  });

  it('clips at the lane edges and has no minimum height for quiet but non-zero audio', () => {
    const [clipped] = waveformBars([{ min: -1, max: 1, rms: 0.7 }], 1, 10, 80);
    expect(clipped!.top).toBe(0);
    expect(clipped!.bottom).toBe(80);
    const [quiet] = waveformBars([{ min: -0.001, max: 0.001, rms: 0.0007 }], 1, 10, 80, 1);
    expect(quiet!.bottom - quiet!.top).toBeLessThan(0.1);
  });
});

describe('SpeakingDetector', () => {
  const frames = (win: EnvelopeWindow, count: number) => Array.from({ length: count }, () => win);

  it('is not speaking before any voice and stays quiet on silence', () => {
    const detector = new SpeakingDetector();
    expect(detector.speaking).toBe(false);
    expect(detector.push(frames(SILENCE, 50))).toBe(false);
    expect(detector.speaking).toBe(false);
  });

  it('turns on with the first voiced window and off after the hangover of quiet windows', () => {
    const detector = new SpeakingDetector(SPEAKING_RMS, 300);
    expect(detector.push([loud])).toBe(true);
    expect(detector.speaking).toBe(true);
    const hangoverWindows = Math.ceil(300 / LEVEL_WINDOW_MS);
    expect(detector.push(frames(SILENCE, hangoverWindows - 1))).toBe(false);
    expect(detector.speaking).toBe(true);
    expect(detector.push(frames(SILENCE, 1))).toBe(true);
    expect(detector.speaking).toBe(false);
  });

  it('a window just below the threshold is not voice', () => {
    const detector = new SpeakingDetector(0.05);
    detector.push([{ min: -0.1, max: 0.1, rms: 0.049 }]);
    expect(detector.speaking).toBe(false);
  });

  it('reset() stops it at once', () => {
    const detector = new SpeakingDetector();
    detector.push([loud]);
    expect(detector.reset()).toBe(true);
    expect(detector.speaking).toBe(false);
  });
});
