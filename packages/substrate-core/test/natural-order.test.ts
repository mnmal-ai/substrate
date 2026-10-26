/**
 * Natural order: a query with no `orderBy` reads in the type's `orderedBy`,
 * newest-first by `createdAt` when the type declares none. Memory dataset; the
 * pg twin is substrate-dataset-pg/test/natural-order.test.ts. The
 * `defineNamespace` refusals live there, because core cannot import the SDK.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type {
  FieldDef,
  OrderByClause,
  OrderedBy,
  ReadParams,
  ReadResult,
  Row,
  RowMetadata
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '../src/index.js';

const FIELDS: Record<string, FieldDef> = {
  boughtOn: { kind: 'scalar', type: 'date' },
  rating: { kind: 'scalar', type: 'number' }
};

function meta(createdAt: string): RowMetadata {
  return { createdAt, updatedAt: createdAt, createdBy: null, updatedBy: null };
}

/** An engine whose `Item` entry reads the dataset as autoCRUD list does. */
function engineFor(orderedBy?: OrderedBy): {
  engine: Engine;
  ds: MemoryDataset;
  seen: ReadParams[];
} {
  const ds = new MemoryDataset({ namespace: 'shop' });
  const seen: ReadParams[] = [];
  const registry = new Registry();
  registry.register('Item', {
    fields: FIELDS,
    ...(orderedBy !== undefined ? { orderedBy } : {}),
    resolver: async (_ctx, args): Promise<ReadResult> => {
      const p = args.params ?? {};
      const read: ReadParams = {};
      if (p.orderBy !== undefined) read.orderBy = p.orderBy as OrderByClause[];
      if (typeof p.limit === 'number') read.limit = p.limit;
      if (typeof p.cursor === 'string') read.cursor = p.cursor;
      seen.push(read);
      return ds.read('Item', read);
    }
  });
  const datasets = new MemoryDatasetRegistry();
  datasets.set('shop', ds);
  const engine = new Engine({
    namespaces: new Map<string, NamespaceConfig>([['shop', { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date() })
  });
  return { engine, ds, seen };
}

async function ids(engine: Engine, params: Record<string, unknown> = {}): Promise<string[]> {
  const env = await engine.query({
    frame: { 'shop/Item': { params, fields: { id: true } } },
    ctx: { identity: null }
  });
  expect(env.errors).toBeUndefined();
  return (env.data['shop/Item'] as Row[]).map((r) => String(r.id));
}

describe('natural order (memory)', () => {
  it('reads newest-first by createdAt when no orderBy and no orderedBy', async () => {
    const { engine, ds } = engineFor();
    for (const [i, id] of ['a', 'b', 'c'].entries()) {
      await ds.write('Item', [{ id, _metadata: meta(`2026-10-25T00:00:0${i}.000Z`) }]);
    }
    expect(await ids(engine)).toEqual(['c', 'b', 'a']);
  });

  it('reads in the declared orderedBy', async () => {
    const { engine, ds } = engineFor({ boughtOn: 'asc' });
    await ds.write('Item', [
      { id: 'b', boughtOn: '2026-01-02T00:00:00.000Z' },
      { id: 'c', boughtOn: '2026-01-01T00:00:00.000Z' },
      { id: 'a', boughtOn: '2026-01-02T00:00:00.000Z' }
    ]);
    expect(await ids(engine)).toEqual(['c', 'a', 'b']);
  });

  it('an explicit orderBy wins and natural order is not added', async () => {
    const { engine, ds, seen } = engineFor({ boughtOn: 'asc' });
    await ds.write('Item', [
      { id: 'a', rating: 1, boughtOn: '2026-01-01T00:00:00.000Z' },
      { id: 'c', rating: 5, boughtOn: '2026-01-03T00:00:00.000Z' },
      { id: 'b', rating: 5, boughtOn: '2026-01-02T00:00:00.000Z' }
    ]);
    expect(await ids(engine, { orderBy: [{ rating: 'desc' }] })).toEqual(['b', 'c', 'a']);
    expect(seen.at(-1)?.orderBy).toEqual([{ rating: 'desc' }]);
  });

  it('rows missing the orderedBy field sort last and page exactly once', async () => {
    const { engine, ds } = engineFor({ boughtOn: 'asc' });
    const rows = Array.from({ length: 25 }, (_, i) => {
      const id = `r${String(i).padStart(2, '0')}`;
      return i % 5 === 0 ? { id } : { id, boughtOn: `2026-01-${String(i + 1).padStart(2, '0')}` };
    });
    await ds.write('Item', rows);
    const missing = rows.filter((r) => !('boughtOn' in r)).map((r) => r.id);

    const walked: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const env = await engine.query({
        frame: {
          'shop/Item': { params: { limit: 7, ...(cursor ? { cursor } : {}) }, fields: { id: true } }
        },
        ctx: { identity: null }
      });
      expect(env.errors).toBeUndefined();
      walked.push(...(env.data['shop/Item'] as Row[]).map((r) => String(r.id)));
      const pg = env._pagination?.['shop/Item'];
      if (pg?.hasMore !== true) break;
      cursor = pg.nextCursor as string;
    }
    expect([...walked].sort()).toEqual(rows.map((r) => r.id));
    expect(new Set(walked).size).toBe(25);
    expect(walked.slice(-5)).toEqual(missing);
  });
});
