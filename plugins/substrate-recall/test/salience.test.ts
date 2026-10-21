/**
 * Salience surface tests.
 *
 * Covers the per-row attention signal across all three layers:
 *   - InMemoryEmbeddingsStore.boostSalience + knnSearch salience field
 *   - PgEmbeddingsStore SQL shape for boost + knnSearch projection + upsert
 *     preserves salience columns
 *   - recall-route blend formula, async boost firing, _salience + _blendedScore
 *     envelope fields
 *
 * The pg-shape tests use the FakeSql pattern from pg-embeddings-store.test.ts —
 * the SQL text is captured + asserted on; no live db needed.
 */

import { FakeEmbedder } from '@mnmal-ai/substrate-embedder/fake';
import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingsStore, EmbeddingsStoreKnnInput } from '../src/embeddings-store.js';
import { InMemoryEmbeddingsStore } from '../src/in-memory-embeddings-store.js';
import { PgEmbeddingsStore } from '../src/pg-embeddings-store.js';
import { handleRecallRequest } from '../src/recall-route.js';

function vec(seed: number, dim = 8): Float32Array {
  return Float32Array.from({ length: dim }, (_, i) => Math.sin(seed + i));
}

// --- FakeSql harness (mirrors pg-embeddings-store.test.ts) ---

interface Captured {
  text: string;
  values: unknown[];
}

interface FakeSql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  begin: (cb: (tx: FakeSql) => Promise<unknown>) => Promise<unknown>;
  unsafe: (text: string) => Promise<unknown>;
}

function makeFakeSql(handler: (text: string, values: unknown[]) => unknown): {
  sql: FakeSql;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fn = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    calls.push({ text, values });
    return handler(text, values);
  }) as FakeSql;
  fn.begin = async (cb) => cb(fn);
  fn.unsafe = async (text: string) => {
    calls.push({ text, values: [] });
    return [];
  };
  return { sql: fn, calls };
}

// --- InMemoryEmbeddingsStore tests ---

describe('InMemoryEmbeddingsStore.boostSalience', () => {
  it('increments salience by +1 with decay applied (no prior boost = no decay)', async () => {
    const store = new InMemoryEmbeddingsStore();
    await store.upsert({
      rowNamespace: 'demo',
      rowType: 'Doc',
      rowId: 'd1',
      vector: vec(1),
      model: 'fake:v1'
    });

    await store.boostSalience([{ namespace: 'demo', type: 'Doc', id: 'd1' }], 24 * 7);

    const results = await store.knnSearch({
      namespace: 'demo',
      type: 'Doc',
      model: 'fake:v1',
      vector: vec(1),
      k: 1
    });
    // Salience starts at 0, decay factor on elapsed=~0 is ~1, so +1 → 1.
    expect(results[0]?.salience).toBeCloseTo(1, 5);
  });

  it('applies exponential decay between successive boosts', async () => {
    const store = new InMemoryEmbeddingsStore();
    await store.upsert({
      rowNamespace: 'demo',
      rowType: 'Doc',
      rowId: 'd1',
      vector: vec(1),
      model: 'fake:v1'
    });

    // Boost 100 times back-to-back with a 1-hour half-life. Effective ceiling
    // converges on 1 / (1 - exp(-elapsed/halfLife)); for elapsed≈0 the ceiling
    // is unbounded but each step's value is at most prior + 1.
    for (let i = 0; i < 5; i++) {
      await store.boostSalience([{ namespace: 'demo', type: 'Doc', id: 'd1' }], 1);
    }
    const { rows: r1 } = await readSalience(store, 'demo', 'Doc', 'd1');
    expect(r1[0]?.salience).toBeGreaterThan(4); // 5 boosts in tight loop
    expect(r1[0]?.salience).toBeLessThanOrEqual(5);
  });

  it('halves salience over one half-life', async () => {
    const store = new InMemoryEmbeddingsStore();
    await store.upsert({
      rowNamespace: 'demo',
      rowType: 'Doc',
      rowId: 'd1',
      vector: vec(1),
      model: 'fake:v1'
    });
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    try {
      await store.boostSalience([{ namespace: 'demo', type: 'Doc', id: 'd1' }], 10);
      vi.setSystemTime(new Date('2026-01-01T10:00:00Z'));
      await store.boostSalience([{ namespace: 'demo', type: 'Doc', id: 'd1' }], 10, 0);
    } finally {
      vi.useRealTimers();
    }
    const { rows } = await readSalience(store, 'demo', 'Doc', 'd1');
    expect(rows[0]?.salience).toBeCloseTo(0.5, 5);
  });

  it('no-ops for missing rows, and SAYS SO', async () => {
    const store = new InMemoryEmbeddingsStore();
    // Boost against a row that was never upserted. Not an error — a
    // just-deleted row must not fail a caller — but not silent either: the
    // empty result is what lets /substrate/v1/salience/boost report `applied: 0`.
    await expect(
      store.boostSalience([{ namespace: 'demo', type: 'Doc', id: 'nope' }], 168)
    ).resolves.toEqual([]);
  });

  it('handles multiple targets in one call', async () => {
    const store = new InMemoryEmbeddingsStore();
    for (const id of ['a', 'b', 'c']) {
      await store.upsert({
        rowNamespace: 'demo',
        rowType: 'Doc',
        rowId: id,
        vector: vec(1),
        model: 'fake:v1'
      });
    }
    await store.boostSalience(
      [
        { namespace: 'demo', type: 'Doc', id: 'a' },
        { namespace: 'demo', type: 'Doc', id: 'b' },
        { namespace: 'demo', type: 'Doc', id: 'c' }
      ],
      168
    );
    for (const id of ['a', 'b', 'c']) {
      const { rows } = await readSalience(store, 'demo', 'Doc', id);
      expect(rows[0]?.salience).toBeCloseTo(1, 5);
    }
  });

  it('upsert preserves salience when re-embedding an existing row', async () => {
    const store = new InMemoryEmbeddingsStore();
    await store.upsert({
      rowNamespace: 'demo',
      rowType: 'Doc',
      rowId: 'd1',
      vector: vec(1),
      model: 'fake:v1'
    });
    await store.boostSalience([{ namespace: 'demo', type: 'Doc', id: 'd1' }], 168);

    // Re-embed (e.g. reindex script run, embedder model bump). Salience
    // accumulated from prior boosts MUST persist.
    await store.upsert({
      rowNamespace: 'demo',
      rowType: 'Doc',
      rowId: 'd1',
      vector: vec(2),
      model: 'fake:v2'
    });
    const { rows } = await readSalience(store, 'demo', 'Doc', 'd1', 'fake:v2');
    expect(rows[0]?.salience).toBeCloseTo(1, 5);
  });
});

describe('InMemoryEmbeddingsStore.knnSearch', () => {
  it('returns salience=0 for never-boosted rows', async () => {
    const store = new InMemoryEmbeddingsStore();
    await store.upsert({
      rowNamespace: 'demo',
      rowType: 'Doc',
      rowId: 'd1',
      vector: vec(1),
      model: 'fake:v1'
    });
    const r = await store.knnSearch({
      namespace: 'demo',
      type: 'Doc',
      model: 'fake:v1',
      vector: vec(1),
      k: 1
    });
    expect(r[0]?.salience).toBe(0);
  });
});

async function readSalience(
  store: InMemoryEmbeddingsStore,
  ns: string,
  type: string,
  id: string,
  model = 'fake:v1'
): Promise<{ rows: Array<{ salience: number }> }> {
  const rows = await store.knnSearch({
    namespace: ns,
    type,
    model,
    vector: vec(1),
    k: 100
  });
  return { rows: rows.filter((r) => (r.row as { id?: string }).id === id) };
}

// --- PgEmbeddingsStore SQL-shape tests ---

describe('PgEmbeddingsStore.boostSalience', () => {
  it('emits ONE decay-then-add UPDATE for N targets (batched via VALUES join)', async () => {
    const { sql, calls } = makeFakeSql(() => []);
    const store = new PgEmbeddingsStore({ sql: sql as unknown as import('postgres').Sql });
    await store.boostSalience(
      [
        { namespace: 'claude', type: 'Decision', id: 'r1' },
        { namespace: 'claude', type: 'Decision', id: 'r2' },
        { namespace: 'claude', type: 'Decision', id: 'r3' }
      ],
      24 * 7
    );
    const updates = calls.filter((c) => c.text.includes('UPDATE embeddings'));
    // A single round-trip regardless of target count.
    expect(updates).toHaveLength(1);
    const [u] = updates;
    // Decay formula present
    expect(u?.text).toContain('exp');
    expect(u?.text).toContain('salience_updated_at');
    expect(u?.text).toContain('e.salience');
    // VALUES-driven join replaces per-row WHERE
    expect(u?.text).toContain('FROM (VALUES');
    expect(u?.text).toContain('AS t(ns, ty, id)');
    expect(u?.text).toContain('e.row_namespace = t.ns');
    expect(u?.text).toContain('e.row_type      = t.ty');
    expect(u?.text).toContain('e.row_id        = t.id');
    // Half-life threaded as a bound parameter (7d in seconds)
    expect(u?.values).toContain(24 * 7 * 3600);
  });

  it('threads the bump multiplier through as a bound parameter (spread path)', async () => {
    const { sql, calls } = makeFakeSql(() => []);
    const store = new PgEmbeddingsStore({ sql: sql as unknown as import('postgres').Sql });
    // Spread-path call: damped bump of 0.3 (the spread default).
    await store.boostSalience([{ namespace: 'claude', type: 'Decision', id: 'r1' }], 168, 0.3);
    const updates = calls.filter((c) => c.text.includes('UPDATE embeddings'));
    expect(updates).toHaveLength(1);
    // 0.3 must reach the SQL as a bound value (not literal-inlined).
    expect(updates[0]?.values).toContain(0.3);
  });

  it('no-ops for empty target list (no SQL fired)', async () => {
    const { sql, calls } = makeFakeSql(() => []);
    const store = new PgEmbeddingsStore({ sql: sql as unknown as import('postgres').Sql });
    await store.boostSalience([], 168);
    expect(calls).toHaveLength(0);
  });
});

describe('PgEmbeddingsStore.knnSearch', () => {
  it('projects salience as a column from embeddings', async () => {
    const { sql, calls } = makeFakeSql(() => []);
    const store = new PgEmbeddingsStore({ sql: sql as unknown as import('postgres').Sql });
    await store.knnSearch({
      namespace: 'claude',
      type: 'Decision',
      model: 'bge-m3:1024',
      vector: vec(0, 1),
      k: 10
    });
    const select = calls.find((c) => c.text.includes('SELECT'));
    expect(select?.text).toContain('e.salience');
    expect(select?.text).toContain('AS salience');
  });
});

describe('PgEmbeddingsStore.upsert', () => {
  it('ON CONFLICT updates ONLY embedding/model/updated_at — never salience columns', async () => {
    const { sql, calls } = makeFakeSql(() => []);
    const store = new PgEmbeddingsStore({ sql: sql as unknown as import('postgres').Sql });
    await store.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'r1',
      vector: vec(0, 1),
      model: 'bge-m3:1024'
    });
    const insert = calls.find((c) => c.text.includes('INSERT INTO embeddings'));
    expect(insert?.text).toContain('ON CONFLICT');
    expect(insert?.text).toContain('embedding  = EXCLUDED.embedding');
    // The critical assertion: salience must NOT be in the SET clause.
    expect(insert?.text).not.toContain('salience = EXCLUDED.salience');
    expect(insert?.text).not.toContain('salience_updated_at = EXCLUDED.salience_updated_at');
  });
});

// --- recall-route blend + async boost ---

describe('handleRecallRequest salience blend', () => {
  function makeStore(rows: Array<{ id: string; score: number; salience: number }>): {
    store: EmbeddingsStore;
    boostCalls: Array<ReadonlyArray<{ namespace: string; type: string; id: string }>>;
  } {
    const boostCalls: Array<ReadonlyArray<{ namespace: string; type: string; id: string }>> = [];
    const store: EmbeddingsStore = {
      txScopeId: 'test',
      delete: async () => undefined,
      upsert: async () => undefined,
      knnSearch: async (_input: EmbeddingsStoreKnnInput) =>
        rows.map((r) => ({ row: { id: r.id }, score: r.score, salience: r.salience })),
      boostSalience: async (targets) => {
        boostCalls.push(targets);
        return targets;
      },
      fetchEmbeddings: async () => [],
      selectCandidates: async () => []
    };
    return { store, boostCalls };
  }

  it('weight=0 leaves order unchanged and _blendedScore == score', async () => {
    const { store } = makeStore([
      { id: 'a', score: 0.9, salience: 0 },
      { id: 'b', score: 0.5, salience: 100 }, // high salience but lower cosine
      { id: 'c', score: 0.3, salience: 0 }
    ]);
    const out = await handleRecallRequest(
      { query: 'q', namespace: 'demo', type: 'Doc' },
      {
        embedder: new FakeEmbedder({ dimension: 8 }),
        store,
        salience: { weight: 0, halfLifeHours: 168, spreadDamping: 0 }
      }
    );
    expect(out.rows.map((r) => (r.row as { id: string }).id)).toEqual(['a', 'b', 'c']);
    for (const r of out.rows) expect(r._blendedScore).toBe(r.score);
  });

  it('weight>0 reorders by blendedScore and surfaces _salience + _blendedScore', async () => {
    const { store } = makeStore([
      { id: 'a', score: 0.9, salience: 0 },
      { id: 'b', score: 0.5, salience: 1000 } // huge salience overwhelms 0.5
    ]);
    const out = await handleRecallRequest(
      { query: 'q', namespace: 'demo', type: 'Doc' },
      {
        embedder: new FakeEmbedder({ dimension: 8 }),
        store,
        salience: { weight: 1, halfLifeHours: 168, spreadDamping: 0 }
      }
    );
    // 0.9 * (1 + 1 * log(1+0))    = 0.9
    // 0.5 * (1 + 1 * log(1+1000)) = 0.5 * (1 + ~6.91) = ~3.95
    expect((out.rows[0]!.row as { id: string }).id).toBe('b');
    expect((out.rows[1]!.row as { id: string }).id).toBe('a');
    expect(out.rows[0]?._blendedScore).toBeGreaterThan(out.rows[0]?.score ?? 0);
    expect(out.rows[0]?._salience).toBe(1000);
    expect(out.rows[1]?._salience).toBe(0);
  });

  it('fires boostSalience on returned ids without awaiting', async () => {
    const { store, boostCalls } = makeStore([
      { id: 'a', score: 0.9, salience: 0 },
      { id: 'b', score: 0.5, salience: 0 }
    ]);
    await handleRecallRequest(
      { query: 'q', namespace: 'demo', type: 'Doc' },
      {
        embedder: new FakeEmbedder({ dimension: 8 }),
        store,
        salience: { weight: 0, halfLifeHours: 168, spreadDamping: 0 },
        // The boost is a write and fails closed without a write policy.
        checkWritePolicy: () => ({ allow: true })
      }
    );
    // boostSalience is void Promise — give the microtask queue one tick.
    await new Promise((r) => setImmediate(r));
    expect(boostCalls).toHaveLength(1);
    expect(boostCalls[0]?.map((t) => t.id)).toEqual(['a', 'b']);
    for (const t of boostCalls[0] ?? []) {
      expect(t.namespace).toBe('demo');
      expect(t.type).toBe('Doc');
    }
  });

  it('skips boost when no rows are returned', async () => {
    const { store, boostCalls } = makeStore([]);
    await handleRecallRequest(
      { query: 'q', namespace: 'demo', type: 'Doc' },
      {
        embedder: new FakeEmbedder({ dimension: 8 }),
        store,
        salience: { weight: 0, halfLifeHours: 168, spreadDamping: 0 }
      }
    );
    await new Promise((r) => setImmediate(r));
    expect(boostCalls).toHaveLength(0);
  });
});
