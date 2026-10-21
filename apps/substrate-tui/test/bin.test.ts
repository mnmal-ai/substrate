import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('substrate-tui bin', () => {
  it('without a TTY prints usage and exits 2 (never throws from Ink raw mode)', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/bin/tui.tsx'], {
      env: { ...process.env, SUBSTRATE_URL: 'http://127.0.0.1:9' },
      input: '',
      encoding: 'utf8'
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/substrate-tui needs an interactive terminal/);
  });
});
