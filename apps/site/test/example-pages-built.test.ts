import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXAMPLE_FIGURES, EXAMPLE_SLUGS, neighbours, pageHref } from '../src/lib/example-pages.ts';

const dist = new URL('../dist/', import.meta.url).pathname;
const pagesDir = join(dist, 'examples');
const built = existsSync(pagesDir) ? readdirSync(pagesDir) : [];
const pages = EXAMPLE_SLUGS.map((slug, index) => ({
  slug,
  index,
  nn: String(index + 1).padStart(2, '0'),
  html: existsSync(join(pagesDir, slug, 'index.html'))
    ? readFileSync(join(pagesDir, slug, 'index.html'), 'utf8')
    : ''
}));
const hrefs = EXAMPLE_SLUGS.map((slug) => pageHref('/substrate', slug));
const meta = (html: string, key: string) =>
  new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`).exec(html)?.[1];
const sectionHtml = (html: string, id: string) =>
  new RegExp(`<section[^>]*aria-labelledby="${id}"[^>]*>([\\s\\S]*?)</section>`).exec(html)?.[1];

describe('example pages', () => {
  it('builds one page per example', () => {
    expect(new Set(built)).toEqual(new Set(EXAMPLE_SLUGS));
  });

  it('titles and share tags', () => {
    for (const { slug, html } of pages) {
      const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
      expect(title, slug).toBe(`${slug} · substrate examples`);
      expect(meta(html, 'og:title'), slug).toBe(title);
      expect(meta(html, 'twitter:title'), slug).toBe(title);
      const description = meta(html, 'description');
      expect(description, slug).toBeTruthy();
      expect(meta(html, 'og:description'), slug).toBe(description);
      expect(meta(html, 'twitter:description'), slug).toBe(description);
      expect(meta(html, 'og:type'), slug).toBe('website');
      expect(meta(html, 'twitter:card'), slug).toBe('summary');
      const url = `https://mnmal-ai.github.io/substrate/examples/${slug}/`;
      expect(meta(html, 'og:url'), slug).toBe(url);
      expect(/<link rel="canonical" href="([^"]*)"/.exec(html)?.[1], slug).toBe(url);
      expect(html, slug).not.toContain('og:image');
    }
  });

  it('anatomy in order', () => {
    for (const { slug, nn, html } of pages) {
      const label = /<p class="label[^>]*>([^<]*)<\/p>\s*<h1[\s>]/.exec(html)?.[1];
      expect(label, slug).toContain(`${nn} · ${slug}`);
      const heads = [...html.matchAll(/<section\b[\s\S]*?<h2[^>]*>([^<]*)</g)];
      expect(
        heads.map((m) => m[1]),
        slug
      ).toEqual(['What it shows', 'Elsewhere', 'On substrate', 'Where it stops']);
      expect(sectionHtml(html, 'shows')?.match(/<li[\s>]/g), slug).toHaveLength(3);
    }
  });

  it('navigation', () => {
    for (const { slug, index, html } of pages) {
      const navs = [
        ...html.matchAll(/<nav[^>]*aria-label="Worked examples"[^>]*>([\s\S]*?)<\/nav>/g)
      ].map((m) => m[1] as string);
      expect(navs.length, slug).toBeGreaterThan(0);
      for (const nav of navs) {
        expect(
          [...nav.matchAll(/href="([^"]*)"/g)].map((m) => m[1]),
          slug
        ).toEqual(hrefs);
        const current = [...nav.matchAll(/<a [^>]*aria-current="page"[^>]*>/g)].map((m) => m[0]);
        expect(current, slug).toHaveLength(1);
        expect(current[0], slug).toContain(`href="${hrefs[index]}"`);
      }
      const more =
        /<nav[^>]*aria-label="More examples"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '';
      const link = (rel: string) =>
        new RegExp(`<a [^>]*rel="${rel}"[^>]*>`).exec(more)?.[0].match(/href="([^"]*)"/)?.[1];
      const { prev, next } = neighbours(hrefs, index);
      expect(link('prev'), `${slug} previous`).toBe(prev);
      expect(link('next'), `${slug} next`).toBe(next);
    }
  });

  it('recall page', () => {
    const html = pages.find((p) => p.slug === 'recall')?.html ?? '';
    const live = existsSync(new URL('../examples/recall/output.live.json', import.meta.url));
    expect(html.includes('appears on the published site')).toBe(!live);
    expect(html.includes('class="steps"')).toBe(live);
    expect(html).toContain('examples/recall/namespace.ts');
  });

  it('extras', () => {
    for (const { slug, html } of pages) {
      expect(html.includes('The same frame, three ways'), slug).toBe(slug === 'onboard');
      expect(html.includes('/43 compared'), slug).toBe(slug === 'warehouse');
    }
    // The ClickBench block sits in On substrate, after the run.
    const warehouse = pages.find((p) => p.slug === 'warehouse')?.html ?? '';
    const onSubstrate = sectionHtml(warehouse, 'on-substrate') ?? '';
    expect(onSubstrate.indexOf('/43 compared')).toBeGreaterThan(
      onSubstrate.indexOf('class="steps"')
    );
  });

  it('figure', () => {
    for (const { slug, html } of pages) {
      const figures = [...html.matchAll(/<[^>]*data-figure="([^"]*)"[^>]*>/g)];
      expect(figures, slug).toHaveLength(1);
      const [tag, name] = figures[0] ?? [];
      expect(name, slug).toBe(EXAMPLE_FIGURES[slug]);
      expect(tag, slug).toContain('data-mode="page"');
      expect(tag, slug).not.toMatch(/\sinert[\s=>]|aria-hidden/);
      expect(html.indexOf('data-figure='), slug).toBeLessThan(html.indexOf('<section'));
    }
  });

  it('figure script stays small', () => {
    // A module loads its own static imports too, so they count against the page.
    const loaded = (file: string, seen: Set<string>): number => {
      if (seen.has(file)) return 0;
      seen.add(file);
      const code = readFileSync(file, 'utf8');
      const imports = [...code.matchAll(/(?:from|import)\s*["'](\.{1,2}\/[^"']+)["']/g)];
      return (
        statSync(file).size +
        imports.reduce((sum, m) => sum + loaded(join(dirname(file), m[1] as string), seen), 0)
      );
    };
    for (const { slug, html } of pages) {
      const srcs = [...html.matchAll(/<script type="module" src="\/substrate\/([^"]+)"/g)];
      const seen = new Set<string>();
      const bytes = srcs.reduce((sum, m) => sum + loaded(join(dist, m[1] as string), seen), 0);
      console.log(`${slug}: ${bytes} bytes of module script`);
      expect(srcs.length, slug).toBeGreaterThan(0);
      expect(bytes, slug).toBeLessThanOrEqual(100 * 1024);
    }
  });

  it('credits Hairline', () => {
    const licence = join(dist, 'licenses', 'hairline.txt');
    expect(existsSync(licence)).toBe(true);
    const text = readFileSync(licence, 'utf8');
    expect(text).toContain('MIT License');
    expect(text).toContain('Lucas Marques');
    const landing = readFileSync(join(dist, 'index.html'), 'utf8');
    for (const { slug, html } of [...pages, { slug: 'landing', html: landing }]) {
      const footer = /<footer[\s\S]*<\/footer>/.exec(html)?.[0] ?? '';
      expect(footer, slug).toContain('href="/substrate/licenses/hairline.txt"');
    }
  });
});
