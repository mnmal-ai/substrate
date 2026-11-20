import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { licensedMonoAvailable } from '../src/lib/fonts.ts';

const dist = new URL('../dist/', import.meta.url).pathname;
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const css = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? css(join(dir, e.name))
      : e.name.endsWith('.css')
        ? [readFileSync(join(dir, e.name), 'utf8')]
        : []
  );
const cssText = css(dist).join('\n');
// With the licensed files present the build is the deploy path, which must reference them.
const forkBuild = !licensedMonoAvailable(new URL('../public/', import.meta.url).pathname);

describe('built output', () => {
  it.runIf(forkBuild)('references no licensed font when the files are absent', () => {
    expect(html).not.toContain('BerkeleyMono');
    expect(cssText).not.toContain('BerkeleyMono');
  });

  it('keeps every internal URL under the base path', () => {
    const bad = [...(html + cssText).matchAll(/(?:href="|src="|url\()(\/[^"')]*)/g)]
      .map((m) => m[1] as string)
      .filter((u) => !u.startsWith('/substrate/'));
    expect(bad).toEqual([]);
  });

  it('inlines no font', () => {
    expect(cssText).not.toMatch(/data:(font|application\/font)/);
  });
});
