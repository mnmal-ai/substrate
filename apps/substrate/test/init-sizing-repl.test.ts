import { afterEach, describe, expect, it, vi } from 'vitest';

const prompts = vi.hoisted(() => ({
  input: vi.fn(async (o: { default?: string }) => o.default ?? ''),
  confirm: vi.fn(async () => true),
  select: vi.fn(),
  checkbox: vi.fn()
}));
vi.mock('@inquirer/prompts', () => prompts);

import { parseArgs } from '../src/cli/init/config.js';
import { runRepl } from '../src/cli/init/repl.js';

const seed = () =>
  parseArgs([
    './rt',
    '--plugins=',
    '--store=memory',
    '--port=3100',
    '--pg-port=5433',
    '--embedder=none',
    '--tls',
    '--tls-cert-path=/c',
    '--tls-key-path=/k',
    '--substrate-url=http://x',
    '--force'
  ]);

describe('runRepl sizing questions', () => {
  const orig = process.stdin.isTTY;
  afterEach(() => {
    process.stdin.isTTY = orig;
    vi.clearAllMocks();
  });

  it('asks nothing without a TTY, keeping flags and defaults', async () => {
    process.stdin.isTTY = false;
    const out = await runRepl({ ...seed(), rowsPerDay: 7 });
    expect(prompts.input).not.toHaveBeenCalled();
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(out.rowsPerDay).toBe(7);
    expect(out.retentionDays).toBeUndefined();
  });

  it('asks the unanswered ones on a TTY, as numbers', async () => {
    process.stdin.isTTY = true;
    const out = await runRepl({ ...seed(), rowsPerDay: 7 });
    expect(prompts.input).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ rowsPerDay: 7, retentionDays: 365, readTargetMs: 250 });
    expect(out.writeHeavy).toBe(true);
  });
});
