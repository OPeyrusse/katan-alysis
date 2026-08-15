import { describe, expect, it } from 'vitest';
import { uniqueName } from './selections';

describe('uniqueName', () => {
  it('keeps a free name as-is', () => {
    expect(uniqueName('peak load', [])).toBe('peak load');
    expect(uniqueName('peak load', ['other'])).toBe('peak load');
  });

  it('suffixes the first conflict with (2)', () => {
    expect(uniqueName('peak load', ['peak load'])).toBe('peak load (2)');
  });

  it('finds the next free suffix', () => {
    expect(uniqueName('a', ['a', 'a (2)', 'a (3)'])).toBe('a (4)');
  });

  it('reuses a freed suffix', () => {
    expect(uniqueName('a', ['a', 'a (3)'])).toBe('a (2)');
  });
});
