import { describe, expect, it } from 'vitest';
import { trimTrailingSlashes } from '../src/env-utils.js';

describe('trimTrailingSlashes', () => {
  it('removes every trailing slash and nothing else', () => {
    expect(trimTrailingSlashes('https://host:3100')).toBe('https://host:3100');
    expect(trimTrailingSlashes('https://host:3100/')).toBe('https://host:3100');
    expect(trimTrailingSlashes('https://host:3100/a//')).toBe('https://host:3100/a');
    expect(trimTrailingSlashes('///')).toBe('');
    expect(trimTrailingSlashes('')).toBe('');
  });

  it('stays linear on a long run of slashes that does not end the string', () => {
    const input = `${'/'.repeat(200_000)}x`;
    const start = performance.now();
    expect(trimTrailingSlashes(input)).toBe(input);
    expect(performance.now() - start).toBeLessThan(50);
  });
});
