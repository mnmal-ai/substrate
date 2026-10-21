/**
 * PgEdgesStore — edge drop primitives integration tests.
 *
 * Covers findEdgesTouchingNamespace, findEdgesTouchingType,
 * dropEdgesByNamespace, dropEdgesByType, and rollback behaviour.
 *
 * Requires POSTGRES_URL in the environment — skips when absent.
 * Uses TRUNCATE edges in beforeEach, so must run against a _test/_dev db.
 */

import type { EdgeWriteInput } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgEdgesStore, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

function mkInput(overrides: Partial<EdgeWriteInput> = {}): EdgeWriteInput {
  return {
    from: { ns: 'a', type: 'Foo', id: '1' },
    to: { ns: 'b', type: 'Bar', id: '2' },
    fieldName: 'ref',
    policy: 'set_null',
    ...overrides
  };
}

describe.skipIf(!POSTGRES_URL)('PgEdgesStore drop primitives', () => {
  let sql: Sql;
  let store: PgEdgesStore;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql`TRUNCATE TABLE edges`;
    store = new PgEdgesStore({ sql, now: () => new Date('2026-04-23T00:00:00Z') });
  });

  // ---------------------------------------------------------------------------
  // findEdgesTouchingNamespace
  // ---------------------------------------------------------------------------
  describe('findEdgesTouchingNamespace', () => {
    it('returns edges with either endpoint in the ns', async () => {
      // from_ns matches
      await store.write(
        mkInput({
          from: { ns: 'a', type: 'Foo', id: '1' },
          to: { ns: 'b', type: 'Bar', id: '2' }
        })
      );
      // to_ns matches
      await store.write(
        mkInput({
          from: { ns: 'c', type: 'Baz', id: '3' },
          to: { ns: 'a', type: 'Foo', id: '4' }
        })
      );
      // unrelated edge
      await store.write(
        mkInput({
          from: { ns: 'c', type: 'Baz', id: '5' },
          to: { ns: 'd', type: 'Qux', id: '6' }
        })
      );

      const results = await store.findEdgesTouchingNamespace('a', 10);
      expect(results).toHaveLength(2);
    });

    it('excludes tombstoned edges', async () => {
      const e = await store.write(
        mkInput({
          from: { ns: 'a', type: 'Foo', id: '1' },
          to: { ns: 'b', type: 'Bar', id: '2' }
        })
      );
      await store.tombstone(e.id);

      const results = await store.findEdgesTouchingNamespace('a', 10);
      expect(results).toHaveLength(0);
    });

    it('respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await store.write(
          mkInput({
            from: { ns: 'a', type: 'Foo', id: String(i) },
            to: { ns: 'b', type: 'Bar', id: '0' }
          })
        );
      }

      const results = await store.findEdgesTouchingNamespace('a', 2);
      expect(results).toHaveLength(2);
    });

    // The probe must be deterministic so the sample-probe and dangling-count
    // probes in dropNamespaceRoute agree across retries.
    it('is deterministic across repeated calls (ORDER BY id ASC)', async () => {
      for (let i = 0; i < 8; i++) {
        await store.write(
          mkInput({
            from: { ns: 'a', type: 'Foo', id: String(i) },
            to: { ns: 'b', type: 'Bar', id: '0' }
          })
        );
      }

      const first = await store.findEdgesTouchingNamespace('a', 3);
      const second = await store.findEdgesTouchingNamespace('a', 3);
      const third = await store.findEdgesTouchingNamespace('a', 3);
      expect(first).toHaveLength(3);
      expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id));
      expect(third.map((e) => e.id)).toEqual(first.map((e) => e.id));

      // Smaller limit returns the same prefix.
      const prefix = await store.findEdgesTouchingNamespace('a', 2);
      expect(prefix.map((e) => e.id)).toEqual(first.slice(0, 2).map((e) => e.id));
    });
  });

  // ---------------------------------------------------------------------------
  // findEdgesTouchingType
  // ---------------------------------------------------------------------------
  describe('findEdgesTouchingType', () => {
    it('scopes to (ns, type) on either endpoint — from side', async () => {
      await store.write(
        mkInput({
          from: { ns: 'a', type: 'Foo', id: '1' },
          to: { ns: 'b', type: 'Bar', id: '2' }
        })
      );
      // same ns but different type — should not match
      await store.write(
        mkInput({
          from: { ns: 'a', type: 'NotFoo', id: '3' },
          to: { ns: 'b', type: 'Bar', id: '4' }
        })
      );

      const results = await store.findEdgesTouchingType('a', 'Foo', 10);
      expect(results).toHaveLength(1);
    });

    it('matches on to endpoint as well as from', async () => {
      await store.write(
        mkInput({
          from: { ns: 'x', type: 'X', id: '1' },
          to: { ns: 'a', type: 'Foo', id: '2' }
        })
      );

      const results = await store.findEdgesTouchingType('a', 'Foo', 10);
      expect(results).toHaveLength(1);
    });

    it('excludes tombstoned edges', async () => {
      const e = await store.write(
        mkInput({
          from: { ns: 'a', type: 'Foo', id: '1' },
          to: { ns: 'b', type: 'Bar', id: '2' }
        })
      );
      await store.tombstone(e.id);

      const results = await store.findEdgesTouchingType('a', 'Foo', 10);
      expect(results).toHaveLength(0);
    });

    it('respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await store.write(
          mkInput({
            from: { ns: 'a', type: 'Foo', id: String(i) },
            to: { ns: 'b', type: 'Bar', id: '0' }
          })
        );
      }

      const results = await store.findEdgesTouchingType('a', 'Foo', 3);
      expect(results).toHaveLength(3);
    });

    // The probe must be deterministic so the sample-probe and dangling-count
    // probes in dropTypeRoute agree across retries.
    it('is deterministic across repeated calls (ORDER BY id ASC)', async () => {
      for (let i = 0; i < 8; i++) {
        await store.write(
          mkInput({
            from: { ns: 'a', type: 'Foo', id: String(i) },
            to: { ns: 'b', type: 'Bar', id: '0' }
          })
        );
      }

      const first = await store.findEdgesTouchingType('a', 'Foo', 3);
      const second = await store.findEdgesTouchingType('a', 'Foo', 3);
      const third = await store.findEdgesTouchingType('a', 'Foo', 3);
      expect(first).toHaveLength(3);
      expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id));
      expect(third.map((e) => e.id)).toEqual(first.map((e) => e.id));

      const prefix = await store.findEdgesTouchingType('a', 'Foo', 2);
      expect(prefix.map((e) => e.id)).toEqual(first.slice(0, 2).map((e) => e.id));
    });
  });

  // ---------------------------------------------------------------------------
  // dropEdgesByNamespace
  // ---------------------------------------------------------------------------
  describe('dropEdgesByNamespace', () => {
    it('physically removes every edge touching the ns, including tombstoned', async () => {
      // live edge
      await store.write(
        mkInput({
          from: { ns: 'a', type: 'Foo', id: '1' },
          to: { ns: 'b', type: 'Bar', id: '2' }
        })
      );
      // tombstoned edge
      const dead = await store.write(
        mkInput({
          from: { ns: 'a', type: 'Foo', id: '3' },
          to: { ns: 'c', type: 'Baz', id: '4' }
        })
      );
      await store.tombstone(dead.id);

      const count = await store.dropEdgesByNamespace('a');
      expect(count).toBe(2);

      // Confirm physically deleted — direct SQL count includes tombstoned
      const remaining = await sql<{ ct: string }[]>`
        SELECT COUNT(*) AS ct FROM edges
        WHERE from_ns = 'a' OR to_ns = 'a'
      `;
      expect(Number(remaining[0]?.ct)).toBe(0);
    });

    it('leaves untouched edges intact', async () => {
      await store.write(
        mkInput({
          from: { ns: 'a', type: 'Foo', id: '1' },
          to: { ns: 'b', type: 'Bar', id: '2' }
        })
      );
      await store.write(
        mkInput({
          from: { ns: 'x', type: 'X', id: '3' },
          to: { ns: 'y', type: 'Y', id: '4' }
        })
      );

      const count = await store.dropEdgesByNamespace('a');
      expect(count).toBe(1);

      const remaining = await sql<{ ct: string }[]>`
        SELECT COUNT(*) AS ct FROM edges
      `;
      expect(Number(remaining[0]?.ct)).toBe(1);
    });

    it('returns 0 when no matching edges exist', async () => {
      const count = await store.dropEdgesByNamespace('nonexistent');
      expect(count).toBe(0);
    });

    it('is rolled back on tx throw — row survives post-throw via direct SQL', async () => {
      await store.write(
        mkInput({
          from: { ns: 'a', type: 'Foo', id: '1' },
          to: { ns: 'b', type: 'Bar', id: '2' }
        })
      );

      await expect(
        store.withTransaction(async (tx) => {
          await tx.dropEdgesByNamespace('a');
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      // Verify via direct SQL (not through the find method that filters tombstones)
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM edges WHERE from_ns = 'a' OR to_ns = 'a'
      `;
      expect(rows).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // dropEdgesByType
  // ---------------------------------------------------------------------------
  describe('dropEdgesByType', () => {
    it('is scoped to (ns, type) — only removes matching edges', async () => {
      await store.write(
        mkInput({
          from: { ns: 'a', type: 'Foo', id: '1' },
          to: { ns: 'b', type: 'Bar', id: '2' }
        })
      );
      // same ns, different type — must NOT be removed
      await store.write(
        mkInput({
          from: { ns: 'a', type: 'NotFoo', id: '3' },
          to: { ns: 'b', type: 'Bar', id: '4' }
        })
      );

      const count = await store.dropEdgesByType('a', 'Foo');
      expect(count).toBe(1);

      // Confirm via direct SQL
      const rows = await sql<{ from_type: string }[]>`
        SELECT from_type FROM edges WHERE from_ns = 'a'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.from_type).toBe('NotFoo');
    });

    it('includes tombstoned edges in the hard delete', async () => {
      const e = await store.write(
        mkInput({
          from: { ns: 'a', type: 'Foo', id: '1' },
          to: { ns: 'b', type: 'Bar', id: '2' }
        })
      );
      await store.tombstone(e.id);

      const count = await store.dropEdgesByType('a', 'Foo');
      expect(count).toBe(1);

      // Confirm physically gone via direct SQL
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM edges WHERE from_ns = 'a' AND from_type = 'Foo'
      `;
      expect(rows).toHaveLength(0);
    });

    it('matches on to endpoint for (ns, type)', async () => {
      await store.write(
        mkInput({
          from: { ns: 'x', type: 'X', id: '1' },
          to: { ns: 'a', type: 'Foo', id: '2' }
        })
      );

      const count = await store.dropEdgesByType('a', 'Foo');
      expect(count).toBe(1);

      const rows = await sql<{ id: string }[]>`
        SELECT id FROM edges WHERE to_ns = 'a' AND to_type = 'Foo'
      `;
      expect(rows).toHaveLength(0);
    });

    it('is rolled back on tx throw — row survives post-throw via direct SQL', async () => {
      await store.write(
        mkInput({
          from: { ns: 'a', type: 'Foo', id: '1' },
          to: { ns: 'b', type: 'Bar', id: '2' }
        })
      );

      await expect(
        store.withTransaction(async (tx) => {
          await tx.dropEdgesByType('a', 'Foo');
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      // Verify via direct SQL (not through the find method)
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM edges WHERE from_ns = 'a' AND from_type = 'Foo'
      `;
      expect(rows).toHaveLength(1);
    });
  });
});
