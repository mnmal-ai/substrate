import type { Edge, EdgeRef, EdgeWriteInput } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgEdgesStore, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

function mkInput(overrides: Partial<EdgeWriteInput> = {}): EdgeWriteInput {
  return {
    from: { ns: 'ns-a', type: 'A', id: '1' },
    to: { ns: 'ns-b', type: 'B', id: '2' },
    fieldName: 'b',
    policy: 'set_null',
    ...overrides
  };
}

/**
 * Returns a fresh `EdgeWriteInput` with a unique to.id per call within a
 * test — the 0004 partial-UNIQUE index on
 * (from_ns, from_type, from_id, field_name, to_ns, to_type, to_id) rejects
 * a second live row sharing those columns. Tests that just need three
 * distinct edges (without caring about logical identity) use this helper.
 */
function mkUniqueInput(seq: number, overrides: Partial<EdgeWriteInput> = {}): EdgeWriteInput {
  return {
    from: { ns: 'ns-a', type: 'A', id: '1' },
    to: { ns: 'ns-b', type: 'B', id: `dup-${seq}` },
    fieldName: 'b',
    policy: 'set_null',
    ...overrides
  };
}

describe.skipIf(!POSTGRES_URL)('PgEdgesStore', () => {
  let sql: Sql;
  let now: Date;
  let store: PgEdgesStore;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql`TRUNCATE TABLE edges`;
    now = new Date('2026-04-18T00:00:00Z');
    store = new PgEdgesStore({ sql, now: () => now });
  });

  describe('write', () => {
    it('returns a populated Edge with id, createdAt from injected clock', async () => {
      const e = await store.write(mkInput());
      expect(e.id).toBeDefined();
      expect(typeof e.id).toBe('string');
      expect(e.createdAt).toEqual(now);
      expect(e.deletedAt).toBeUndefined();
      expect(e.lastSweptAt).toBeUndefined();
      expect(e.blocked).toBeUndefined();
    });

    it('preserves from, to, policy, fieldName snapshot', async () => {
      const e = await store.write(mkInput({ policy: 'cascade' }));
      expect(e.from).toEqual({ ns: 'ns-a', type: 'A', id: '1' });
      expect(e.to).toEqual({ ns: 'ns-b', type: 'B', id: '2' });
      expect(e.policy).toBe('cascade');
      expect(e.fieldName).toBe('b');
    });

    it('carries bridged flag when set', async () => {
      const e = await store.write(
        mkInput({
          from: { ns: 'ns-a', type: 'A', id: '1', bridged: true },
          to: { ns: 'ns-b', type: 'B', id: '2' }
        })
      );
      expect(e.from.bridged).toBe(true);
      expect(e.to.bridged).toBeUndefined();
    });

    it('coerces numeric id to text on write; reads back as text', async () => {
      const e = await store.write(
        mkInput({
          from: { ns: 'ns-a', type: 'A', id: 42 },
          to: { ns: 'ns-b', type: 'B', id: 77 }
        })
      );
      expect(e.from.id).toBe('42');
      expect(e.to.id).toBe('77');
    });

    it('persists and is retrievable via findEdgesFrom / findEdgesTo', async () => {
      const e = await store.write(mkInput());
      const from = await store.findEdgesFrom({ ns: 'ns-a', type: 'A', id: '1' });
      const to = await store.findEdgesTo({ ns: 'ns-b', type: 'B', id: '2' });
      expect(from.map((x) => x.id)).toEqual([e.id]);
      expect(to.map((x) => x.id)).toEqual([e.id]);
    });
  });

  describe('tombstone', () => {
    it('stamps deletedAt', async () => {
      const e = await store.write(mkInput());
      await store.tombstone(e.id);

      const fromHits = await store.findEdgesFrom(e.from);
      expect(fromHits).toHaveLength(0);
    });

    it('is terminal — second tombstone preserves original stamp', async () => {
      const e = await store.write(mkInput());
      const first = new Date('2026-04-18T01:00:00Z');
      await store.tombstone(e.id, first);

      const second = new Date('2026-04-18T02:00:00Z');
      await store.tombstone(e.id, second);

      const batch = await store.readNextBatch(null, 100);
      const rec = batch.edges.find((x) => x.id === e.id);
      expect(rec?.deletedAt).toEqual(first);
    });

    it('uses injected now() when at is omitted', async () => {
      const e = await store.write(mkInput());
      await store.tombstone(e.id);
      const batch = await store.readNextBatch(null, 100);
      const rec = batch.edges.find((x) => x.id === e.id);
      expect(rec?.deletedAt).toEqual(now);
    });

    it('silent no-op for unknown id', async () => {
      await expect(
        store.tombstone('00000000-0000-0000-0000-000000000000')
      ).resolves.toBeUndefined();
    });
  });

  describe('update', () => {
    it('sets lastSweptAt', async () => {
      const e = await store.write(mkInput());
      const t = new Date('2026-04-18T03:00:00Z');
      await store.update({ id: e.id, lastSweptAt: t });

      const batch = await store.readNextBatch(null, 100);
      const rec = batch.edges.find((x) => x.id === e.id);
      expect(rec?.lastSweptAt).toEqual(t);
    });

    it('sets blocked flag', async () => {
      const e = await store.write(mkInput());
      await store.update({ id: e.id, blocked: true });

      const batch = await store.readNextBatch(null, 100);
      const rec = batch.edges.find((x) => x.id === e.id);
      expect(rec?.blocked).toBe(true);
    });

    it('updates both lastSweptAt and blocked in one call', async () => {
      const e = await store.write(mkInput());
      const t = new Date('2026-04-18T04:00:00Z');
      await store.update({ id: e.id, lastSweptAt: t, blocked: true });
      const batch = await store.readNextBatch(null, 100);
      const rec = batch.edges.find((x) => x.id === e.id);
      expect(rec?.lastSweptAt).toEqual(t);
      expect(rec?.blocked).toBe(true);
    });

    it('rejects attempts to mutate non-narrow fields at runtime', async () => {
      const e = await store.write(mkInput());
      const patch = { id: e.id, fieldName: 'hijacked' } as unknown as Parameters<
        typeof store.update
      >[0];
      await expect(store.update(patch)).rejects.toThrow();
    });

    it('rejects attempts to change deletedAt via update', async () => {
      const e = await store.write(mkInput());
      const patch = { id: e.id, deletedAt: undefined } as unknown as Parameters<
        typeof store.update
      >[0];
      await expect(store.update(patch)).rejects.toThrow();
    });

    it('silent no-op for unknown id (empty patch aside from id)', async () => {
      await expect(
        store.update({ id: '00000000-0000-0000-0000-000000000000', blocked: true })
      ).resolves.toBeUndefined();
    });
  });

  describe('readNextBatch', () => {
    it('returns edges ordered by id ascending', async () => {
      const e1 = await store.write(mkUniqueInput(1));
      const e2 = await store.write(mkUniqueInput(2));
      const e3 = await store.write(mkUniqueInput(3));
      const expectedSorted = [e1.id, e2.id, e3.id].sort();

      const batch = await store.readNextBatch(null, 10);
      expect(batch.edges.map((e) => e.id)).toEqual(expectedSorted);
      expect(batch.lastId).toBe(expectedSorted[expectedSorted.length - 1]);
    });

    it('advances cursor strictly after the supplied id', async () => {
      const e1 = await store.write(mkUniqueInput(1));
      const e2 = await store.write(mkUniqueInput(2));
      const e3 = await store.write(mkUniqueInput(3));
      const sorted = [e1.id, e2.id, e3.id].sort();

      const first = await store.readNextBatch(null, 2);
      expect(first.edges.map((e) => e.id)).toEqual([sorted[0], sorted[1]]);
      expect(first.lastId).toBe(sorted[1]);

      const second = await store.readNextBatch(first.lastId, 10);
      expect(second.edges.map((e) => e.id)).toEqual([sorted[2]]);
    });

    it('empty batch returns null lastId', async () => {
      const batch = await store.readNextBatch(null, 10);
      expect(batch.edges).toEqual([]);
      expect(batch.lastId).toBeNull();
    });

    it('includes tombstoned edges (consumer filters deletedAt)', async () => {
      const e = await store.write(mkInput());
      await store.tombstone(e.id);
      const batch = await store.readNextBatch(null, 10);
      expect(batch.edges).toHaveLength(1);
      expect(batch.edges[0]?.deletedAt).toEqual(now);
    });
  });

  describe('findEdgesTo / findEdgesFrom', () => {
    it('matches by ns/type/id; excludes tombstoned', async () => {
      // Write the dead row first and tombstone it before writing the
      // live row. The 0004 partial-UNIQUE index on the logical-identity
      // tuple rejects two live rows sharing those columns; tombstoning
      // before re-writing is the legal path for re-creating an edge.
      const dead = await store.write(
        mkInput({
          from: { ns: 'ns-a', type: 'A', id: '1' },
          to: { ns: 'ns-b', type: 'B', id: '2' }
        })
      );
      await store.tombstone(dead.id);
      const live = await store.write(mkInput());

      const toRef: EdgeRef = { ns: 'ns-b', type: 'B', id: '2' };
      const hits = await store.findEdgesTo(toRef);
      expect(hits.map((e) => e.id)).toEqual([live.id]);

      const fromRef: EdgeRef = { ns: 'ns-a', type: 'A', id: '1' };
      const hitsFrom = await store.findEdgesFrom(fromRef);
      expect(hitsFrom.map((e) => e.id)).toEqual([live.id]);
    });

    it('no matches returns []', async () => {
      const ref: EdgeRef = { ns: 'nope', type: 'Z', id: '99' };
      expect(await store.findEdgesTo(ref)).toEqual([]);
      expect(await store.findEdgesFrom(ref)).toEqual([]);
    });

    it('coerces numeric ref.id to text for lookup', async () => {
      await store.write(
        mkInput({
          from: { ns: 'ns-a', type: 'A', id: '42' },
          to: { ns: 'ns-b', type: 'B', id: '77' }
        })
      );
      const hits = await store.findEdgesTo({ ns: 'ns-b', type: 'B', id: 77 });
      expect(hits).toHaveLength(1);
    });
  });

  describe('findEdgesToMany', () => {
    it('returns inbound edges for ANY of the refs in one query; excludes tombstoned', async () => {
      // Three live edges pointing at three distinct targets, plus a fourth
      // that's tombstoned — the batched lookup must union the live hits and
      // drop the dead one.
      const e1 = await store.write(
        mkInput({ from: { ns: 'src', type: 'S', id: '1' }, to: { ns: 'tg', type: 'T', id: 'a' } })
      );
      const e2 = await store.write(
        mkInput({ from: { ns: 'src', type: 'S', id: '2' }, to: { ns: 'tg', type: 'T', id: 'b' } })
      );
      const e3 = await store.write(
        mkInput({ from: { ns: 'src', type: 'S', id: '3' }, to: { ns: 'tg', type: 'U', id: 'c' } })
      );
      const dead = await store.write(
        mkInput({ from: { ns: 'src', type: 'S', id: '4' }, to: { ns: 'tg', type: 'T', id: 'a' } })
      );
      await store.tombstone(dead.id);

      const hits = await store.findEdgesToMany([
        { ns: 'tg', type: 'T', id: 'a' },
        { ns: 'tg', type: 'T', id: 'b' },
        { ns: 'tg', type: 'U', id: 'c' },
        { ns: 'tg', type: 'T', id: 'missing' }
      ]);
      expect(new Set(hits.map((e) => e.id))).toEqual(new Set([e1.id, e2.id, e3.id]));
    });

    it('matches the union of per-ref findEdgesTo (cross-type targets)', async () => {
      await store.write(
        mkInput({ from: { ns: 'src', type: 'S', id: '1' }, to: { ns: 'tg', type: 'T', id: 'a' } })
      );
      await store.write(
        mkInput({ from: { ns: 'src', type: 'S', id: '2' }, to: { ns: 'tg', type: 'U', id: 'b' } })
      );
      const refs: EdgeRef[] = [
        { ns: 'tg', type: 'T', id: 'a' },
        { ns: 'tg', type: 'U', id: 'b' }
      ];
      const batched = await store.findEdgesToMany(refs);
      const perRef = (await Promise.all(refs.map((r) => store.findEdgesTo(r)))).flat();
      expect(new Set(batched.map((e) => e.id))).toEqual(new Set(perRef.map((e) => e.id)));
    });

    it('does not multiply results when a ref is repeated', async () => {
      await store.write(
        mkInput({ from: { ns: 'src', type: 'S', id: '1' }, to: { ns: 'tg', type: 'T', id: 'a' } })
      );
      const hits = await store.findEdgesToMany([
        { ns: 'tg', type: 'T', id: 'a' },
        { ns: 'tg', type: 'T', id: 'a' }
      ]);
      expect(hits).toHaveLength(1);
    });

    it('coerces numeric ref.id to text for lookup', async () => {
      await store.write(
        mkInput({ from: { ns: 'src', type: 'S', id: '1' }, to: { ns: 'tg', type: 'T', id: '77' } })
      );
      const hits = await store.findEdgesToMany([{ ns: 'tg', type: 'T', id: 77 }]);
      expect(hits).toHaveLength(1);
    });

    it('empty refs returns [] without a query', async () => {
      expect(await store.findEdgesToMany([])).toEqual([]);
    });
  });

  describe('canDelete', () => {
    it('ok: true when no restrict edges exist', async () => {
      await store.write(mkInput({ policy: 'set_null' }));
      const res = await store.canDelete({ ns: 'ns-b', type: 'B', id: '2' });
      expect(res.ok).toBe(true);
    });

    it('ok: false when a live restrict edge points at ref', async () => {
      const restrict = await store.write(mkInput({ policy: 'restrict' }));
      const res = await store.canDelete({ ns: 'ns-b', type: 'B', id: '2' });
      if (res.ok) throw new Error('expected blocked');
      expect(res.blockedBy.map((e) => e.id)).toEqual([restrict.id]);
    });

    it('ignores tombstoned restrict edges', async () => {
      const r = await store.write(mkInput({ policy: 'restrict' }));
      await store.tombstone(r.id);
      const res = await store.canDelete({ ns: 'ns-b', type: 'B', id: '2' });
      expect(res.ok).toBe(true);
    });
  });

  describe('findBlocked', () => {
    it('returns only live edges with blocked=true', async () => {
      // Three distinct logical identities — the 0004 partial-UNIQUE
      // index forbids three live rows on the same (from, fieldName, to).
      const blocked = await store.write(mkUniqueInput(1));
      const notBlocked = await store.write(mkUniqueInput(2));
      const blockedThenDead = await store.write(mkUniqueInput(3));
      await store.update({ id: blocked.id, blocked: true });
      await store.update({ id: blockedThenDead.id, blocked: true });
      await store.tombstone(blockedThenDead.id);

      const hits = await store.findBlocked();
      expect(hits.map((e: Edge) => e.id).sort()).toEqual([blocked.id].sort());
      expect(hits.map((e: Edge) => e.id)).not.toContain(notBlocked.id);
      expect(hits.map((e: Edge) => e.id)).not.toContain(blockedThenDead.id);
    });
  });

  describe('withTransaction', () => {
    it('commits on resolve — write inside is visible after', async () => {
      let writtenId = '';
      await store.withTransaction(async (tx) => {
        const e = await tx.write(mkInput());
        writtenId = e.id;
      });
      const batch = await store.readNextBatch(null, 10);
      expect(batch.edges.map((e) => e.id)).toEqual([writtenId]);
    });

    it('rolls back on throw — write inside is NOT visible after', async () => {
      await expect(
        store.withTransaction(async (tx) => {
          await tx.write(mkInput());
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      const batch = await store.readNextBatch(null, 10);
      expect(batch.edges).toHaveLength(0);
    });

    it('tombstone inside rolled back on throw', async () => {
      const e = await store.write(mkInput());
      await expect(
        store.withTransaction(async (tx) => {
          await tx.tombstone(e.id);
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      // Edge still live
      const hits = await store.findEdgesFrom(e.from);
      expect(hits).toHaveLength(1);
    });

    it('update inside rolled back on throw', async () => {
      const e = await store.write(mkInput());
      await expect(
        store.withTransaction(async (tx) => {
          await tx.update({ id: e.id, blocked: true });
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      const blocked = await store.findBlocked();
      expect(blocked).toHaveLength(0);
    });

    it('nested withTransaction flattens — inner throw rolls back outer writes', async () => {
      const e = await store.write(mkUniqueInput(1));
      await expect(
        store.withTransaction(async (outerTx) => {
          await outerTx.update({ id: e.id, blocked: true });
          await outerTx.withTransaction(async (innerTx) => {
            // Distinct identity — the 0004 partial-UNIQUE index would
            // otherwise reject the inner write before the throw fires.
            await innerTx.write(mkUniqueInput(2));
            throw new Error('inner boom');
          });
        })
      ).rejects.toThrow('inner boom');

      const blocked = await store.findBlocked();
      expect(blocked).toHaveLength(0);
      const all = await store.readNextBatch(null, 10);
      // Only the initial write from before the tx survives.
      expect(all.edges).toHaveLength(1);
      expect(all.edges[0]?.id).toBe(e.id);
    });

    it('returns the callback value on commit', async () => {
      const val = await store.withTransaction(async (tx) => {
        const e = await tx.write(mkInput());
        return e.id;
      });
      expect(typeof val).toBe('string');
      const batch = await store.readNextBatch(null, 10);
      expect(batch.edges.map((x) => x.id)).toEqual([val]);
    });
  });
});
