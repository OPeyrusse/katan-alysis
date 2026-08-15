import { describe, expect, it } from 'vitest';
import { basename, dirname, formatBytes, formatSeconds, formatWhen } from './format';

describe('paths', () => {
  it('splits a path into name and directory', () => {
    expect(basename('/perf/prod/app.jfr')).toBe('app.jfr');
    expect(dirname('/perf/prod/app.jfr')).toBe('/perf/prod');
  });

  it('handles a file at the root', () => {
    expect(basename('/app.jfr')).toBe('app.jfr');
    expect(dirname('/app.jfr')).toBe('/');
  });

  it('handles a bare file name', () => {
    expect(basename('app.jfr')).toBe('app.jfr');
    expect(dirname('app.jfr')).toBe('/');
  });
});

describe('formatBytes', () => {
  it('keeps small sizes in bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  it('scales up with one decimal', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(48 * 1024 * 1024)).toBe('48.0 MB');
    expect(formatBytes(1.2 * 1024 * 1024 * 1024)).toBe('1.2 GB');
  });
});

describe('formatWhen', () => {
  const now = Date.UTC(2026, 7, 15, 12, 0, 0);

  it('names the recent days', () => {
    expect(formatWhen(now - 3_600_000, now)).toBe('today');
    expect(formatWhen(now - 86_400_000, now)).toBe('yesterday');
    expect(formatWhen(now - 3 * 86_400_000, now)).toBe('3 days ago');
  });

  it('falls back to the date after a month', () => {
    expect(formatWhen(Date.UTC(2026, 5, 1), now)).toBe('2026-06-01');
  });

  it('treats a clock skew towards the future as today', () => {
    expect(formatWhen(now + 60_000, now)).toBe('today');
  });
});

describe('formatSeconds', () => {
  it('renders nanoseconds as seconds with one decimal', () => {
    expect(formatSeconds(3_200_000_000)).toBe('3.2 s');
  });
});
