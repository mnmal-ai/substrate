import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXAMPLE_FIGURES, EXAMPLE_SLUGS, pageHref } from '../src/lib/example-pages.ts';
import { licensedMonoAvailable } from '../src/lib/fonts.ts';

const dist = new URL('../dist/', import.meta.url).pathname;
// Every built page, by its path under dist/.
const pages = readdirSync(dist, { recursive: true, encoding: 'utf8' })
  .filter((f) => f === 'index.html' || f.endsWith('/index.html'))
  .map((path) => ({ path, html: readFileSync(join(dist, path), 'utf8') }));
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const allHtml = pages.map((p) => p.html).join('\n');
const css = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? css(join(dir, e.name))
      : e.name.endsWith('.css')
        ? [readFileSync(join(dir, e.name), 'utf8')]
        : []
  );
const cssText = css(dist).join('\n');
// The rules inside every `@media` block whose condition matches, inline or in a file.
const mediaRules = (text: string, condition: RegExp): { selector: string; body: string }[] =>
  [...text.matchAll(new RegExp(`@media[^{]*${condition.source}[^{]*\\{`, 'g'))].flatMap((m) => {
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
// Every innermost `selector { body }` rule, inline or in a file, on any page.
const styleText = `${cssText}\n${[...allHtml.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')}`;
const rules = [...styleText.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((r) => ({
  selectors: (r[1] as string).split(',').map((s) => s.trim()),
  body: r[2] as string
}));
const ruled = (selector: RegExp, body: RegExp) =>
  rules.some((r) => r.selectors.some((s) => selector.test(s)) && body.test(r.body));
// With the licensed files present the build is the deploy path, which must reference them.
const forkBuild = !licensedMonoAvailable(new URL('../public/', import.meta.url).pathname);

describe('built output', () => {
  it('builds the landing page and every example page', () => {
    expect(pages.map((p) => p.path)).toContain('index.html');
    expect(pages).toHaveLength(1 + EXAMPLE_SLUGS.length);
  });

  it('opens every page with a skip link to its content, past an example page sidebar', () => {
    for (const { path, html } of pages) {
      const body = html.slice(html.indexOf('<body'));
      const first = /<(?:a|button|input|select|textarea|summary)\b[^>]*>[^<]*/.exec(body)?.[0];
      expect(first, path).toMatch(/\shref="#main"[^>]*>Skip to content$/);
      const target = path === 'index.html' ? 'main' : 'article';
      expect(body, path).toMatch(new RegExp(`<${target}\\b[^>]*\\sid="main"`));
      if (target === 'article') {
        expect(body.indexOf('class="sidebar"'), path).toBeLessThan(body.indexOf('id="main"'));
      }
    }
  });

  it.runIf(forkBuild)('references no licensed font when the files are absent', () => {
    for (const { path, html } of pages) expect(html, path).not.toContain('BerkeleyMono');
    expect(cssText).not.toContain('BerkeleyMono');
  });

  it('keeps every internal URL under the base path', () => {
    for (const { path, html } of pages) {
      const bad = [...(html + cssText).matchAll(/(?:href="|src="|url\()(\/[^"')]*)/g)]
        .map((m) => m[1] as string)
        .filter((u) => !u.startsWith('/substrate/'));
      expect(bad, path).toEqual([]);
    }
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
    const rules = mediaRules(`${cssText}\n${allHtml}`, /prefers-reduced-motion:\s*reduce\s*\)/);
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

  it('swaps the example sidebar for its picker on narrow screens', () => {
    // Astro scopes a component's selectors (`.sidebar[data-astro-cid-…]`), so the class is a prefix.
    const hidden = (cls: string, condition: RegExp) =>
      mediaRules(styleText, condition).some(
        (r) =>
          r.selector.split(',').some((s) => new RegExp(`^\\.${cls}(?![\\w-])`).test(s.trim())) &&
          /display:\s*none/.test(r.body)
      );
    // Just under the picker's 960px, so no width shows both navs or neither.
    expect(
      hidden('sidebar', /\((?:max-width:\s*959\.98px|width\s*<=\s*959\.98px)/),
      'sidebar when narrow'
    ).toBe(true);
    expect(
      hidden('picker', /\((?:min-width:\s*960px|width\s*>=\s*960px)/),
      'picker when wide'
    ).toBe(true);
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
    // A colour a `pre.astro-code span[style*='#…' i]` rule repaints with the muted token. The
    // minifier may quote the value or emit it as an escaped identifier (`\#…`).
    const repainted = rules
      .filter((r) => /color:\s*var\(--muted\)\s*!important/.test(r.body))
      .flatMap((r) => r.selectors)
      .flatMap(
        (sel) => /^pre\.astro-code span\[style\*=["']?\\?(#[0-9a-f]+)["']? i\]$/i.exec(sel) ?? []
      )
      .filter((m) => m.startsWith('#'))
      .map((m) => m.toLowerCase());
    const colours = new Set(
      [...allHtml.matchAll(/<span style="color:(#[0-9a-f]{6,8})/gi)].map((m) => m[1] as string)
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
    for (const { path, html } of pages) {
      expect(html.match(/<h1[\s>]/g), path).toHaveLength(1);
      const sections = [...html.matchAll(/<section\b[^>]*>/g)].map((m) => m[0]);
      // The landing page: hero, replaces, examples, surfaces, built-on-itself and start.
      if (path === 'index.html') expect(sections).toHaveLength(6);
      for (const s of sections) {
        const by = /aria-labelledby="([^"]+)"/.exec(s)?.[1];
        const named =
          /aria-label="[^"]+"/.test(s) || (by !== undefined && html.includes(`id="${by}"`));
        expect(named, `${path}: ${s}`).toBe(true);
      }
    }
  });

  it('inline scripts stay under 5 KB', () => {
    for (const { path, html } of pages) {
      const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)];
      const bytes = inline.reduce((sum, m) => sum + (m[1] as string).length, 0);
      expect(bytes, path).toBeLessThanOrEqual(5120);
    }
  });

  it('anchors resolve and ids are unique', () => {
    // Each page's ids, keyed by the URL path that serves it.
    const idsAt = new Map(
      pages.map(({ path, html }) => [
        `/substrate/${path.replace(/index\.html$/, '')}`,
        [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] as string)
      ])
    );
    for (const { path, html } of pages) {
      const own = `/substrate/${path.replace(/index\.html$/, '')}`;
      const ids = idsAt.get(own) ?? [];
      expect(
        ids.filter((id, i) => ids.indexOf(id) !== i),
        `${path} duplicate ids`
      ).toEqual([]);
      const missing = [...html.matchAll(/href="(\/substrate\/[^"#]*)?#([^"]*)"/g)]
        .map((m) => ({ page: m[1] ?? own, id: m[2] as string }))
        .filter(({ page, id }) => !idsAt.get(page)?.includes(id))
        .map(({ page, id }) => `${page}#${id}`);
      expect(missing, path).toEqual([]);
    }
  });
});

describe('landing page', () => {
  const examples = /<section[^>]*\sid="examples"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';

  it('links every example', () => {
    const hrefs = [...examples.matchAll(/<a\b[^>]*\shref="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(EXAMPLE_SLUGS.map((s) => pageHref('/substrate', s)));
    for (const slug of EXAMPLE_SLUGS) {
      expect(existsSync(join(dist, 'examples', slug, 'index.html')), slug).toBe(true);
    }
  });

  it('has no inline worked example', () => {
    expect(html).not.toContain('class="steps"');
    expect(html).not.toContain('<figure class="file"');
  });

  it('cards carry their figures', () => {
    const figures = [...examples.matchAll(/<[^>]*\sdata-figure="([^"]*)"[^>]*>/g)];
    expect(figures.map((m) => m[1])).toEqual(EXAMPLE_SLUGS.map((s) => EXAMPLE_FIGURES[s]));
    for (const [tag] of figures) {
      expect(tag).toContain('data-mode="card"');
      expect(tag).toMatch(/\sinert[\s=>]/);
      expect(tag).toContain('aria-hidden="true"');
    }
    for (const [link] of examples.matchAll(/<a\b[\s\S]*?<\/a>/g)) {
      expect(link).not.toContain('data-figure');
    }
    // figures.ts plays a card's figure from its closest `.card`, so each figure sits in one.
    const cards = examples.split(/<li\b[^>]*\sclass="(?:[^"]*\s)?card(?:\s[^"]*)?"/).slice(1);
    expect(cards).toHaveLength(EXAMPLE_SLUGS.length);
    for (const card of cards) {
      const body = card.slice(0, card.indexOf('</li>'));
      expect(body.match(/\sdata-figure="/g)).toHaveLength(1);
    }
    // The figures module is the script that looks up [data-figure].
    const scripts = [...html.matchAll(/<script type="module" src="\/substrate\/([^"]+)"/g)].map(
      (m) => readFileSync(join(dist, m[1] as string), 'utf8')
    );
    expect(scripts.some((code) => code.includes('[data-figure]'))).toBe(true);
  });

  it('keeps the cards announced as a list', () => {
    // The list is unstyled, so Safari needs the role to keep announcing it as a list.
    expect(/<ol\b[^>]*\sclass="cards"[^>]*>/.exec(examples)?.[0]).toContain('role="list"');
  });

  it("sends the hero's examples button to the first example", () => {
    expect(/<a[^>]*\shref="([^"]*)"[^>]*>See the worked examples<\/a>/.exec(html)?.[1]).toBe(
      '/substrate/examples/onboard/'
    );
  });
});
