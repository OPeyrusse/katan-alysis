import { describe, expect, it } from 'vitest';
import { maxValue, niceCeiling, pauseBars, seriesPath, timeTicks } from './charts';

describe('seriesPath', () => {
  it('maps timestamps and values into the unit box', () => {
    const path = seriesPath(
      [
        { ts_nanos: 0, value: 0 },
        { ts_nanos: 500, value: 5 },
        { ts_nanos: 1000, value: 10 },
      ],
      1000,
      10,
    );
    expect(path).toEqual([
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
    ]);
  });

  it('clamps points marginally outside the recording span', () => {
    const path = seriesPath(
      [
        { ts_nanos: -50, value: 3 },
        { ts_nanos: 2000, value: 30 },
      ],
      1000,
      10,
    );
    expect(path[0].x).toBe(0);
    expect(path[1].x).toBe(1);
    expect(path[1].y).toBe(1);
  });

  it('degrades to nothing without a span or a scale', () => {
    expect(seriesPath([{ ts_nanos: 0, value: 1 }], 0, 10)).toEqual([]);
    expect(seriesPath([{ ts_nanos: 0, value: 1 }], 10, 0)).toEqual([]);
  });
});

describe('maxValue', () => {
  it('finds the maximum across series', () => {
    expect(
      maxValue([
        [{ ts_nanos: 0, value: 3 }],
        [
          { ts_nanos: 0, value: 7 },
          { ts_nanos: 1, value: 2 },
        ],
      ]),
    ).toBe(7);
  });

  it('is zero for empty series', () => {
    expect(maxValue([[], []])).toBe(0);
  });
});

describe('pauseBars', () => {
  const pause = (ts_nanos: number, duration_nanos: number) => ({
    ts_nanos,
    duration_nanos,
    name: 'G1New',
    cause: 'test',
  });

  it('scales heights to the longest pause', () => {
    const bars = pauseBars([pause(0, 5), pause(500, 10)], 1000);
    expect(bars.map((b) => b.height)).toEqual([0.5, 1]);
    expect(bars[1].x).toBe(0.5);
  });

  it('keeps the pause for labelling', () => {
    const bars = pauseBars([pause(0, 5)], 1000);
    expect(bars[0].pause.name).toBe('G1New');
  });
});

describe('niceCeiling', () => {
  it('rounds up to 1/2/5 steps', () => {
    expect(niceCeiling(0.7)).toBe(1);
    expect(niceCeiling(1.2)).toBe(2);
    expect(niceCeiling(3)).toBe(5);
    expect(niceCeiling(7)).toBe(10);
    expect(niceCeiling(230)).toBe(500);
  });

  it('survives zero', () => {
    expect(niceCeiling(0)).toBe(1);
  });
});

describe('timeTicks', () => {
  it('spans the recording evenly', () => {
    const ticks = timeTicks(1000, 5);
    expect(ticks.map((t) => t.x)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(ticks[2].nanos).toBe(500);
  });

  it('is empty without a span', () => {
    expect(timeTicks(0, 5)).toEqual([]);
  });
});
