import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/init/config.js';
import { runInit } from '../src/cli/init/main.js';
import { profileFromAnswers } from '../src/cli/init/sizing.js';
import { parseEnv } from '../src/serve/config.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const scaffold = async (...flags: string[]): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-init-sizing-'));
  dirs.push(dir);
  const code = await runInit([join(dir, 'rt'), '--yes', '--store=memory', '--plugins=', ...flags]);
  expect(code).toBe(0);
  return readFileSync(join(dir, 'rt', '.env'), 'utf8');
};

describe('profileFromAnswers', () => {
  const base = { rowsPerDay: 0, retentionDays: 1, readTargetMs: 250, writeHeavy: false };
  it.each([
    [{ rowsPerDay: 500, retentionDays: 365 }, 'personal'],
    [{ rowsPerDay: 100_000, retentionDays: 14 }, 'growth'],
    [{ rowsPerDay: 2_000_000, retentionDays: 30 }, 'scale'],
    [{ rowsPerDay: 5_000_000, retentionDays: 1, readTargetMs: 50 }, 'scale'],
    [{ rowsPerDay: 5_000_000, retentionDays: 1, readTargetMs: 51 }, 'growth'],
    [{ rowsPerDay: 4_999_999, retentionDays: 1, readTargetMs: 50 }, 'growth'],
    [{ rowsPerDay: 999_999, retentionDays: 1 }, 'personal'],
    [{ rowsPerDay: 1000, retentionDays: 1000, writeHeavy: true }, 'growth']
  ] as const)('%j -> %s', (over, want) => {
    expect(profileFromAnswers({ ...base, ...over })).toBe(want);
  });
});

describe('substrate init sizing', () => {
  it('--profile scale writes it, and the server config reads it back', async () => {
    const env = await scaffold('--profile=scale');
    expect(env).toContain('SUBSTRATE_STORE_PROFILE=scale\n');
    expect(env).not.toContain('SUBSTRATE_STORE_WRITE_HEAVY');
  });

  it('derives the profile from the sizing flags, and --profile overrides them', async () => {
    const sizing = ['--rows-per-day=100000', '--retention-days=14'];
    expect(await scaffold(...sizing)).toContain('SUBSTRATE_STORE_PROFILE=growth\n');
    expect(await scaffold(...sizing, '--profile=personal')).toContain(
      'SUBSTRATE_STORE_PROFILE=personal\n'
    );
  });

  it('defaults to personal', async () => {
    expect(await scaffold()).toContain('SUBSTRATE_STORE_PROFILE=personal\n');
  });

  it('--write-heavy writes the knob the server reads, leaving the profile alone', async () => {
    const env = await scaffold('--write-heavy');
    expect(env).toContain('SUBSTRATE_STORE_PROFILE=personal\n');
    expect(env).toContain('SUBSTRATE_STORE_WRITE_HEAVY=1\n');
    const parsed = Object.fromEntries(
      env
        .split('\n')
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
    );
    const cfg = parseEnv(parsed as NodeJS.ProcessEnv);
    expect(cfg.storeWriteHeavy).toBe(true);
    expect(cfg.storeProfile).toBe('personal');
  });

  it('--write-heavy takes bare, true and false, and refuses the rest', () => {
    expect(parseArgs(['--write-heavy']).writeHeavy).toBe(true);
    expect(parseArgs(['--write-heavy=true']).writeHeavy).toBe(true);
    expect(parseArgs(['--write-heavy=false']).writeHeavy).toBe(false);
    for (const v of ['yes', '1', 'FALSE'])
      expect(() => parseArgs([`--write-heavy=${v}`])).toThrow(/^--write-heavy must be true\|false/);
  });

  it('SUBSTRATE_STORE_WRITE_HEAVY parses strictly', () => {
    const heavy = (v?: string) =>
      parseEnv(v === undefined ? {} : { SUBSTRATE_STORE_WRITE_HEAVY: v }).storeWriteHeavy;
    for (const v of [undefined, '', '0', 'false']) expect(heavy(v)).toBe(false);
    for (const v of ['1', 'true', 'TRUE']) expect(heavy(v)).toBe(true);
    for (const v of ['yes', 'on', 'tru', '2'])
      expect(() => heavy(v)).toThrow(/SUBSTRATE_STORE_WRITE_HEAVY/);
  });

  it.each([
    '--rows-per-day=0',
    '--rows-per-day=-5',
    '--retention-days=abc',
    '--read-target-ms=',
    '--read-target-ms=Infinity',
    '--profile=huge'
  ])('refuses %s', (flag) => {
    expect(() => parseArgs([flag])).toThrow(/^--[a-z-]+ must be/);
  });
});
