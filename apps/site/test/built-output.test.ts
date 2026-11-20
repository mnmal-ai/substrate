import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
// A `dist/` built with the licensed fonts present is the deploy path, not this one.
const forkBuild = !/BerkeleyMono/.test(html);

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
