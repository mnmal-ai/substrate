import { afterEach, beforeEach } from 'vitest';

export function useEnvSnapshot(key: string): void {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env[key];
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}
