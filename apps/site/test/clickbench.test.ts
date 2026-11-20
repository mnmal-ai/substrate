import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import data from '../src/data/clickbench.json';
import { summarise } from '../src/lib/clickbench.ts';

const row = (q: number, compared: boolean, p50Ms: number, baselineP50Ms: number) => ({
  q,
  expressible: true,
  compared,
  answersMatch: compared ? (true as boolean | null) : null,
  p50Ms,
  baselineP50Ms
});
const fixture = (rows: ReturnType<typeof row>[]) => ({
  sha: 'x',
  version: '0',
  date: '2026-01-01',
  machine: 'm',
  runs: 1,
  queries: rows
});

describe('summarise', () => {
  it('counts n compared, not 43', () => {
    const s = summarise(fixture([row(0, true, 1, 1), row(1, true, 1, 1), row(2, false, 1, 1)]));
    expect(s.compared).toBe(2);
    expect(s.expressible).toBe(3);
  });
  it('computes the ratios over compared queries only', () => {
    const s = summarise(
      fixture([row(0, true, 100, 80), row(1, true, 60, 50), row(2, false, 10, 1)])
    );
    expect(s.sumRatio).toBe(1.23);
    expect(s.worstRatio).toBe(1.25);
    expect(s.worstQ).toBe(0);
  });
});

describe('committed ClickBench data', () => {
  it('has 43 queries, 3 runs, 3 passes and only schema fields', () => {
    expect(Object.keys(data).sort()).toEqual(
      ['date', 'machine', 'passes', 'queries', 'runs', 'sha', 'version'].sort()
    );
    expect(data.queries).toHaveLength(43);
    expect(data.runs).toBe(3);
    expect(data.passes).toHaveLength(3);
    for (const q of data.queries) {
      expect(Object.keys(q).sort()).toEqual(
        ['answersMatch', 'baselineP50Ms', 'compared', 'expressible', 'p50Ms', 'q'].sort()
      );
      // null only where nothing was compared
      expect(q.answersMatch === null).toBe(!q.compared);
    }
    for (const p of data.passes)
      expect(Object.keys(p).sort()).toEqual(['sumRatio', 'worstQ', 'worstRatio']);
    expect(JSON.stringify(data)).not.toMatch(/\/mnt|\/home|clickbench_lab/);
  });
});

describe('built page', () => {
  const html = readFileSync(
    new URL('../dist/examples/warehouse/index.html', import.meta.url),
    'utf8'
  );
  it('leads with n/43 compared and never puts 43/43 beside compared or match', () => {
    const s = summarise(data);
    expect(s.compared).toBeLessThan(43);
    expect(html).toContain(
      `${s.compared}/43 compared, all matching · ${s.expressible}/43 expressible as frames · ${s.sumRatio}×`
    );
    expect(html).not.toMatch(/43\/43[^·<]{0,24}(compar|match)|(compar|match)[^·<]{0,24}43\/43/);
  });
});
