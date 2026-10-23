import type { EnvelopeWindow } from '@tw/shared';
import type { LevelSource, Unsubscribe } from './types';

/**
 * Ring buffer of the REAL envelope windows of one lane. Nothing here invents values: the only way
 * to add data is `push`, and callers push what was measured on actual audio (or exact digital
 * silence when a lane has no audio source). `snapshot()` returns the same array until something is pushed.
 */
export class RingLevelSource implements LevelSource {
  readonly capacity: number;
  private buffer: EnvelopeWindow[] = [];
  private cached: readonly EnvelopeWindow[] = [];
  private readonly listeners = new Set<() => void>();
  private last: number | null = null;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
    this.capacity = capacity;
  }

  push(windows: readonly EnvelopeWindow[], at: number = performance.now()): void {
    if (windows.length === 0) return;
    const merged = this.buffer.length === 0 ? [...windows] : [...this.buffer, ...windows];
    this.buffer = merged.length > this.capacity ? merged.slice(merged.length - this.capacity) : merged;
    this.cached = this.buffer;
    this.last = at;
    for (const listener of [...this.listeners]) listener();
  }

  clear(): void {
    this.buffer = [];
    this.cached = [];
    this.last = null;
    for (const listener of [...this.listeners]) listener();
  }

  snapshot(): readonly EnvelopeWindow[] {
    return this.cached;
  }

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  lastWindowAt(): number | null {
    return this.last;
  }
}
