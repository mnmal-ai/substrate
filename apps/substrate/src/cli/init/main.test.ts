import { describe, expect, it } from 'vitest';
import { runInit } from './main.js';

describe('runInit', () => {
  it('rejects when no target dir given and not interactive', async () => {
    const exit = await runInit(['--yes']);
    expect(exit).toBe(1);
  });
});
