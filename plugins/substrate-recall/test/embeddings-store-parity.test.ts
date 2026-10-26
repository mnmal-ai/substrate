/**
 * Parity tests for EmbeddingsStore.fetchEmbeddings — memory vs pg impl.
 *
 * Both impls should return the same (id, vector, row) tuples for the same
 * inputs, silently omit missing IDs, and filter by model.
 */

import postgres from 'postgres';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EmbeddingsStore } from '../src/embeddings-store.js';
import { InMemoryEmbeddingsStore } from '../src/in-memory-embeddings-store.js';
import { embeddingsMigration } from '../src/migrations/0001_embeddings.js';
import { PgEmbeddingsStore } from '../src/pg-embeddings-store.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const isPgGated = POSTGRES_URL !== undefined;
const MODEL = 'm:3';

function vec(seed: number, dim = 768): Float32Array {
  return Float32Array.from({ length: dim }, (_, i) => Math.sin(seed + i));
}

/**
 * Ensure schema is set up — vitest may run test files in any order, and
 * migrate-*.test.ts may drop tables before a given describe block runs.
 * Idempotent (`CREATE TABLE IF NOT EXISTS` + already-idempotent migrations),
 * so every pg-gated describe block below calls it from its own `beforeAll`
 * rather than relying on file declaration order.
 */
async function ensureSchema(url: string): Promise<void> {
  const setupSql = postgres(url);
  try {
    // Create embeddings table + HNSW index + salience columns
    await embeddingsMigration().apply({ sql: setupSql, metric: () => {}, layout: null });
  } finally {
    await setupSql.end();
  }
}

describe.skipIf(!isPgGated)('fetchEmbeddings parity (memory vs pg)', () => {
  let mem: InMemoryEmbeddingsStore;
  let pg: PgEmbeddingsStore;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    if (!isPgGated) return;
    await ensureSchema(POSTGRES_URL as string);
  });

  beforeEach(async () => {
    // _setup.ts global guard already checks for test databases
    sql = postgres(POSTGRES_URL as string);
    mem = new InMemoryEmbeddingsStore();
    pg = new PgEmbeddingsStore({ sql });

    // Clean up embeddings and rows before each test
    await sql`TRUNCATE TABLE embeddings CASCADE`;
    await sql`TRUNCATE TABLE rows CASCADE`;
  });

  afterEach(async () => {
    await sql.end();
  });

  it('returns same set of (id, vector) for both stores', async () => {
    const v1 = vec(1);
    const v2 = vec(2);

    // Insert into both stores
    await mem.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'dec-1',
      vector: v1,
      model: 'm:3'
    });
    await mem.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'dec-2',
      vector: v2,
      model: 'm:3'
    });

    await pg.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'dec-1',
      vector: v1,
      model: 'm:3'
    });
    await pg.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'dec-2',
      vector: v2,
      model: 'm:3'
    });

    // Populate rows so the pg JOIN succeeds
    await sql`
      INSERT INTO rows (namespace, type, id, body)
      VALUES
        ('claude', 'Decision', 'dec-1', ${sql.json({ id: 'dec-1', topic: 'A' })}),
        ('claude', 'Decision', 'dec-2', ${sql.json({ id: 'dec-2', topic: 'B' })})
    `;

    const refs = [
      { namespace: 'claude', type: 'Decision', id: 'dec-1' },
      { namespace: 'claude', type: 'Decision', id: 'dec-2' },
      { namespace: 'claude', type: 'Decision', id: 'missing' }
    ];

    const memOut = await mem.fetchEmbeddings(refs, 'm:3');
    const pgOut = await pg.fetchEmbeddings(refs, 'm:3');

    // Both should return only dec-1 and dec-2 (missing is silently absent)
    expect(memOut.map((r) => r.id).sort()).toEqual(['dec-1', 'dec-2']);
    expect(pgOut.map((r) => r.id).sort()).toEqual(['dec-1', 'dec-2']);

    // Vectors round-trip byte-identical
    const memDec1 = memOut.find((r) => r.id === 'dec-1')!;
    const pgDec1 = pgOut.find((r) => r.id === 'dec-1')!;
    expect(Array.from(memDec1.vector)).toEqual(Array.from(pgDec1.vector));
    // Vectors round-trip (within floating point precision)
    for (let i = 0; i < v1.length; i++) {
      expect(pgDec1.vector[i]).toBeCloseTo(v1[i]!);
    }
  });

  it('carries salience, agreeing across stores before and after a boost', async () => {
    const v = vec(7);
    const ref = { namespace: 'claude', type: 'Decision', id: 'dec-1' };
    for (const store of [mem, pg]) {
      await store.upsert({
        rowNamespace: ref.namespace,
        rowType: ref.type,
        rowId: ref.id,
        vector: v,
        model: 'm:3'
      });
    }
    await sql`
      INSERT INTO rows (namespace, type, id, body)
      VALUES ('claude', 'Decision', 'dec-1', ${sql.json({ id: 'dec-1', topic: 'A' })})
    `;

    // A never-reinforced row reads 0 on both sides, not undefined — the
    // distinction matters downstream, where `log(1 + salience)` on undefined
    // would be NaN and silently sink the row rather than leave it unranked.
    const before = await Promise.all([
      mem.fetchEmbeddings([ref], 'm:3'),
      pg.fetchEmbeddings([ref], 'm:3')
    ]);
    expect(before.map((out) => out[0]?.salience)).toEqual([0, 0]);

    // Both impls must AGREE on what they reinforced, not just on the salience
    // they leave behind: pg learns it from a RETURNING clause and memory from
    // a map-lookup branch, two unrelated mechanisms that can drift.
    const boosted = await Promise.all([
      mem.boostSalience([ref], 168),
      pg.boostSalience([ref], 168)
    ]);
    expect(boosted.map((applied) => applied.length)).toEqual([1, 1]);
    expect(boosted.map((applied) => applied[0])).toEqual([
      { namespace: ref.namespace, type: ref.type, id: ref.id },
      { namespace: ref.namespace, type: ref.type, id: ref.id }
    ]);

    // And on a reference that does not exist: empty from both, no throw.
    const ghost = { namespace: ref.namespace, type: ref.type, id: 'no-such-row' };
    const missed = await Promise.all([
      mem.boostSalience([ghost], 168),
      pg.boostSalience([ghost], 168)
    ]);
    expect(missed).toEqual([[], []]);

    // A single bump on an unreinforced row is exactly 1 in both impls: decay
    // multiplies a zero, so the elapsed-time difference between the two calls
    // cannot show up here. Later bumps diverge by clock skew, which is why
    // this asserts on the first.
    const after = await Promise.all([
      mem.fetchEmbeddings([ref], 'm:3'),
      pg.fetchEmbeddings([ref], 'm:3')
    ]);
    expect(after.map((out) => out[0]?.salience)).toEqual([1, 1]);
  });

  it('knnSearch decays salience to now on pg, by the given half-life', async () => {
    const v = vec(7);
    const ref = { namespace: 'claude', type: 'Decision', id: 'dec-1' };
    await pg.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'dec-1',
      vector: v,
      model: 'm:3'
    });
    await sql`
      INSERT INTO rows (namespace, type, id, body)
      VALUES ('claude', 'Decision', 'dec-1', ${sql.json({ id: 'dec-1' })})
    `;
    await pg.boostSalience([ref], 168);
    // One half-life ago.
    await sql`UPDATE embeddings SET salience_updated_at = now() - interval '10 hours'`;
    const input = { namespace: 'claude', type: 'Decision', model: 'm:3', vector: v, k: 1 };
    const [stored] = await pg.knnSearch(input);
    const [decayed] = await pg.knnSearch({ ...input, salienceHalfLifeHours: 10 });
    expect(stored?.salience).toBeCloseTo(1, 5);
    expect(decayed?.salience).toBeCloseTo(0.5, 3);
  });

  it('empty IDs → empty result, no SQL fired (pg) / no map scan (mem)', async () => {
    const memOut = await mem.fetchEmbeddings([], 'm:3');
    const pgOut = await pg.fetchEmbeddings([], 'm:3');
    expect(memOut).toEqual([]);
    expect(pgOut).toEqual([]);
  });

  it('silently drops IDs without an embedding row', async () => {
    const v1 = vec(1);
    await mem.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'dec-1',
      vector: v1,
      model: 'm:3'
    });
    await pg.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'dec-1',
      vector: v1,
      model: 'm:3'
    });
    await sql`
      INSERT INTO rows (namespace, type, id, body)
      VALUES ('claude', 'Decision', 'dec-1', ${sql.json({ id: 'dec-1' })})
    `;

    const memOut = await mem.fetchEmbeddings(
      [
        { namespace: 'claude', type: 'Decision', id: 'dec-1' },
        { namespace: 'claude', type: 'Decision', id: 'missing' }
      ],
      'm:3'
    );
    const pgOut = await pg.fetchEmbeddings(
      [
        { namespace: 'claude', type: 'Decision', id: 'dec-1' },
        { namespace: 'claude', type: 'Decision', id: 'missing' }
      ],
      'm:3'
    );

    expect(memOut).toHaveLength(1);
    expect(pgOut).toHaveLength(1);
    expect(memOut[0]!.id).toBe('dec-1');
    expect(pgOut[0]!.id).toBe('dec-1');
  });

  it('filters by model — vectors stored under other models are absent', async () => {
    const v1 = vec(1);
    await mem.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'dec-1',
      vector: v1,
      model: 'm:3'
    });
    await pg.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'dec-1',
      vector: v1,
      model: 'm:3'
    });
    await sql`
      INSERT INTO rows (namespace, type, id, body)
      VALUES ('claude', 'Decision', 'dec-1', ${sql.json({ id: 'dec-1' })})
    `;

    const memOut = await mem.fetchEmbeddings(
      [{ namespace: 'claude', type: 'Decision', id: 'dec-1' }],
      'other-model'
    );
    const pgOut = await pg.fetchEmbeddings(
      [{ namespace: 'claude', type: 'Decision', id: 'dec-1' }],
      'other-model'
    );

    expect(memOut).toHaveLength(0);
    expect(pgOut).toHaveLength(0);
  });

  it('returns full row bodies joined to vectors', async () => {
    const v1 = vec(1);
    await mem.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'dec-1',
      vector: v1,
      model: 'm:3'
    });
    await pg.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'dec-1',
      vector: v1,
      model: 'm:3'
    });

    const rowBody = { id: 'dec-1', topic: 'auth', choice: 'rotate', rationale: 'leak' };
    await sql`
      INSERT INTO rows (namespace, type, id, body)
      VALUES ('claude', 'Decision', 'dec-1', ${sql.json(rowBody)})
    `;

    const memOut = await mem.fetchEmbeddings(
      [{ namespace: 'claude', type: 'Decision', id: 'dec-1' }],
      'm:3'
    );
    const pgOut = await pg.fetchEmbeddings(
      [{ namespace: 'claude', type: 'Decision', id: 'dec-1' }],
      'm:3'
    );

    expect(memOut).toHaveLength(1);
    expect(pgOut).toHaveLength(1);
    // pg returns the body as stored, as the dataset read path does.
    expect(pgOut[0]!.row).toEqual(rowBody);
  });

  // Real-PG execution of the batched VALUES-join UPDATE. salience.test.ts only
  // asserts SQL shape against a fake sql; these catch type-inference surprises
  // in the parameterised VALUES list.
  describe('boostSalience (batched VALUES-join)', () => {
    it('applies one decay-then-add across many targets in a single statement', async () => {
      const targets = [
        { namespace: 'claude', type: 'Decision', id: 'd1' },
        { namespace: 'claude', type: 'Decision', id: 'd2' },
        { namespace: 'claude', type: 'Concept', id: 'c1' }
      ];
      for (const t of targets) {
        await pg.upsert({
          rowNamespace: t.namespace,
          rowType: t.type,
          rowId: t.id,
          vector: vec(1),
          model: 'm:3'
        });
      }
      // Fresh rows start at salience 0, salience_updated_at ≈ now ⇒ decay
      // multiplier ≈ 1, so one boost with bump 0.5 lands at ≈ 0.5.
      await pg.boostSalience(targets, 24 * 7, 0.5);
      const rows = await sql<{ row_id: string; salience: number }[]>`
        SELECT row_id, salience FROM embeddings ORDER BY row_id
      `;
      expect(rows.map((r) => r.row_id)).toEqual(['c1', 'd1', 'd2']);
      for (const r of rows) expect(Number(r.salience)).toBeCloseTo(0.5, 5);
    });

    it('silently no-ops targets without an embedding row (join filter)', async () => {
      await pg.upsert({
        rowNamespace: 'claude',
        rowType: 'Decision',
        rowId: 'd1',
        vector: vec(1),
        model: 'm:3'
      });
      await pg.boostSalience(
        [
          { namespace: 'claude', type: 'Decision', id: 'd1' },
          { namespace: 'claude', type: 'Decision', id: 'ghost' }
        ],
        168,
        0.3
      );
      const rows = await sql<{ row_id: string }[]>`SELECT row_id FROM embeddings`;
      expect(rows.map((r) => r.row_id)).toEqual(['d1']);
    });
  });
});

/**
 * Deletion semantics: deleted rows must not surface through recall, and
 * orphaned embeddings must be reapable. Covers the `deleted_at IS NULL`
 * predicate (pg), the skip-deleted iteration (memory), and the purgeOrphans
 * GC backstop.
 */
describe.skipIf(!isPgGated)('deletion semantics', () => {
  let sql: ReturnType<typeof postgres>;

  beforeEach(async () => {
    sql = postgres(POSTGRES_URL as string);
    await sql`TRUNCATE TABLE embeddings CASCADE`;
    await sql`TRUNCATE TABLE rows CASCADE`;
  });

  afterEach(async () => {
    await sql.end();
  });

  async function seedPg(store: PgEmbeddingsStore): Promise<void> {
    await sql`
      INSERT INTO rows (namespace, type, id, body, deleted_at)
      VALUES
        ('claude', 'Decision', 'live-1', ${sql.json({ id: 'live-1', topic: 'live' })}, NULL),
        ('claude', 'Decision', 'del-1',  ${sql.json({ id: 'del-1', topic: 'deleted' })}, now())
    `;
    await store.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'live-1',
      vector: vec(1),
      model: 'm:3'
    });
    await store.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'del-1',
      vector: vec(2),
      model: 'm:3'
    });
  }

  it('pg knnSearch excludes soft-deleted rows even when they score highest', async () => {
    const pg = new PgEmbeddingsStore({ sql });
    await seedPg(pg);
    // Query with del-1's own vector — it would be the top hit without the
    // deleted_at predicate.
    const results = await pg.knnSearch({
      namespace: 'claude',
      type: 'Decision',
      model: 'm:3',
      vector: vec(2),
      k: 5
    });
    expect(results.map((r) => (r.row as { id: string }).id)).toEqual(['live-1']);
  });

  it('pg fetchEmbeddings excludes soft-deleted rows', async () => {
    const pg = new PgEmbeddingsStore({ sql });
    await seedPg(pg);
    const out = await pg.fetchEmbeddings(
      [
        { namespace: 'claude', type: 'Decision', id: 'live-1' },
        { namespace: 'claude', type: 'Decision', id: 'del-1' }
      ],
      'm:3'
    );
    expect(out.map((r) => r.id)).toEqual(['live-1']);
  });

  it('memory knnSearch skips deleted rows and backfills k from live candidates', async () => {
    const liveRow = { id: 'live-1', topic: 'live' };
    const dataset = {
      read: async (_type: string, params: { id: string }) => ({
        rows: params.id === 'live-1' ? [liveRow] : []
      })
    } as unknown as import('@mnmal-ai/substrate-types').Dataset;
    const mem = new InMemoryEmbeddingsStore({ datasetFor: () => dataset });
    await mem.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'live-1',
      vector: vec(1),
      model: 'm:3'
    });
    await mem.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'del-1',
      vector: vec(2),
      model: 'm:3'
    });
    // k=1 with del-1's vector: the deleted top candidate is skipped and the
    // slot backfills with the live row instead of returning a stub.
    const results = await mem.knnSearch({
      namespace: 'claude',
      type: 'Decision',
      model: 'm:3',
      vector: vec(2),
      k: 1
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.row).toEqual(liveRow);
  });

  it('memory fetchEmbeddings skips deleted rows (parity with pg)', async () => {
    const dataset = {
      read: async (_type: string, params: { id: string }) => ({
        rows: params.id === 'live-1' ? [{ id: 'live-1' }] : []
      })
    } as unknown as import('@mnmal-ai/substrate-types').Dataset;
    const mem = new InMemoryEmbeddingsStore({ datasetFor: () => dataset });
    for (const id of ['live-1', 'del-1']) {
      await mem.upsert({
        rowNamespace: 'claude',
        rowType: 'Decision',
        rowId: id,
        vector: vec(1),
        model: 'm:3'
      });
    }
    const out = await mem.fetchEmbeddings(
      [
        { namespace: 'claude', type: 'Decision', id: 'live-1' },
        { namespace: 'claude', type: 'Decision', id: 'del-1' }
      ],
      'm:3'
    );
    expect(out.map((r) => r.id)).toEqual(['live-1']);
  });

  it('purgeOrphans reaps embeddings for tombstoned + hard-deleted rows, keeps live, is idempotent', async () => {
    const pg = new PgEmbeddingsStore({ sql });
    await seedPg(pg); // live-1 (kept) + del-1 (tombstoned → reaped)
    // orphan-1: embedding whose backing row never existed / was hard-deleted
    // (covers the reaper/dropType/dropNamespace paths).
    await pg.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'orphan-1',
      vector: vec(3),
      model: 'm:3'
    });

    const reaped = await pg.purgeOrphans();
    expect(reaped).toBe(2);

    const remaining = await sql<{ row_id: string }[]>`SELECT row_id FROM embeddings`;
    expect(remaining.map((r) => r.row_id)).toEqual(['live-1']);

    expect(await pg.purgeOrphans()).toBe(0);
  });
});

/**
 * knnSearch returnVector parity: both stores surface the stored vector on
 * each hit iff requested; an absent flag leaves the result shape unchanged.
 */
describe.skipIf(!isPgGated)('knnSearch returnVector parity (memory vs pg)', () => {
  let mem: InMemoryEmbeddingsStore;
  let pg: PgEmbeddingsStore;
  let sql: ReturnType<typeof postgres>;

  beforeEach(async () => {
    sql = postgres(POSTGRES_URL as string);
    mem = new InMemoryEmbeddingsStore();
    pg = new PgEmbeddingsStore({ sql });
    await sql`TRUNCATE TABLE embeddings CASCADE`;
    await sql`TRUNCATE TABLE rows CASCADE`;

    const v1 = vec(1);
    for (const store of [mem, pg]) {
      await store.upsert({
        rowNamespace: 'claude',
        rowType: 'Decision',
        rowId: 'dec-1',
        vector: v1,
        model: 'm:3'
      });
    }
    await sql`
      INSERT INTO rows (namespace, type, id, body)
      VALUES ('claude', 'Decision', 'dec-1', ${sql.json({ id: 'dec-1', topic: 'A' })})
    `;
  });

  afterEach(async () => {
    await sql.end();
  });

  it('returnVector: true → each hit carries the upserted vector on both stores', async () => {
    const input = {
      namespace: 'claude',
      type: 'Decision',
      model: 'm:3',
      vector: vec(1),
      k: 5,
      returnVector: true
    };
    const memOut = await mem.knnSearch(input);
    const pgOut = await pg.knnSearch(input);
    expect(memOut).toHaveLength(1);
    expect(pgOut).toHaveLength(1);

    const expected = Array.from(vec(1));
    expect(memOut[0]?.vector).toHaveLength(expected.length);
    expect(pgOut[0]?.vector).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(memOut[0]?.vector?.[i]).toBeCloseTo(expected[i]!);
      expect(pgOut[0]?.vector?.[i]).toBeCloseTo(expected[i]!);
    }
  });

  it('returnVector absent/false → no vector key on either store (byte-identical shape)', async () => {
    const base = {
      namespace: 'claude',
      type: 'Decision',
      model: 'm:3',
      vector: vec(1),
      k: 5
    };
    for (const input of [base, { ...base, returnVector: false }]) {
      const memOut = await mem.knnSearch(input);
      const pgOut = await pg.knnSearch(input);
      expect(memOut[0]).not.toHaveProperty('vector');
      expect(pgOut[0]).not.toHaveProperty('vector');
    }
  });
});

describe.skipIf(!isPgGated)('knnSearch model filter and salience decay (memory vs pg)', () => {
  let sql: ReturnType<typeof postgres>;

  beforeEach(async () => {
    sql = postgres(POSTGRES_URL as string);
    await sql`TRUNCATE TABLE embeddings CASCADE`;
    await sql`TRUNCATE TABLE rows CASCADE`;
  });

  afterEach(async () => {
    await sql.end();
  });

  // Mid-reindex after a same-dimension model switch: the nearest vectors are
  // the old model's, and must not crowd the new model's rows out of the top k.
  it('fills k from the requested model when nearer vectors belong to another', async () => {
    const mem = new InMemoryEmbeddingsStore();
    const pg = new PgEmbeddingsStore({ sql });
    for (let i = 0; i < 20; i++) {
      for (const store of [mem, pg]) {
        await store.upsert({
          rowNamespace: 'app',
          rowType: 'Doc',
          rowId: `old-${i}`,
          vector: vec(1 + i * 0.001),
          model: 'old:768'
        });
      }
      await sql`INSERT INTO rows (namespace, type, id, body) VALUES ('app', 'Doc', ${`old-${i}`}, ${sql.json({})})`;
    }
    for (let i = 0; i < 3; i++) {
      for (const store of [mem, pg]) {
        await store.upsert({
          rowNamespace: 'app',
          rowType: 'Doc',
          rowId: `new-${i}`,
          vector: vec(1.5 + i * 0.01),
          model: 'new:768'
        });
      }
      await sql`INSERT INTO rows (namespace, type, id, body) VALUES ('app', 'Doc', ${`new-${i}`}, ${sql.json({})})`;
    }
    const input = { namespace: 'app', type: 'Doc', model: 'new:768', vector: vec(1), k: 3 };
    expect((await mem.knnSearch(input)).length).toBe(3);
    expect((await pg.knnSearch(input)).length).toBe(3);
  });

  it('an older upsert never replaces a newer vector, on both stores', async () => {
    const mem = new InMemoryEmbeddingsStore();
    const pg = new PgEmbeddingsStore({ sql });
    await sql`INSERT INTO rows (namespace, type, id, body) VALUES ('app', 'Doc', 'd1', ${sql.json({})})`;
    const later = new Date('2026-01-02T00:00:00Z');
    const earlier = new Date('2026-01-01T00:00:00Z');
    for (const store of [mem, pg]) {
      const base = { rowNamespace: 'app', rowType: 'Doc', rowId: 'd1', model: MODEL };
      await store.upsert({ ...base, vector: vec(2), now: later });
      await store.upsert({ ...base, vector: vec(1), now: earlier });
      const [hit] = await store.fetchEmbeddings(
        [{ namespace: 'app', type: 'Doc', id: 'd1' }],
        MODEL
      );
      expect(hit?.vector[0]).toBeCloseTo(vec(2)[0] as number, 5);
    }
  });

  it('halves salience over one half-life on pg', async () => {
    const pg = new PgEmbeddingsStore({ sql });
    await pg.upsert({
      rowNamespace: 'app',
      rowType: 'Doc',
      rowId: 'd1',
      vector: vec(1),
      model: MODEL
    });
    const target = [{ namespace: 'app', type: 'Doc', id: 'd1' }];
    await pg.boostSalience(target, 10);
    await sql`UPDATE embeddings SET salience_updated_at = now() - interval '10 hours'`;
    await pg.boostSalience(target, 10, 0);
    const [row] = await sql<Array<{ salience: number }>>`SELECT salience FROM embeddings`;
    expect(Number(row?.salience)).toBeCloseTo(0.5, 3);
  });
});

/**
 * selectCandidates parity (memory vs pg), the candidate selection for
 * crystallisation. Both must agree on scope filtering, `(namespace, type, id)`
 * ordering, text-prefix exclusion, model isolation, and limit. Each `it` runs
 * one assertion against BOTH stores in a loop so the two cannot drift apart.
 *
 * `seed` wires a body into both stores at once — pg via the `rows` join
 * `selectCandidates` reads, memory via a `datasetFor` callback backed by
 * `memBodies` — so the text-prefix exclusion has a real body on both sides.
 */
describe.skipIf(!isPgGated)('selectCandidates parity (memory vs pg)', () => {
  let mem: InMemoryEmbeddingsStore;
  let pg: PgEmbeddingsStore;
  let sql: ReturnType<typeof postgres>;
  let memBodies: Map<string, Record<string, unknown>>;
  let seedSeq: number;

  beforeAll(async () => {
    await ensureSchema(POSTGRES_URL as string);
  });

  beforeEach(async () => {
    sql = postgres(POSTGRES_URL as string);
    memBodies = new Map();
    seedSeq = 0;
    mem = new InMemoryEmbeddingsStore({
      datasetFor: (namespace) =>
        ({
          read: async (t: string, params: { id: string }) => {
            const body = memBodies.get(`${namespace}/${t}/${params.id}`);
            return { rows: body ? [body] : [] };
          }
        }) as unknown as import('@mnmal-ai/substrate-types').Dataset
    });
    pg = new PgEmbeddingsStore({ sql });
    await sql`TRUNCATE TABLE embeddings CASCADE`;
    await sql`TRUNCATE TABLE rows CASCADE`;
  });

  afterEach(async () => {
    await sql.end();
  });

  // Each seeded row gets a distinct 768-dim vector via the module's `vec`
  // helper. selectCandidates orders by (namespace, type, id), so vector
  // content is irrelevant; the dimension is required only by the
  // `embedding vector(768)` column.
  async function seed(
    namespace: string,
    type: string,
    id: string,
    bodyExtra: Record<string, unknown> = {},
    model = MODEL
  ): Promise<void> {
    seedSeq += 1;
    const vector = vec(seedSeq);
    const body = { id, ...bodyExtra };
    memBodies.set(`${namespace}/${type}/${id}`, body);
    await mem.upsert({ rowNamespace: namespace, rowType: type, rowId: id, vector, model });
    await pg.upsert({ rowNamespace: namespace, rowType: type, rowId: id, vector, model });
    await sql`
      INSERT INTO rows (namespace, type, id, body)
      VALUES (${namespace}, ${type}, ${id}, ${sql.json(body)})
      ON CONFLICT (namespace, type, id) DO UPDATE SET body = EXCLUDED.body
    `;
  }

  function stores(): Array<{ name: string; store: EmbeddingsStore }> {
    return [
      { name: 'memory', store: mem },
      { name: 'pg', store: pg }
    ];
  }

  it('selectCandidates returns scoped rows in (namespace, type, id) order', async () => {
    await seed('cortext', 'Decision', 'd2');
    await seed('cortext', 'Decision', 'd1');
    await seed('cortext', 'Memory', 'm1');
    await seed('other', 'Decision', 'x1');

    for (const { name, store } of stores()) {
      const candidates = await store.selectCandidates(
        {
          scopes: [
            { namespace: 'cortext', type: 'Decision' },
            { namespace: 'cortext', type: 'Memory' }
          ],
          excludeTextPrefixes: [],
          limit: 100
        },
        MODEL
      );

      expect(
        candidates.map((c) => `${c.namespace}/${c.type}/${c.id}`),
        name
      ).toEqual(['cortext/Decision/d1', 'cortext/Decision/d2', 'cortext/Memory/m1']);
      expect(candidates[0]?.vector, name).toBeInstanceOf(Float32Array);
      expect(candidates[0]?.row, name).toBeTypeOf('object');
    }
  });

  it('selectCandidates drops rows matching a text-prefix exclusion', async () => {
    await seed('cortext', 'SessionLog', 's1', { synopsis: 'Seed session 4 of 12' });
    await seed('cortext', 'SessionLog', 's2', { synopsis: 'Real work happened' });

    for (const { name, store } of stores()) {
      const candidates = await store.selectCandidates(
        {
          scopes: [{ namespace: 'cortext', type: 'SessionLog' }],
          excludeTextPrefixes: [{ field: 'synopsis', prefix: 'Seed session ' }],
          limit: 100
        },
        MODEL
      );
      expect(
        candidates.map((c) => c.id),
        name
      ).toEqual(['s2']);
    }
  });

  it('selectCandidates excludes vectors written under a different model', async () => {
    await seed('cortext', 'Decision', 'd1');
    await seed('cortext', 'Decision', 'd2', {}, 'some-other-model:8');

    for (const { name, store } of stores()) {
      const candidates = await store.selectCandidates(
        {
          scopes: [{ namespace: 'cortext', type: 'Decision' }],
          excludeTextPrefixes: [],
          limit: 100
        },
        MODEL
      );
      expect(
        candidates.map((c) => c.id),
        name
      ).toEqual(['d1']);
    }
  });

  it('selectCandidates honours limit', async () => {
    await seed('cortext', 'Decision', 'd1');
    await seed('cortext', 'Decision', 'd2');

    for (const { name, store } of stores()) {
      const candidates = await store.selectCandidates(
        {
          scopes: [{ namespace: 'cortext', type: 'Decision' }],
          excludeTextPrefixes: [],
          limit: 1
        },
        MODEL
      );
      expect(candidates.length, name).toBe(1);
    }
  });

  // A locale collation such as en_US.utf8 does NOT sort in byte order: it
  // interleaves case and punctuation differently. These ids differ in case
  // and punctuation so they discriminate; both sides must agree on byte
  // order (pg pinned to `COLLATE "C"`, memory's `<`/`>`).
  it('selectCandidates orders identically under byte-order collation, not locale collation', async () => {
    await seed('cortext', 'Decision', 'Zebra');
    await seed('cortext', 'Decision', 'apple');
    await seed('cortext', 'Decision', '_under');
    await seed('cortext', 'Decision', 'Apple');

    for (const { name, store } of stores()) {
      const candidates = await store.selectCandidates(
        {
          scopes: [{ namespace: 'cortext', type: 'Decision' }],
          excludeTextPrefixes: [],
          limit: 100
        },
        MODEL
      );
      // Byte order (ASCII code points): 'A' (65) < 'Z' (90) < '_' (95) < 'a' (97).
      expect(
        candidates.map((c) => c.id),
        name
      ).toEqual(['Apple', 'Zebra', '_under', 'apple']);
    }
  });

  // pg's `r.body ->> ex.field` coerces any present JSON scalar to text before
  // matching, so a numeric field is compared as text, not skipped. Memory must
  // do the same.
  it("selectCandidates coerces non-string field values before prefix matching, like pg's ->> operator", async () => {
    await seed('cortext', 'SessionLog', 's1', { synopsis: 12345 });
    await seed('cortext', 'SessionLog', 's2', { synopsis: 'Real work happened' });

    for (const { name, store } of stores()) {
      const candidates = await store.selectCandidates(
        {
          scopes: [{ namespace: 'cortext', type: 'SessionLog' }],
          excludeTextPrefixes: [{ field: 'synopsis', prefix: '123' }],
          limit: 100
        },
        MODEL
      );
      expect(
        candidates.map((c) => c.id),
        name
      ).toEqual(['s2']);
    }
  });

  // The exclusion prefix matches literally on both sides (pg `starts_with()`,
  // memory `startsWith`); under LIKE, '_' and '%' would be wildcards. s2
  // matches only the wildcard reading of the prefix, s1 the literal one.
  it('selectCandidates treats an underscore in the exclusion prefix literally, not as a LIKE wildcard', async () => {
    await seed('cortext', 'SessionLog', 's1', { synopsis: 'perf_seed row' }); // literal match — excluded
    await seed('cortext', 'SessionLog', 's2', { synopsis: 'perfXseed row' }); // wildcard-only match — kept
    await seed('cortext', 'SessionLog', 's3', { synopsis: 'unrelated row' }); // no match — kept

    for (const { name, store } of stores()) {
      const candidates = await store.selectCandidates(
        {
          scopes: [{ namespace: 'cortext', type: 'SessionLog' }],
          excludeTextPrefixes: [{ field: 'synopsis', prefix: 'perf_seed' }],
          limit: 100
        },
        MODEL
      );
      expect(
        candidates.map((c) => c.id),
        name
      ).toEqual(['s2', 's3']);
    }
  });

  // pg's `->>` and JS's `String(value)` render composite (object/array)
  // values differently, so both implementations coerce only scalars and treat
  // a composite value as never-excluded.
  it('selectCandidates never excludes a composite (object/array) field value, on either side', async () => {
    await seed('cortext', 'SessionLog', 's1', { synopsis: { note: 'seed-ish' } });
    await seed('cortext', 'SessionLog', 's2', { synopsis: ['seed', 'ish'] });
    await seed('cortext', 'SessionLog', 's3', { synopsis: 'seed row' });

    for (const { name, store } of stores()) {
      const candidates = await store.selectCandidates(
        {
          scopes: [{ namespace: 'cortext', type: 'SessionLog' }],
          excludeTextPrefixes: [{ field: 'synopsis', prefix: 'seed' }],
          limit: 100
        },
        MODEL
      );
      // s1/s2 (composite values) are never excluded regardless of their
      // rendered text; s3 (a real string) is excluded by the literal prefix.
      expect(
        candidates.map((c) => c.id),
        name
      ).toEqual(['s1', 's2']);
    }
  });
});
