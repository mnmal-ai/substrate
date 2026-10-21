/**
 * Cross-namespace batched mutate against real pg via the engine. Exercises
 * the §5.3 substrate-coalescing path: two PgDataset instances on the
 * SAME postgres pool but different namespaces, all frames in one mutate
 * payload commit atomically as a single tx.
 *
 * Counterpart to the engine-level refusal tests in
 * `packages/substrate-core/test/engine.test.ts` — those cover memory-side
 * refusal + split-hint shape; this covers the pg success + rollback paths.
 */

import {
  Engine,
  MemoryEdgesStore,
  type NamespaceConfig,
  Registry,
  type Resolver
} from '@mnmal-ai/substrate-core';
import type { RequestContext } from '@mnmal-ai/substrate-types';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { PgDataset } from '../src/pg-dataset.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

const NS_A = 'test_xns_coalesce_a';
const NS_B = 'test_xns_coalesce_b';

function ctxFor(ns: string): Partial<RequestContext> {
  return { namespace: ns, identity: null, headers: {}, meta: {} };
}

/** Minimal DatasetRegistry shape the engine consults during mutate. */
class StaticDatasetRegistry {
  constructor(private readonly map: Map<string, PgDataset>) {}
  get(ns: string): PgDataset | undefined {
    return this.map.get(ns);
  }
  has(ns: string): boolean {
    return this.map.has(ns);
  }
  set(ns: string, dataset: PgDataset): void {
    this.map.set(ns, dataset);
  }
}

describe.skipIf(!POSTGRES_URL)('cross-namespace batched mutate (engine + pg)', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    if (!POSTGRES_URL) return;
    sql = postgres(POSTGRES_URL, { onnotice: () => {} });
    await runMigrations(sql);
  });

  beforeEach(async () => {
    await sql`DELETE FROM rows WHERE namespace IN (${NS_A}, ${NS_B})`;
  });

  afterAll(async () => {
    if (POSTGRES_URL) await sql.end();
  });

  it('two pg datasets on the same Sql share a txScopeId; engine coalesces both writes into one tx', async () => {
    const dsA = new PgDataset({ namespace: NS_A, sql });
    const dsB = new PgDataset({ namespace: NS_B, sql });
    expect(dsA.txScopeId).toBe(dsB.txScopeId);

    const regA = new Registry();
    const regB = new Registry();
    const writeA: Resolver = async (_ctx, args) => {
      await args.dataset?.write('Item', [{ id: 'a-1', value: 'one' }]);
      return { id: 'a-1' };
    };
    const writeB: Resolver = async (_ctx, args) => {
      await args.dataset?.write('Item', [{ id: 'b-1', value: 'two' }]);
      return { id: 'b-1' };
    };
    regA.register('writeItem', { resolver: writeA });
    regB.register('writeItem', { resolver: writeB });

    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([
        [NS_A, { registry: regA }],
        [NS_B, { registry: regB }]
      ]),
      datasets: new StaticDatasetRegistry(
        new Map([
          [NS_A, dsA],
          [NS_B, dsB]
        ])
      ),
      edges: new MemoryEdgesStore({ now: () => new Date() })
    });

    const envelope = await engine.mutate({
      frame: {
        [`${NS_A}/writeItem`]: { params: {}, fields: { id: true } },
        [`${NS_B}/writeItem`]: { params: {}, fields: { id: true } }
      },
      ctx: ctxFor(NS_A)
    });

    expect(envelope.errors).toBeUndefined();

    // Both rows persisted via separate datasets that wrote through the same pg tx.
    const { rows: rowsA } = await dsA.read('Item', { limit: 10 });
    const { rows: rowsB } = await dsB.read('Item', { limit: 10 });
    expect(rowsA.map((r) => r.id)).toEqual(['a-1']);
    expect(rowsB.map((r) => r.id)).toEqual(['b-1']);
  });

  it('rollback path: throw in one resolver rolls back the other namespace too', async () => {
    const dsA = new PgDataset({ namespace: NS_A, sql });
    const dsB = new PgDataset({ namespace: NS_B, sql });

    const regA = new Registry();
    const regB = new Registry();
    regA.register('writeItem', {
      resolver: async (_ctx, args) => {
        await args.dataset?.write('Item', [{ id: 'a-rollback', value: 'should-roll-back' }]);
        return { id: 'a-rollback' };
      }
    });
    regB.register('boom', {
      resolver: async () => {
        throw new Error('intentional rollback');
      }
    });

    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([
        [NS_A, { registry: regA }],
        [NS_B, { registry: regB }]
      ]),
      datasets: new StaticDatasetRegistry(
        new Map([
          [NS_A, dsA],
          [NS_B, dsB]
        ])
      ),
      edges: new MemoryEdgesStore({ now: () => new Date() })
    });

    await expect(
      engine.mutate({
        frame: {
          [`${NS_A}/writeItem`]: { params: {}, fields: { id: true } },
          [`${NS_B}/boom`]: { params: {}, fields: { id: true } }
        },
        ctx: ctxFor(NS_A)
      })
    ).rejects.toThrow('intentional rollback');

    // dsA's write rolled back along with dsB's throw — no row persisted.
    const { rows } = await dsA.read('Item', { limit: 10, includeDeleted: true });
    expect(rows).toHaveLength(0);
  });
});
