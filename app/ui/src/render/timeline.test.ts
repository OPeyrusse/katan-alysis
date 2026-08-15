import { describe, expect, it } from 'vitest';
import {
  brushedRange,
  densityBars,
  fractionAt,
  nanosAtFraction,
  rangeFractions,
} from './timeline';

describe('densityBars', () => {
  it('normalizes heights to the tallest bucket', () => {
    const bars = densityBars([2, 4, 1]);
    expect(bars.map((b) => b.height)).toEqual([0.5, 1, 0.25]);
  });

  it('tiles the unit width', () => {
    const bars = densityBars([1, 1, 1, 1]);
    expect(bars.map((b) => b.x)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(bars.every((b) => b.width === 0.25)).toBe(true);
  });

  it('survives an all-zero strip', () => {
    expect(densityBars([0, 0]).every((b) => b.height === 0)).toBe(true);
  });
});

describe('fractionAt', () => {
  it('maps a pointer position into [0, 1]', () => {
    expect(fractionAt(150, 100, 200)).toBe(0.25);
  });

  it('clamps outside the strip', () => {
    expect(fractionAt(50, 100, 200)).toBe(0);
    expect(fractionAt(350, 100, 200)).toBe(1);
  });

  it('degrades to 0 on a zero-width strip', () => {
    expect(fractionAt(100, 100, 0)).toBe(0);
  });
});

describe('brushedRange', () => {
  it('orders the bounds regardless of drag direction', () => {
    expect(brushedRange(0.75, 0.25, 1000)).toEqual([250, 750]);
  });

  it('collapses a click to null — the clear gesture', () => {
    expect(brushedRange(0.4, 0.4, 1000)).toBeNull();
  });

  it('maps fractions to relative nanoseconds', () => {
    expect(nanosAtFraction(0.5, 3_000_000_000)).toBe(1_500_000_000);
  });
});

describe('rangeFractions', () => {
  it('places an active window on the strip', () => {
    expect(rangeFractions([250, 750], 1000)).toEqual({ left: 0.25, width: 0.5 });
  });

  it('is null without a window', () => {
    expect(rangeFractions(null, 1000)).toBeNull();
    expect(rangeFractions(undefined, 1000)).toBeNull();
  });

  it('clamps a window that overflows the recording', () => {
    expect(rangeFractions([500, 2000], 1000)).toEqual({ left: 0.5, width: 0.5 });
  });
});
