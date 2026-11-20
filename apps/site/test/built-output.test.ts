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
// The rules inside every `@media (prefers-reduced-motion: reduce)` block, inline or in a file.
const reducedMotionRules = (text: string): { selector: string; body: string }[] =>
  [...text.matchAll(/prefers-reduced-motion:\s*reduce\s*\)\s*\{/g)].flatMap((m) => {
    let depth = 1;
    let end = (m.index ?? 0) + m[0].length;
    const start = end;
    while (depth > 0 && end < text.length) {
      if (text[end] === '{') depth++;
      if (text[end] === '}') depth--;
      end++;
    }
    return [...text.slice(start, end - 1).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((r) => ({
      selector: r[1] as string,
      body: r[2] as string
    }));
  });
// Every innermost `selector { body }` rule, inline or in a file.
const styleText = `${cssText}\n${[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')}`;
const rules = [...styleText.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((r) => ({
  selectors: (r[1] as string).split(',').map((s) => s.trim()),
  body: r[2] as string
}));
const ruled = (selector: RegExp, body: RegExp) =>
  rules.some((r) => r.selectors.some((s) => selector.test(s)) && body.test(r.body));
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

  it('hides the feed duplicate from assistive tech', () => {
    const copy = (attr: string) =>
      html.match(new RegExp(`<div[^>]*${attr}[^>]*>\\s*<ol[^>]*>([\\s\\S]*?)</ol>`))?.[1];
    const log = copy('role="log"');
    expect(log).toContain('<li');
    expect(copy('aria-hidden="true"')).toBe(log);
  });

  it('stops motion under reduced motion', () => {
    const rules = reducedMotionRules(`${cssText}\n${html}`);
    for (const cls of ['feed', 'pulse']) {
      const selector = new RegExp(`\\.${cls}(?![\\w-])`);
      expect(
        rules.some((r) => selector.test(r.selector) && /animation:\s*none/.test(r.body)),
        cls
      ).toBe(true);
    }
  });

  it('keeps long lines inside their boxes', () => {
    expect(ruled(/(^|[\s>])pre(?![\w-])/, /overflow-x:\s*auto/), 'pre scrolls').toBe(true);
    expect(ruled(/\.line(?![\w-])/, /overflow-wrap:\s*anywhere/), 'feed lines wrap').toBe(true);
    // Hiding the page's overflow would mask a box that is too wide instead of fixing it.
    expect(ruled(/^(html|body)$/, /overflow(-x)?:\s*(hidden|clip)/), 'page clips').toBe(false);
  });

  it('has one h1 and labelled sections', () => {
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    const sections = [...html.matchAll(/<section\b[^>]*>/g)].map((m) => m[0]);
    // The nine sections of the page, hero to start.
    expect(sections).toHaveLength(9);
    for (const s of sections) {
      const by = /aria-labelledby="([^"]+)"/.exec(s)?.[1];
      const named =
        /aria-label="[^"]+"/.test(s) || (by !== undefined && html.includes(`id="${by}"`));
      expect(named, s).toBe(true);
    }
  });
});
