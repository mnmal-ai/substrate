/**
 * A row filter hides rows from a paged read. What the page says about the rows
 * after it (`hasMore`, an empty page with a cursor) must depend only on rows
 * the caller may see, or a `where` on a hidden row's field becomes a yes/no
 * probe of that field.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { expect, it } from 'vitest';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '../src/index.js';

type Thing = { id: number; owner: string; secret: string };

/** A store of `rows` read in pages, filtered by an equality `where` before paging, as a dataset does. */
function build(rows: Thing[]) {
  let reads = 0;
  const starts: string[] = [];
  const registry = new Registry();
  registry.register('Thing', {
    kind: 'type',
    fields: {
      owner: { kind: 'scalar', type: 'string' },
      secret: { kind: 'scalar', type: 'string' }
    },
    policy: () => ({
      allow: true,
      obligations: [
        { kind: 'row-filter', predicate: (_ctx: unknown, row: Thing) => row.owner === 'me' }
      ]
    }),
    resolver: async (_ctx, args) => {
      reads++;
      starts.push(String(args.params?.cursor ?? 'start'));
      const where = (args.params?.where ?? {}) as { secret?: { eq: string } };
      const matching = rows.filter(
        (r) => where.secret === undefined || r.secret === where.secret.eq
      );
      const start = Number(args.params?.cursor ?? 0);
      const limit = Number(args.params?.limit ?? 2);
      const page = matching.slice(start, start + limit);
      const end = start + page.length;
      return {
        rows: page,
        hasMore: end < matching.length,
        ...(end < matching.length ? { nextCursor: String(end) } : {})
      };
    }
  });
  const datasets = new MemoryDatasetRegistry();
  datasets.set('app', new MemoryDataset({ namespace: 'app' }));
  const engine = new Engine({
    namespaces: new Map<string, NamespaceConfig>([['app', { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date() })
  });
  const read = async (params: Record<string, unknown>) => {
    const res = await engine.query({
      frame: { 'app/Thing': { params, fields: { id: true } } },
      ctx: { identity: null }
    });
    expect(res.errors ?? []).toEqual([]);
    return {
      ids: (res.data['app/Thing'] as Thing[]).map((r) => r.id),
      page: res._pagination?.['app/Thing']
    };
  };
  return { read, reads: () => reads, starts, engine };
}

const mine = (id: number, secret = 'x'): Thing => ({ id, owner: 'me', secret });
const theirs = (id: number, secret = 'x'): Thing => ({ id, owner: 'them', secret });

it('answers the same for a predicate that matches only hidden rows as for one that matches nothing', async () => {
  const { read } = build([mine(1, 'a'), theirs(2, 'k'), theirs(3, 'k'), theirs(4, 'k')]);
  const hit = await read({ where: { secret: { eq: 'k' } }, limit: 2 });
  const miss = await read({ where: { secret: { eq: 'nope' } }, limit: 2 });
  expect(hit).toEqual({ ids: [], page: { hasMore: false } });
  expect(miss).toEqual(hit);
});

it('says more only when a row the caller may see comes after the page', async () => {
  // One visible row, then only hidden rows.
  const tail = build([mine(1), theirs(2), theirs(3), theirs(4), theirs(5)]);
  expect(await tail.read({ limit: 1 })).toEqual({ ids: [1], page: { hasMore: false } });

  // A visible row after a run of hidden ones.
  const later = build([mine(1), theirs(2), theirs(3), theirs(4), mine(5)]);
  const first = await later.read({ limit: 1 });
  expect(first.ids).toEqual([1]);
  expect(first.page?.hasMore).toBe(true);
  const second = await later.read({ limit: 1, cursor: first.page?.nextCursor });
  expect(second).toEqual({ ids: [5], page: { hasMore: false } });
});

it('fills a page past hidden rows and never returns more than the limit', async () => {
  const { read } = build([theirs(1), mine(2), theirs(3), theirs(4), mine(5), mine(6), mine(7)]);
  const first = await read({ limit: 2 });
  expect(first.ids).toEqual([2, 5]);
  expect(first.page?.hasMore).toBe(true);
  const second = await read({ limit: 2, cursor: first.page?.nextCursor });
  expect(second).toEqual({ ids: [6, 7], page: { hasMore: false } });
});

it('reads past a long run of hidden rows in a few chunks', async () => {
  const hidden = Array.from({ length: 3000 }, (_, i) => theirs(i + 1));
  const { read, reads } = build([...hidden, mine(3001), mine(3002)]);
  // With limit 1 the run is far longer than ten pages; it is still crossed in one read.
  const first = await read({ limit: 1 });
  expect(first.ids).toEqual([3001]);
  expect(first.page?.hasMore).toBe(true);
  expect(reads()).toBeLessThan(25);
  expect(await read({ limit: 1, cursor: first.page?.nextCursor })).toEqual({
    ids: [3002],
    page: { hasMore: false }
  });
});

it('stops after a bounded scan of hidden rows and lets the caller page on', async () => {
  const hidden = Array.from({ length: 12_000 }, (_, i) => theirs(i + 1));
  const { read, reads } = build([...hidden, mine(12_001)]);
  const first = await read({ limit: 2 });
  expect(first.ids).toEqual([]);
  expect(first.page?.hasMore).toBe(true);
  expect(reads()).toBeLessThan(40);

  // Paging on from each cursor reaches the visible row in the end.
  let cursor = first.page?.nextCursor;
  let found: number[] = [];
  for (let i = 0; i < 10 && cursor !== undefined && found.length === 0; i++) {
    const next = await read({ limit: 2, cursor });
    found = next.ids;
    cursor = next.page?.hasMore ? next.page.nextCursor : undefined;
  }
  expect(found).toEqual([12_001]);
});

it('ends a full page on the last row shown, not on a hidden row after it', async () => {
  const { read, starts } = build([mine(1), theirs(2), theirs(3), mine(4)]);
  const first = await read({ limit: 1 });
  expect(first.ids).toEqual([1]);
  starts.length = 0;
  const second = await read({ limit: 1, cursor: first.page?.nextCursor });
  expect(second.ids).toEqual([4]);
  // The store is asked to continue after row 1, the row the caller saw.
  expect(starts[0]).toBe('1');
});

it('opens a cursor only for the read it was issued for', async () => {
  const { read, engine } = build([mine(1, 'a'), theirs(2, 'a'), mine(3, 'a'), mine(4, 'b')]);
  const first = await read({ where: { secret: { eq: 'a' } }, limit: 1 });
  const cursor = first.page?.nextCursor;
  expect((await read({ where: { secret: { eq: 'a' } }, limit: 1, cursor })).ids).toEqual([3]);
  for (const params of [
    { limit: 1, cursor },
    { where: { secret: { eq: 'b' } }, limit: 1, cursor },
    { where: { secret: { eq: 'a' } }, orderBy: [{ owner: 'asc' }], limit: 1, cursor }
  ]) {
    const res = await engine.query({
      frame: { 'app/Thing': { params, fields: { id: true } } },
      ctx: { identity: null }
    });
    expect(res.errors?.[0]?.code).toBe('invalid_cursor');
  }
});
