import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { licensedMonoAvailable } from '../src/lib/fonts.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const publicDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'site-fonts-'));
  dirs.push(d);
  mkdirSync(join(d, 'fonts', 'licensed'), { recursive: true });
  return d;
};
const touch = (d: string, name: string) =>
  writeFileSync(join(d, 'fonts', 'licensed', name), 'dummy');

describe('licensed fonts', () => {
  it('tracks no licensed font file', () => {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const tracked = execFileSync('git', ['ls-files'], { cwd: top, encoding: 'utf8' })
      .split('\n')
      .filter((f) => /BerkeleyMono|fonts\/licensed\//i.test(f));
    expect(tracked).toEqual([]);
  });

  it('licensedMonoAvailable is false without both files', () => {
    const d = publicDir();
    expect(licensedMonoAvailable(d)).toBe(false);
    touch(d, 'BerkeleyMono-Regular.woff2');
    expect(licensedMonoAvailable(d)).toBe(false);
    touch(d, 'BerkeleyMono-Bold.woff2');
    expect(licensedMonoAvailable(d)).toBe(true);
  });
});
