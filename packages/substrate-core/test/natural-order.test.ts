/**
 * Natural order: a query (and a subscription snapshot, and a stream) with no
 * `orderBy` reads in the type's `orderedBy`,
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
  RowMetadata,
  WsResponseFrame
} from '@mnmal-ai/substrate-types';
import { DEFAULT_ORDERED_BY } from '@mnmal-ai/substrate-types';
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
      const result = ds.read('Item', read);
      // A stream dispatch (it carries the abort signal) takes the rows one by one.
      if (args.signal !== undefined) {
        return (async function* () {
          yield* (await result).rows;
        })() as never;
      }
      return result;
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

  it('a subscription snapshot and a stream read in natural order, as a query does', async () => {
    const { engine, ds, seen } = engineFor({ boughtOn: 'asc' });
    await ds.write('Item', [
      { id: 'b', boughtOn: '2026-01-02T00:00:00.000Z' },
      { id: 'c', boughtOn: '2026-01-01T00:00:00.000Z' },
      { id: 'a', boughtOn: '2026-01-03T00:00:00.000Z' }
    ]);
    const queried = await ids(engine);
    expect(queried).toEqual(['c', 'b', 'a']);

    const frames: WsResponseFrame[] = [];
    const handle = await engine.subscribe({
      id: 'sub',
      frame: { 'shop/Item': { params: {}, fields: { id: true } } },
      ctx: { identity: null },
      onFrame: (f) => void frames.push(f)
    });
    handle.cancel();
    const snapshot = frames.find((f) => f.kind === 'snapshot');
    const snapRows = ((snapshot?.data as Record<string, unknown> | undefined)?.['shop/Item'] ??
      []) as Row[];
    expect(snapRows.map((r) => String(r.id))).toEqual(queried);
    expect(seen.at(-1)?.orderBy).toEqual([{ boughtOn: 'asc' }]);

    const chunks: WsResponseFrame[] = [];
    await engine.stream({
      id: 'str',
      frame: { 'shop/Item': { params: {}, fields: { id: true } } },
      ctx: { identity: null },
      onFrame: (f) => void chunks.push(f)
    });
    for (let i = 0; !chunks.some((f) => f.kind === 'end' || f.kind === 'error'); i++) {
      if (i > 1000) throw new Error('stream did not end');
      await new Promise<void>((r) => setImmediate(r));
    }
    expect(chunks.find((f) => f.kind === 'error')).toBeUndefined();
    expect(
      chunks
        .filter((f) => f.kind === 'chunk')
        .map((f) =>
          String(
            ((f.data as Record<string, unknown> | undefined)?.['shop/Item'] as Row | undefined)?.id
          )
        )
    ).toEqual(queried);

    // An explicit orderBy wins on both.
    await engine.subscribe({
      id: 'sub2',
      frame: { 'shop/Item': { params: { orderBy: [{ boughtOn: 'desc' }] }, fields: { id: true } } },
      ctx: { identity: null },
      onFrame: () => {}
    });
    expect(seen.at(-1)?.orderBy).toEqual([{ boughtOn: 'desc' }]);
  });

  it('the default natural order is frozen', () => {
    expect(Object.isFrozen(DEFAULT_ORDERED_BY)).toBe(true);
  });
});

describe('cursor order signing (memory)', () => {
  async function seeded(): Promise<Engine> {
    const { engine, ds } = engineFor();
    for (let i = 0; i < 6; i++) {
      await ds.write('Item', [
        { id: `r${i}`, rating: i, _metadata: meta(`2026-10-25T00:00:0${i}.000Z`) }
      ]);
    }
    return engine;
  }

  async function refusal(engine: Engine, params: Record<string, unknown>) {
    const env = await engine.query({
      frame: { 'shop/Item': { params: { limit: 2, ...params }, fields: { id: true } } },
      ctx: { identity: null }
    });
    expect('shop/Item' in env.data).toBe(false);
    expect(env.errors?.[0]?.code).toBe('invalid_cursor');
    return env.errors?.[0];
  }

  it('refuses an old-format cursor, which carries no order', async () => {
    const legacy = Buffer.from(JSON.stringify({ orderByValues: ['r3'], id: 'r3' })).toString(
      'base64url'
    );
    const err = await refusal(await seeded(), { cursor: legacy });
    expect(err?.message).toMatch(/carries no 'order'/);
  });

  it('refuses a cursor replayed under a different orderBy', async () => {
    const engine = await seeded();
    const first = await engine.query({
      frame: { 'shop/Item': { params: { limit: 2 }, fields: { id: true } } },
      ctx: { identity: null }
    });
    const cursor = first._pagination?.['shop/Item']?.nextCursor;
    expect(typeof cursor).toBe('string');
    const err = await refusal(engine, { cursor, orderBy: [{ rating: 'desc' }] });
    expect(err?.message).toMatch(/createdAt desc, id asc.*rating desc, id asc/);
  });

  it('refuses a corrupted cursor', async () => {
    await refusal(await seeded(), { cursor: 'not!a~cursor' });
  });
});
