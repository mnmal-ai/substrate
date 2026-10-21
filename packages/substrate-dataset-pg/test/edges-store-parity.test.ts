/**
 * Holds `MemoryEdgesStore` and `PgEdgesStore` to the same behaviour.
 *
 * Transport parity compares two servers over ONE store; the axis that drifts
 * is the substrate. Edges carry the `restrict` / `cascade` semantics that
 * decide whether a delete is REFUSED, so a `canDelete` that disagrees across
 * substrates is a data-loss bug on one of them.
 *
 * Both stores run the identical script and the results are compared. Where a
 * divergence is legitimate it is asserted as such with the reason (see
 * `txScopeId` and id-format below).
 */

import { MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import type { Edge, EdgeRef, EdgesStore } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgEdgesStore, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

const NOW = new Date('2026-08-20T00:00:00.000Z');
const ref = (type: string, id: string): EdgeRef => ({ ns: 'parity', type, id });

/** Comparable projection: drops the fields that legitimately differ. */
const shape = (e: Edge): Record<string, unknown> => ({
  from: e.from,
  to: e.to,
  fieldName: e.fieldName,
  policy: e.policy,
  deleted: e.deletedAt !== undefined && e.deletedAt !== null,
  blocked: e.blocked === true
});

const shapes = (es: Edge[]): Array<Record<string, unknown>> =>
  es.map(shape).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe.skipIf(!POSTGRES_URL)('EdgesStore conformance (memory vs pg)', () => {
  let sql: Sql;
  let stores: Array<[string, EdgesStore]>;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql`TRUNCATE TABLE edges`;
    stores = [
      ['memory', new MemoryEdgesStore({ now: () => NOW })],
      ['pg', new PgEdgesStore({ sql, now: () => NOW })]
    ];
  });

  /**
   * Run `fn` against both stores and assert the results match. Returning the
   * pair rather than asserting inside each test keeps the divergence message
   * pointing at the behaviour rather than at a helper.
   */
  async function bothAgree<T>(fn: (s: EdgesStore) => Promise<T>): Promise<T> {
    const [[, mem], [, pg]] = stores as [[string, EdgesStore], [string, EdgesStore]];
    const m = await fn(mem);
    const p = await fn(pg);
    expect(p, 'pg and memory disagree').toEqual(m);
    return m;
  }

  async function seed(s: EdgesStore): Promise<void> {
    await s.write({ from: ref('A', '1'), to: ref('B', '9'), fieldName: 'bee', policy: 'cascade' });
    await s.write({ from: ref('A', '2'), to: ref('B', '9'), fieldName: 'bee', policy: 'restrict' });
    await s.write({ from: ref('A', '1'), to: ref('C', '7'), fieldName: 'see', policy: 'set_null' });
  }

  it('namespacesLinkedTo names the other namespaces a drop would reach', async () => {
    const other = (ns: string, type: string, id: string): EdgeRef => ({ ns, type, id });
    const linked = await bothAgree(async (s) => {
      await seed(s);
      await s.write({
        from: ref('A', '1'),
        to: other('x', 'X', '1'),
        fieldName: 'ex',
        policy: 'cascade'
      });
      await s.write({
        from: other('y', 'Y', '1'),
        to: ref('B', '9'),
        fieldName: 'why',
        policy: 'cascade'
      });
      const t = await s.write({
        from: other('z', 'Z', '1'),
        to: ref('C', '7'),
        fieldName: 'zed',
        policy: 'cascade'
      });
      await s.tombstone(t.id);
      return [await s.namespacesLinkedTo('parity'), await s.namespacesLinkedTo('parity', 'B')];
    });
    expect(linked).toEqual([['x', 'y', 'z'], ['y']]);
  });

  it('drops limited by within keep edges whose far end is elsewhere', async () => {
    const other = (ns: string, type: string, id: string): EdgeRef => ({ ns, type, id });
    const result = await bothAgree(async (s) => {
      await seed(s);
      await s.write({
        from: ref('A', '1'),
        to: other('x', 'X', '1'),
        fieldName: 'ex',
        policy: 'cascade'
      });
      await s.write({
        from: other('y', 'Y', '1'),
        to: ref('B', '9'),
        fieldName: 'why',
        policy: 'cascade'
      });
      const byType = await s.dropEdgesByType('parity', 'B', []);
      const byNs = await s.dropEdgesByNamespace('parity', ['x']);
      const left = await s.findEdgesTouchingNamespace('parity', 10);
      return { byType, byNs, left: left.map((e) => e.from.ns) };
    });
    expect(result).toEqual({ byType: 2, byNs: 2, left: ['y'] });
  });

  it('write returns an edge carrying the input verbatim', async () => {
    await bothAgree(async (s) => {
      const e = await s.write({
        from: ref('A', '1'),
        to: ref('B', '9'),
        fieldName: 'bee',
        policy: 'cascade'
      });
      // `id` and `createdAt` are substrate-assigned and legitimately differ —
      // memory mints a ts-counter, pg a ULID. Asserted for PRESENCE only; a
      // shared format is not part of the contract and pinning one here would
      // invent a requirement neither store promised.
      expect(typeof e.id).toBe('string');
      expect(e.id.length).toBeGreaterThan(0);
      expect(e.createdAt).toBeInstanceOf(Date);
      return shape(e);
    });
  });

  it('findEdgesTo / findEdgesFrom return the same sets', async () => {
    await bothAgree(async (s) => {
      await seed(s);
      return {
        toB9: shapes(await s.findEdgesTo(ref('B', '9'))),
        fromA1: shapes(await s.findEdgesFrom(ref('A', '1'))),
        toMissing: shapes(await s.findEdgesTo(ref('B', 'nope')))
      };
    });
  });

  it('findEdgesToMany matches the union of per-ref lookups, and empty refs yields empty', async () => {
    await bothAgree(async (s) => {
      await seed(s);
      const many = shapes(await s.findEdgesToMany([ref('B', '9'), ref('C', '7')]));
      const union = shapes([
        ...(await s.findEdgesTo(ref('B', '9'))),
        ...(await s.findEdgesTo(ref('C', '7')))
      ]);
      // The batched form is an optimisation of the loop; if it ever stops
      // agreeing with the loop it is silently under-returning, which reads as
      // "no related rows".
      expect(many).toEqual(union);
      return { many, empty: shapes(await s.findEdgesToMany([])) };
    });
  });

  it('tombstone removes an edge from every live read', async () => {
    await bothAgree(async (s) => {
      const e = await s.write({
        from: ref('A', '1'),
        to: ref('B', '9'),
        fieldName: 'bee',
        policy: 'cascade'
      });
      await s.tombstone(e.id, NOW);
      return {
        to: shapes(await s.findEdgesTo(ref('B', '9'))),
        from: shapes(await s.findEdgesFrom(ref('A', '1'))),
        canDelete: await s.canDelete(ref('B', '9'))
      };
    });
  });

  it('canDelete refuses on a live restrict edge and permits once it is gone', async () => {
    // The assertion with teeth: this is the difference between refusing a
    // delete and losing data, and it is decided independently in each store.
    await bothAgree(async (s) => {
      const restrict = await s.write({
        from: ref('A', '2'),
        to: ref('B', '9'),
        fieldName: 'bee',
        policy: 'restrict'
      });
      const blocked = await s.canDelete(ref('B', '9'));
      expect(blocked.ok).toBe(false);
      await s.tombstone(restrict.id, NOW);
      const after = await s.canDelete(ref('B', '9'));
      return {
        blockedCount: blocked.ok ? 0 : blocked.blockedBy.length,
        blockedShapes: blocked.ok ? [] : shapes(blocked.blockedBy),
        afterOk: after.ok
      };
    });
  });

  it('canDelete permits when only non-restrict policies point at the target', async () => {
    await bothAgree(async (s) => {
      for (const policy of ['cascade', 'set_null', 'orphan'] as const) {
        await s.write({ from: ref('A', policy), to: ref('B', '9'), fieldName: 'bee', policy });
      }
      return await s.canDelete(ref('B', '9'));
    });
  });

  it('update sets blocked, and findBlocked reports it', async () => {
    await bothAgree(async (s) => {
      const e = await s.write({
        from: ref('A', '1'),
        to: ref('B', '9'),
        fieldName: 'bee',
        policy: 'restrict'
      });
      expect(shapes(await s.findBlocked())).toEqual([]);
      await s.update({ id: e.id, blocked: true });
      return shapes(await s.findBlocked());
    });
  });

  it('findEdgesTouchingNamespace / Type honour the limit and match on either endpoint', async () => {
    await bothAgree(async (s) => {
      await seed(s);
      return {
        ns: shapes(await s.findEdgesTouchingNamespace('parity', 10)).length,
        nsLimited: (await s.findEdgesTouchingNamespace('parity', 1)).length,
        nsOther: shapes(await s.findEdgesTouchingNamespace('elsewhere', 10)),
        typeB: shapes(await s.findEdgesTouchingType('parity', 'B', 10)),
        typeMissing: shapes(await s.findEdgesTouchingType('parity', 'Z', 10))
      };
    });
  });

  it('dropEdgesByNamespace / Type return the same counts and leave the same remainder', async () => {
    await bothAgree(async (s) => {
      await seed(s);
      const droppedType = await s.dropEdgesByType('parity', 'C');
      const remainder = shapes(await s.findEdgesTouchingNamespace('parity', 50));
      const droppedNs = await s.dropEdgesByNamespace('parity');
      return {
        droppedType,
        remainder,
        droppedNs,
        empty: shapes(await s.findEdgesTouchingNamespace('parity', 50))
      };
    });
  });

  it('dropEdgesBy* also removes tombstoned edges', async () => {
    // "Physically delete every edge (tombstoned or live)" — a store that only
    // reaped live rows would leave the count short and the table growing, and
    // no live read would ever show it.
    await bothAgree(async (s) => {
      const e = await s.write({
        from: ref('A', '1'),
        to: ref('B', '9'),
        fieldName: 'bee',
        policy: 'cascade'
      });
      await s.tombstone(e.id, NOW);
      return await s.dropEdgesByNamespace('parity');
    });
  });

  it('withTransaction rolls back every write on throw', async () => {
    await bothAgree(async (s) => {
      await expect(
        s.withTransaction(async (tx) => {
          await tx.write({
            from: ref('A', '1'),
            to: ref('B', '9'),
            fieldName: 'bee',
            policy: 'cascade'
          });
          throw new Error('rollback');
        })
      ).rejects.toThrow('rollback');
      return shapes(await s.findEdgesTo(ref('B', '9')));
    });
  });

  it('withTransaction commits and returns the callback value', async () => {
    await bothAgree(async (s) => {
      const returned = await s.withTransaction(async (tx) => {
        await tx.write({
          from: ref('A', '1'),
          to: ref('B', '9'),
          fieldName: 'bee',
          policy: 'cascade'
        });
        return 'value';
      });
      return { returned, edges: shapes(await s.findEdgesTo(ref('B', '9'))) };
    });
  });

  it('a returned edge is a snapshot — a later tombstone does not rewrite it', async () => {
    // A store that hands out its internal objects lets a result set mutate
    // retroactively. The engine puts `canDelete`'s blockedBy straight into a
    // RestrictViolation, so a refusal's own evidence could rewrite itself.
    await bothAgree(async (s) => {
      const e = await s.write({
        from: ref('A', '1'),
        to: ref('B', '9'),
        fieldName: 'bee',
        policy: 'restrict'
      });
      const held = await s.findEdgesTo(ref('B', '9'));
      await s.tombstone(e.id, NOW);
      // The array taken BEFORE the tombstone must still describe a live edge.
      return shapes(held);
    });
  });

  it('mutating a returned edge does not reach into the store', async () => {
    await bothAgree(async (s) => {
      await s.write({
        from: ref('A', '1'),
        to: ref('B', '9'),
        fieldName: 'bee',
        policy: 'restrict'
      });
      const [got] = await s.findEdgesTo(ref('B', '9'));
      if (got !== undefined) {
        got.blocked = true;
        got.fieldName = 'clobbered';
      }
      return {
        blocked: shapes(await s.findBlocked()),
        live: shapes(await s.findEdgesTo(ref('B', '9')))
      };
    });
  });

  it('txScopeId is a non-empty string on both — the one field that must NOT match', () => {
    // Documented divergence: pg derives it from the Sql pool identity so an
    // EdgesStore and a Dataset on the same pool can enlist in one
    // transaction; memory mints a unique id per instance precisely so it can
    // never claim that. Equal ids across the two would be the bug.
    const [[, mem], [, pg]] = stores as [[string, EdgesStore], [string, EdgesStore]];
    expect(mem.txScopeId.length).toBeGreaterThan(0);
    expect(pg.txScopeId.length).toBeGreaterThan(0);
    expect(mem.txScopeId).not.toBe(pg.txScopeId);
  });
});
