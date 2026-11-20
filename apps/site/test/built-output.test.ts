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

  it('gives every code token at least 4.5:1 contrast on both code backgrounds', () => {
    // WCAG relative luminance of #rrggbb, with #rrggbbaa composited over the background.
    const channels = (hex: string) =>
      [1, 3, 5, 7].map((i) => Number.parseInt(hex.slice(i, i + 2) || 'ff', 16) / 255);
    const luminance = (rgb: number[]) =>
      rgb
        .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * ([0.2126, 0.7152, 0.0722][i] ?? 0), 0);
    const contrast = (fg: string, bg: string) => {
      const [f, b] = [channels(fg), channels(bg)];
      const alpha = f[3] ?? 1;
      const over = [0, 1, 2].map((i) => alpha * (f[i] ?? 0) + (1 - alpha) * (b[i] ?? 0));
      const [hi, lo] = [luminance(over), luminance(b)].sort((x, y) => y - x);
      return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
    };
    const token = (name: string) =>
      new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(styleText)?.[1] as string;
    // A colour a `pre.astro-code span[style*='#…' i]` rule repaints with the muted token.
    const repainted = rules
      .filter((r) => /color:\s*var\(--muted\)\s*!important/.test(r.body))
      .flatMap((r) => r.selectors)
      .flatMap((sel) => /^pre\.astro-code span\[style\*=["'](#[0-9a-f]+)["'] i\]$/i.exec(sel) ?? [])
      .filter((m) => m.startsWith('#'))
      .map((m) => m.toLowerCase());
    const colours = new Set(
      [...html.matchAll(/<span style="color:(#[0-9a-f]{6,8})/gi)].map((m) => m[1] as string)
    );
    expect(colours.size).toBeGreaterThan(0);
    for (const colour of colours) {
      const shown = repainted.some((p) => colour.toLowerCase().startsWith(p))
        ? token('muted')
        : colour;
      for (const bg of [token('panel'), token('bg')]) {
        expect(contrast(shown, bg), `${colour} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
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
