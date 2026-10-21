import { describe, expect, it } from 'vitest';
import { runReindex } from '../src/surgery/reindex.js';

const M = { namespace: 'journal', type: 'Memory' };
const D = { namespace: 'journal', type: 'Decision' };
const pageOf = (over: Record<string, unknown>) => ({
  namespace: 'journal',
  type: 'Memory',
  scanned: 10,
  embedded: 9,
  unindexable: 1,
  failed: 0,
  failures: [],
  hasMore: false,
  ...over
});

describe('runReindex', () => {
  it('pages each type through its cursor and sums progress', async () => {
    const calls: unknown[] = [];
    const pages = [
      pageOf({ hasMore: true, nextCursor: 'c1' }),
      pageOf({}),
      pageOf({ type: 'Decision' })
    ];
    const out = await runReindex(
      [M, D],
      async (i) => {
        calls.push(i);
        return pages.shift()!;
      },
      { stopRequested: () => false, onProgress: () => {} }
    );
    expect(calls).toEqual([
      { namespace: 'journal', type: 'Memory', limit: 200 },
      { namespace: 'journal', type: 'Memory', limit: 200, cursor: 'c1' },
      { namespace: 'journal', type: 'Decision', limit: 200 }
    ]);
    expect(out.kind).toBe('done');
    expect(out.progress[0]).toMatchObject({ scanned: 20, embedded: 18, pages: 2, done: true });
  });

  it('a stop requested mid-run takes effect between pages, reporting where', async () => {
    let n = 0;
    let stop = false;
    const out = await runReindex(
      [M],
      async () => {
        n++;
        stop = true;
        return pageOf({ hasMore: true, nextCursor: `c${n}` });
      },
      { stopRequested: () => stop, onProgress: () => {} }
    );
    expect(n).toBe(1);
    expect(out).toMatchObject({ kind: 'stopped', at: M, cursor: 'c1' });
  });

  it('hasMore without nextCursor fails rather than finishing early', async () => {
    const out = await runReindex([M], async () => pageOf({ hasMore: true }), {
      stopRequested: () => false,
      onProgress: () => {}
    });
    expect(out).toMatchObject({ kind: 'failed', at: M });
  });

  it('a page that throws (503, a lock) fails at that type and keeps earlier progress', async () => {
    let n = 0;
    const out = await runReindex(
      [M, D],
      async () => {
        n++;
        if (n === 2) throw new Error('admin is locked');
        return pageOf({});
      },
      { stopRequested: () => false, onProgress: () => {} }
    );
    expect(out).toMatchObject({ kind: 'failed', at: D });
    expect(out.progress[0]).toMatchObject({ done: true, embedded: 9 });
  });
  it('a stop asked after the last page of one type stops before the next, with no cursor', async () => {
    let n = 0;
    const out = await runReindex(
      [M, D],
      async () => {
        n++;
        return pageOf({});
      },
      { stopRequested: () => true, onProgress: () => {} }
    );
    expect(n).toBe(1);
    expect(out).toMatchObject({ kind: 'stopped', at: D, cursor: undefined });
    expect(out.progress[0]).toMatchObject({ done: true });
    expect(out.progress[1]).toMatchObject({ pages: 0, done: false });
  });
});
