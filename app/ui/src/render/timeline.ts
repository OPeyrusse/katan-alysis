// Pure geometry of the timeline brush strip, in unit space (fractions of
// the strip's width/height), so it is testable without a browser and
// independent of the rendered size.

export interface UnitBar {
  x: number;
  width: number;
  /** 0..1, tallest bucket = 1. */
  height: number;
}

/** One bar per bucket, heights normalized to the tallest bucket. */
export function densityBars(counts: number[]): UnitBar[] {
  const max = Math.max(...counts, 1);
  const width = 1 / counts.length;
  return counts.map((count, i) => ({
    x: i * width,
    width,
    height: count / max,
  }));
}

/** Horizontal position of a pointer inside a strip, clamped to [0, 1]. */
export function fractionAt(clientX: number, left: number, width: number): number {
  if (width <= 0) return 0;
  return Math.min(1, Math.max(0, (clientX - left) / width));
}

/** The instant a fraction of the strip maps to, in relative nanoseconds. */
export function nanosAtFraction(fraction: number, durationNanos: number): number {
  return Math.round(fraction * durationNanos);
}

/**
 * The window brushed between two pointer positions, ordered; `null` when
 * the drag collapses to a single instant — the gesture that clears the
 * time filter rather than narrowing to nothing.
 */
export function brushedRange(
  f0: number,
  f1: number,
  durationNanos: number,
): [number, number] | null {
  const start = nanosAtFraction(Math.min(f0, f1), durationNanos);
  const end = nanosAtFraction(Math.max(f0, f1), durationNanos);
  return start === end ? null : [start, end];
}

/** Where an active window sits on the strip; `null` without a window. */
export function rangeFractions(
  range: [number, number] | null | undefined,
  durationNanos: number,
): { left: number; width: number } | null {
  if (!range || durationNanos <= 0) return null;
  const left = Math.min(1, Math.max(0, range[0] / durationNanos));
  const right = Math.min(1, Math.max(0, range[1] / durationNanos));
  return { left, width: Math.max(0, right - left) };
}
