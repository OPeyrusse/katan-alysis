// Pure display formatting, kept out of components so it stays testable
// without rendering anything.

/** Last path segment: `/perf/prod/app.jfr` -> `app.jfr`. */
export function basename(path: string): string {
  const segments = path.split('/');
  return segments[segments.length - 1] || path;
}

/** Everything before the last segment: `/perf/prod/app.jfr` -> `/perf/prod`. */
export function dirname(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut <= 0 ? '/' : path.slice(0, cut);
}

/** Human file size with one decimal: 1536 -> `1.5 KB`. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * When a recording was last opened, relative to now: `today`, `yesterday`,
 * `N days ago`, then the ISO date once it stops being memorable.
 */
export function formatWhen(lastOpenedMs: number, nowMs: number): string {
  const days = Math.floor((nowMs - lastOpenedMs) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days <= 30) return `${days} days ago`;
  return new Date(lastOpenedMs).toISOString().slice(0, 10);
}

/** Recording duration in seconds with one decimal: `3.2 s`. */
export function formatSeconds(nanos: number): string {
  return `${(nanos / 1_000_000_000).toFixed(1)} s`;
}
