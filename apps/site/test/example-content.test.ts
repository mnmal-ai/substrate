import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import clickbench from '../src/data/clickbench.json';
import { summarise } from '../src/lib/clickbench.ts';
import { EXAMPLE_SLUGS, SECTIONS, unlinkedProducts } from '../src/lib/example-pages.ts';

const dir = new URL('../src/content/examples/', import.meta.url).pathname;
const files = (existsSync(dir) ? readdirSync(dir) : [])
  .filter((f) => f.endsWith('.md'))
  .map((f) => ({ slug: f.slice(0, -3), text: readFileSync(join(dir, f), 'utf8') }));

describe('example content', () => {
  it('all seven examples have a page', () => {
    expect(files.map((f) => f.slug).sort()).toEqual([...EXAMPLE_SLUGS].sort());
  });

  it('every content file is a known example in its place', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const { slug, text } of files) {
      const index = (EXAMPLE_SLUGS as readonly string[]).indexOf(slug);
      expect(index, slug).toBeGreaterThanOrEqual(0);
      expect(Number(/^order:\s*(\d+)$/m.exec(text)?.[1]), slug).toBe(index + 1);
    }
  });

  it('every body has the three sections in order', () => {
    for (const { slug, text } of files) {
      const heads = [...text.matchAll(/^## (.*)$/gm)].map((m) => m[1]?.trim());
      expect(heads, slug).toEqual(SECTIONS.map((s) => s.title));
    }
  });

  it('every product named in Elsewhere links its docs', () => {
    for (const { slug, text } of files) expect(unlinkedProducts(text), slug).toEqual([]);
  });

  it('warehouse quotes the ClickBench count the data file holds', () => {
    const text = readFileSync(join(dir, 'warehouse.md'), 'utf8');
    const quoted = [...text.matchAll(/(\d+) compared \/ (\d+)/g)].map((m) =>
      [m[1], m[2]].map(Number)
    );
    expect(quoted.length).toBeGreaterThan(0);
    for (const pair of quoted) {
      expect(pair).toEqual([summarise(clickbench).compared, clickbench.queries.length]);
    }
  });
});
