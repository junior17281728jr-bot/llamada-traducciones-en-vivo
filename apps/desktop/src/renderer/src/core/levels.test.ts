import { describe, expect, it, vi } from 'vitest';
import type { EnvelopeWindow } from '@tw/shared';
import { RingLevelSource } from './levels';

const win = (max: number): EnvelopeWindow => ({ min: -max, max, rms: max / 2 });

describe('RingLevelSource', () => {
  it('starts empty and never invents data', () => {
    const source = new RingLevelSource(5);
    expect(source.snapshot()).toEqual([]);
    expect(source.lastWindowAt()).toBeNull();
    source.push([], 10);
    expect(source.snapshot()).toEqual([]);
    expect(source.lastWindowAt()).toBeNull();
  });

  it('keeps the newest windows up to its capacity, oldest first', () => {
    const source = new RingLevelSource(3);
    source.push([win(0.1), win(0.2)], 1);
    source.push([win(0.3), win(0.4)], 2);
    expect(source.snapshot().map((w) => w.max)).toEqual([0.2, 0.3, 0.4]);
    expect(source.lastWindowAt()).toBe(2);
  });

  it('notifies subscribers on push and clear, and keeps the snapshot stable in between', () => {
    const source = new RingLevelSource(4);
    const listener = vi.fn();
    const off = source.subscribe(listener);
    source.push([win(0.1)], 1);
    const first = source.snapshot();
    expect(source.snapshot()).toBe(first);
    source.push([win(0.2)], 2);
    expect(source.snapshot()).not.toBe(first);
    source.clear();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(source.snapshot()).toEqual([]);
    off();
    source.push([win(0.3)], 3);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('rejects a bad capacity', () => {
    expect(() => new RingLevelSource(0)).toThrow(RangeError);
  });
});
