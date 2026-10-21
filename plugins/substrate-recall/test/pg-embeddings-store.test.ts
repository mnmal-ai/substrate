/**
 * PgEmbeddingsStore SQL-shape tests.
 *
 * The caller side is exercised via a stub `EmbeddingsStore` in
 * recall-route.test.ts. These tests cover the pg impl's SQL shape: pgvector text-literal conversion, HNSW GUC scoping,
 * model post-filter, transaction wrapping. They use a stub `Sql` rather
 * than a live db to keep the unit suite hermetic.
 */

import { describe, expect, it, vi } from 'vitest';
import { PgEmbeddingsStore } from '../src/pg-embeddings-store.js';

interface Captured {
  text: string;
  values: unknown[];
}

interface FakeSql {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  begin: (cb: (tx: FakeSql) => Promise<unknown>) => Promise<unknown>;
  // `unsafe` runs a raw SQL string with no parameter binding. Used for
  // statements that pgvector / postgres parser refuses to parameterise
  // (e.g. `SET LOCAL`) where the value is a module-internal constant.
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
    return handler(text, []);
  };
  return { sql: fn, calls };
}

function vec(...n: number[]): Float32Array {
  return Float32Array.from(n);
}

describe('PgEmbeddingsStore.upsert', () => {
  it('issues an INSERT...ON CONFLICT...DO UPDATE with vector text-literal', async () => {
    const { sql, calls } = makeFakeSql(() => []);
    const store = new PgEmbeddingsStore({ sql: sql as unknown as import('postgres').Sql });
    // Values that survive Float32 round-trip exactly (1.0, 0.0, -1.0) so the
    // text-literal assertion is portable. Real-world vectors carry float32
    // precision noise — that's pgvector's domain, not the store's contract.
    await store.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'r1',
      vector: vec(1, 0, -1),
      model: 'nomic:768'
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.text).toMatch(/INSERT INTO embeddings/);
    expect(call?.text).toMatch(/ON CONFLICT/);
    expect(call?.text).toMatch(/DO UPDATE/);
    const literalIdx = call?.values.findIndex(
      (v) => typeof v === 'string' && v.startsWith('[') && v.endsWith(']')
    );
    expect(literalIdx).toBeGreaterThanOrEqual(0);
    expect(call?.values[literalIdx as number]).toBe('[1,0,-1]');
    // namespace + type + id + model surface in the params.
    expect(call?.values).toContain('claude');
    expect(call?.values).toContain('Decision');
    expect(call?.values).toContain('r1');
    expect(call?.values).toContain('nomic:768');
  });

  it('passes a Date for updated_at when no `now` override supplied', async () => {
    const { sql, calls } = makeFakeSql(() => []);
    const store = new PgEmbeddingsStore({ sql: sql as unknown as import('postgres').Sql });
    await store.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'r1',
      vector: vec(1, 0),
      model: 'm'
    });
    const dateValue = calls[0]?.values.find((v): v is Date => v instanceof Date);
    expect(dateValue).toBeInstanceOf(Date);
  });

  it('honours an explicit `now` override', async () => {
    const { sql, calls } = makeFakeSql(() => []);
    const store = new PgEmbeddingsStore({ sql: sql as unknown as import('postgres').Sql });
    const now = new Date('2026-01-01T00:00:00Z');
    await store.upsert({
      rowNamespace: 'claude',
      rowType: 'Decision',
      rowId: 'r1',
      vector: vec(1, 0),
      model: 'm',
      now
    });
    expect(calls[0]?.values).toContain(now);
  });

  it('clarifies pgvector dimension-mismatch errors', async () => {
    const { sql } = makeFakeSql((text) => {
      if (text.includes('INSERT INTO embeddings')) {
        throw new Error('expected 8 dimensions, not 3');
      }
      return [];
    });
    const store = new PgEmbeddingsStore({ sql: sql as unknown as import('postgres').Sql });
    await expect(
      store.upsert({
        rowNamespace: 'claude',
        rowType: 'Decision',
        rowId: 'r1',
        vector: vec(1, 0, -1),
        model: 'm'
      })
    ).rejects.toThrow(/dimension mismatch.*expected 8 dimensions/i);
  });

  it('propagates non-dimension errors unchanged', async () => {
    const { sql } = makeFakeSql((text) => {
      if (text.includes('INSERT INTO embeddings')) throw new Error('connection reset');
      return [];
    });
    const store = new PgEmbeddingsStore({ sql: sql as unknown as import('postgres').Sql });
    await expect(
      store.upsert({ rowNamespace: 'c', rowType: 'D', rowId: 'r', vector: vec(1, 0), model: 'm' })
    ).rejects.toThrow(/^connection reset$/);
  });
});

describe('PgEmbeddingsStore.delete', () => {
  it('deletes exactly the one embedding row, keyed on all three columns', async () => {
    const { sql, calls } = makeFakeSql(() => []);
    const store = new PgEmbeddingsStore({ sql: sql as unknown as import('postgres').Sql });
    await store.delete({ rowNamespace: 'labs', rowType: 'Trace', rowId: 't-1' });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.text).toMatch(/DELETE FROM embeddings/);
    expect(call?.text).toMatch(/row_namespace/);
    expect(call?.text).toMatch(/row_type/);
    expect(call?.text).toMatch(/row_id/);
    expect(call?.values).toEqual(['labs', 'Trace', 't-1']);
  });

  it('does not touch rows — un-indexing must never delete the row', async () => {
    const { sql, calls } = makeFakeSql(() => []);
    const store = new PgEmbeddingsStore({ sql: sql as unknown as import('postgres').Sql });
    await store.delete({ rowNamespace: 'labs', rowType: 'Trace', rowId: 't-1' });
    expect(calls.some((c) => c.text.includes('rows'))).toBe(false);
  });
});

describe('PgEmbeddingsStore.knnSearch', () => {
  it('runs SET LOCAL hnsw.iterative_scan + ef_search before the SELECT', async () => {
    const { sql, calls } = makeFakeSql(() => []);
    const store = new PgEmbeddingsStore({ sql: sql as unknown as import('postgres').Sql });
    await store.knnSearch({
      namespace: 'claude',
      type: 'Decision',
      model: 'nomic:768',
      vector: vec(0, 1),
      k: 10
    });
    const setText = calls
      .filter((c) => c.text.toUpperCase().includes('SET LOCAL'))
      .map((c) => c.text)
      .join('\n');
    expect(setText).toMatch(/hnsw\.iterative_scan/);
    expect(setText).toMatch(/hnsw\.ef_search/);
    const setIdx = calls.findIndex((c) => c.text.toUpperCase().includes('SET LOCAL'));
    const selectIdx = calls.findIndex((c) => c.text.includes('SELECT'));
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(selectIdx).toBeGreaterThan(setIdx);

    // Regression: postgres parser rejects bound parameters in SET LOCAL
    // ("syntax error at or near $1"). The ef_search statement must inline
    // its integer constant via tx.unsafe, NOT through tagged-template
    // interpolation. Both SET LOCAL calls captured here must have empty
    // `values` arrays.
    const efSearchCall = calls.find((c) => c.text.includes('hnsw.ef_search'));
    expect(efSearchCall?.values).toEqual([]);
    const iterativeCall = calls.find((c) => c.text.includes('hnsw.iterative_scan'));
    expect(iterativeCall?.values).toEqual([]);
  });

  it('filters model in the SQL WHERE, inside the iterative scan', async () => {
    const { sql, calls } = makeFakeSql(() => []);
    const store = new PgEmbeddingsStore({ sql: sql as unknown as import('postgres').Sql });
    await store.knnSearch({
      namespace: 'app',
      type: 'Doc',
      model: 'model-a:768',
      vector: vec(0, 1),
      k: 10
    });
    const select = calls.find((c) => c.text.includes('SELECT'));
    expect(select?.text).toMatch(/e\.model\s*=/);
    expect(select?.values).toContain('model-a:768');
    expect(select?.text).toMatch(/e\.row_namespace\s*=/);
    expect(select?.text).toMatch(/e\.row_type\s*=/);
  });

  it('clamps k to [1, 100]', async () => {
    // The SQL LIMIT is clampK(k): k=5000 → 100, k=-5 → 1.
    {
      const { sql, calls } = makeFakeSql(() => []);
      const store = new PgEmbeddingsStore({ sql: sql as unknown as import('postgres').Sql });
      await store.knnSearch({
        namespace: 'claude',
        type: 'Decision',
        model: 'nomic:768',
        vector: vec(0, 1),
        k: 5000
      });
      const select = calls.find((c) => c.text.includes('SELECT'));
      expect(select?.values?.at(-1)).toBe(100);
    }
    {
      const { sql, calls } = makeFakeSql(() => []);
      const store = new PgEmbeddingsStore({ sql: sql as unknown as import('postgres').Sql });
      await store.knnSearch({
        namespace: 'claude',
        type: 'Decision',
        model: 'nomic:768',
        vector: vec(0, 1),
        k: -5
      });
      const select = calls.find((c) => c.text.includes('SELECT'));
      expect(select?.values?.at(-1)).toBe(1);
    }
  });

  it('forwards threshold as the cosine-similarity floor', async () => {
    const { sql, calls } = makeFakeSql(() => []);
    const store = new PgEmbeddingsStore({ sql: sql as unknown as import('postgres').Sql });
    await store.knnSearch({
      namespace: 'claude',
      type: 'Decision',
      model: 'nomic:768',
      vector: vec(0, 1),
      k: 10,
      threshold: 0.7
    });
    const select = calls.find((c) => c.text.includes('SELECT'));
    expect(select?.values).toContain(0.7);
  });

  it('runs SET LOCAL + SELECT inside sql.begin so the GUCs are tx-scoped', async () => {
    let beginCalls = 0;
    const innerCalls: Captured[] = [];
    const fn = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      innerCalls.push({ text: strings.join('?'), values });
      return [];
    }) as FakeSql;
    fn.begin = async (cb) => {
      beginCalls += 1;
      return cb(fn);
    };
    fn.unsafe = async (text: string) => {
      innerCalls.push({ text, values: [] });
      return [];
    };
    const store = new PgEmbeddingsStore({ sql: fn as unknown as import('postgres').Sql });
    await store.knnSearch({
      namespace: 'claude',
      type: 'Decision',
      model: 'nomic:768',
      vector: vec(0, 1),
      k: 10
    });
    expect(beginCalls).toBe(1);
  });
});

describe('PgEmbeddingsStore — txScopeId', () => {
  it('derives txScopeId from the sql handle (parity with PgEdgesStore)', () => {
    const { sql: sql1 } = makeFakeSql(() => []);
    const { sql: sql2 } = makeFakeSql(() => []);
    const a = new PgEmbeddingsStore({ sql: sql1 as unknown as import('postgres').Sql });
    const b = new PgEmbeddingsStore({ sql: sql1 as unknown as import('postgres').Sql });
    const c = new PgEmbeddingsStore({ sql: sql2 as unknown as import('postgres').Sql });
    expect(a.txScopeId).toBe(b.txScopeId);
    expect(a.txScopeId).not.toBe(c.txScopeId);
  });
});

// Suppress unused-vi import warning when the test runner config flags it.
void vi;
