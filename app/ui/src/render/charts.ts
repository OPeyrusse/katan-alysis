// Pure geometry of the overview charts, in unit space ([0,1]², y growing
// upwards from the bottom), so it is testable without a browser and
// independent of the rendered size. All four charts share one x axis:
// the whole recording, 0 → durationNanos.

import type { GcPause, TimePoint } from '../api/client';

export interface UnitPoint {
  x: number;
  y: number;
}

/**
 * A polyline for one series, x from timestamps over the recording span,
 * y scaled so `maxValue` = 1. Timestamps marginally outside the span
 * (signals may lead the first sample) are clamped to the edges.
 */
export function seriesPath(
  points: TimePoint[],
  durationNanos: number,
  maxValue: number,
): UnitPoint[] {
  if (durationNanos <= 0 || maxValue <= 0) return [];
  return points.map((p) => ({
    x: Math.min(1, Math.max(0, p.ts_nanos / durationNanos)),
    y: Math.min(1, Math.max(0, p.value / maxValue)),
  }));
}

/** The largest value across several series; 0 when everything is empty. */
export function maxValue(series: TimePoint[][]): number {
  let max = 0;
  for (const points of series) {
    for (const p of points) {
      if (p.value > max) max = p.value;
    }
  }
  return max;
}

/**
 * A vertical bar per GC pause, height scaled so the longest pause = 1.
 * Bars carry their pause so the caller can label hovers.
 */
export function pauseBars(
  pauses: GcPause[],
  durationNanos: number,
): { x: number; height: number; pause: GcPause }[] {
  if (durationNanos <= 0) return [];
  const longest = Math.max(...pauses.map((p) => p.duration_nanos), 1);
  return pauses.map((pause) => ({
    x: Math.min(1, Math.max(0, pause.ts_nanos / durationNanos)),
    height: pause.duration_nanos / longest,
    pause,
  }));
}

/** Round a maximum up to a friendly axis bound (1/2/5 × 10^k). */
export function niceCeiling(value: number): number {
  if (value <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

/** Evenly spaced time ticks across the recording, in unit x. */
export function timeTicks(
  durationNanos: number,
  count: number,
): { x: number; nanos: number }[] {
  if (count < 2 || durationNanos <= 0) return [];
  return Array.from({ length: count }, (_, i) => {
    const x = i / (count - 1);
    return { x, nanos: Math.round(x * durationNanos) };
  });
}
