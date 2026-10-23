import { useEffect, useRef } from 'react';
import type { LevelSource } from '../core/types';
import { waveformBars, type WaveBar } from '../core/waveform';

interface WaveformProps {
  source: LevelSource;
  /** CSS custom property holding the lane colour, e.g. `--color-passenger`. */
  colorToken: string;
  /** Accessible description of what the line shows. */
  label: string;
  /** Called after each draw with the bars drawn (tests assert on them). */
  onFrame?: (bars: readonly WaveBar[]) => void;
}

type FrameRequest = (callback: () => void) => unknown;
const requestFrame: FrameRequest =
  typeof globalThis.requestAnimationFrame === 'function'
    ? (callback) => globalThis.requestAnimationFrame(callback)
    : (callback) => setTimeout(callback, 16);

/**
 * Draws the REAL windows of a level source on a canvas. It redraws only when new windows arrive or the
 * size changes (never on a timer), so a lane without audio stays exactly as flat and still as its data.
 */
export function Waveform({ source, colorToken, label, onFrame }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let scheduled = false;
    let disposed = false;

    const draw = (): void => {
      scheduled = false;
      if (disposed) return;
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || 300;
      const height = canvas.clientHeight || 80;
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      const bars = waveformBars(source.snapshot(), source.capacity, width, height);
      onFrameRef.current?.(bars);
      const context = canvas.getContext('2d');
      if (!context) return;
      const style = getComputedStyle(canvas);
      const color = style.getPropertyValue(colorToken).trim() || '#4c8dff';
      const muted = style.getPropertyValue('--color-border').trim() || '#8884';
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      context.strokeStyle = muted;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(0, height / 2);
      context.lineTo(width, height / 2);
      context.stroke();
      context.strokeStyle = color;
      context.lineWidth = Math.max(1, (width / source.capacity) * 0.7);
      context.lineCap = 'butt';
      context.beginPath();
      for (const bar of bars) {
        // A bar of zero height is digital silence: it lies on the centre line and adds nothing visible.
        if (bar.bottom - bar.top < 0.01) continue;
        context.moveTo(bar.x, bar.top);
        context.lineTo(bar.x, bar.bottom);
      }
      context.stroke();
    };

    const schedule = (): void => {
      if (scheduled || disposed) return;
      scheduled = true;
      requestFrame(draw);
    };

    const off = source.subscribe(schedule);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(canvas);
    schedule();
    return () => {
      disposed = true;
      off();
      observer?.disconnect();
    };
  }, [source, colorToken]);

  return <canvas ref={canvasRef} className="waveform" role="img" aria-label={label} data-testid="waveform" />;
}
