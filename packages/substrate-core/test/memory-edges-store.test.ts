import type { EdgeRef, EdgeWriteInput } from '@mnmal-ai/substrate-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryEdgesStore } from '../src/index.js';

function mkInput(overrides: Partial<EdgeWriteInput> = {}): EdgeWriteInput {
  return {
    from: { ns: 'ns-a', type: 'A', id: 1 },
    to: { ns: 'ns-b', type: 'B', id: 2 },
    fieldName: 'b',
    policy: 'set_null',
    ...overrides
  };
}

describe('MemoryEdgesStore', () => {
  let now: Date;
  let store: MemoryEdgesStore;

  beforeEach(() => {
    now = new Date('2026-04-18T00:00:00Z');
    store = new MemoryEdgesStore({ now: () => now });
  });

  describe('write', () => {
    it('assigns ULID-like monotonic id', async () => {
      const e1 = await store.write(mkInput());
      const e2 = await store.write(mkInput());
      expect(e1.id).toBeDefined();
      expect(e2.id).toBeDefined();
      expect(e1.id < e2.id).toBe(true);
    });

    it('stamps createdAt from injected clock', async () => {
      const e = await store.write(mkInput());
      expect(e.createdAt).toEqual(now);
    });

    it('preserves from, to, policy, fieldName snapshot', async () => {
      const e = await store.write(mkInput({ policy: 'cascade' }));
      expect(e.from).toEqual({ ns: 'ns-a', type: 'A', id: 1 });
      expect(e.to).toEqual({ ns: 'ns-b', type: 'B', id: 2 });
      expect(e.policy).toBe('cascade');
      expect(e.fieldName).toBe('b');
    });
  });

  describe('tombstone', () => {
    it('stamps deletedAt', async () => {
      const e = await store.write(mkInput());
      await store.tombstone(e.id);
      const [found] = await store.findEdgesFrom(e.from);
      expect(found).toBeUndefined(); // live-edges query excludes tombstoned
    });

    it('is terminal — preserves original deletedAt on repeat', async () => {
      const e = await store.write(mkInput());
      const first = new Date('2026-04-18T01:00:00Z');
      await store.tombstone(e.id, first);
      const second = new Date('2026-04-18T02:00:00Z');
      await store.tombstone(e.id, second);

      const all = await store.readNextBatch(null, 100);
      const rec = all.edges.find((x) => x.id === e.id);
      expect(rec?.deletedAt).toEqual(first);
    });

    it('uses deps.now() when at is not provided', async () => {
      const e = await store.write(mkInput());
      await store.tombstone(e.id);
      const all = await store.readNextBatch(null, 100);
      const rec = all.edges.find((x) => x.id === e.id);
      expect(rec?.deletedAt).toEqual(now);
    });

    it('silent no-op for unknown id', async () => {
      await expect(store.tombstone('unknown')).resolves.toBeUndefined();
    });
  });

  describe('update', () => {
    it('sets lastSweptAt', async () => {
      const e = await store.write(mkInput());
      const t = new Date('2026-04-18T03:00:00Z');
      await store.update({ id: e.id, lastSweptAt: t });

      const all = await store.readNextBatch(null, 100);
      const rec = all.edges.find((x) => x.id === e.id);
      expect(rec?.lastSweptAt).toEqual(t);
    });

    it('sets blocked flag', async () => {
      const e = await store.write(mkInput());
      await store.update({ id: e.id, blocked: true });

      const all = await store.readNextBatch(null, 100);
      const rec = all.edges.find((x) => x.id === e.id);
      expect(rec?.blocked).toBe(true);
    });

    it('rejects attempts to mutate non-narrow fields at runtime', async () => {
      const e = await store.write(mkInput());
      // Callers who cast through an escape hatch (plain object, JSON payload,
      // etc.) must still be rejected. Cast via `unknown` to keep biome happy
      // while exercising the runtime guard.
      const patch = { id: e.id, fieldName: 'hijacked' } as unknown as Parameters<
        typeof store.update
      >[0];
      await expect(store.update(patch)).rejects.toThrow();
    });

    it('cannot change deletedAt', async () => {
      const e = await store.write(mkInput());
      await store.tombstone(e.id);
      const patch = { id: e.id, deletedAt: undefined } as unknown as Parameters<
        typeof store.update
      >[0];
      await expect(store.update(patch)).rejects.toThrow();
    });

    it('silent no-op for unknown id', async () => {
      await expect(store.update({ id: 'unknown', blocked: true })).resolves.toBeUndefined();
    });
  });

  describe('readNextBatch', () => {
    it('returns edges ordered by id ascending', async () => {
      const e1 = await store.write(mkInput());
      const e2 = await store.write(mkInput());
      const e3 = await store.write(mkInput());

      const batch = await store.readNextBatch(null, 10);
      expect(batch.edges.map((e) => e.id)).toEqual([e1.id, e2.id, e3.id]);
      expect(batch.lastId).toBe(e3.id);
    });

    it('advances cursor', async () => {
      const e1 = await store.write(mkInput());
      const e2 = await store.write(mkInput());
      const e3 = await store.write(mkInput());

      const first = await store.readNextBatch(null, 2);
      expect(first.edges.map((e) => e.id)).toEqual([e1.id, e2.id]);
      expect(first.lastId).toBe(e2.id);

      const second = await store.readNextBatch(first.lastId, 10);
      expect(second.edges.map((e) => e.id)).toEqual([e3.id]);
    });

    it('wraparound: empty batch returns null lastId', async () => {
      const batch = await store.readNextBatch(null, 10);
      expect(batch.edges).toEqual([]);
      expect(batch.lastId).toBeNull();
    });

    it('includes tombstoned edges (sweep checks deletedAt itself)', async () => {
      const e = await store.write(mkInput());
      await store.tombstone(e.id);
      const batch = await store.readNextBatch(null, 10);
      expect(batch.edges).toHaveLength(1);
    });
  });

  describe('findEdgesTo / findEdgesFrom', () => {
    it('matches by ns/type/id; excludes tombstoned', async () => {
      const live = await store.write(mkInput());
      const dead = await store.write(mkInput());
      await store.tombstone(dead.id);

      const toRef: EdgeRef = { ns: 'ns-b', type: 'B', id: 2 };
      const hits = await store.findEdgesTo(toRef);
      expect(hits.map((e) => e.id)).toEqual([live.id]);

      const fromRef: EdgeRef = { ns: 'ns-a', type: 'A', id: 1 };
      const hitsFrom = await store.findEdgesFrom(fromRef);
      expect(hitsFrom.map((e) => e.id)).toEqual([live.id]);
    });

    it('no matches → empty array', async () => {
      const ref: EdgeRef = { ns: 'nope', type: 'Z', id: 99 };
      expect(await store.findEdgesTo(ref)).toEqual([]);
      expect(await store.findEdgesFrom(ref)).toEqual([]);
    });
  });

  describe('findEdgesToMany', () => {
    it('unions inbound edges for ANY ref; excludes tombstoned', async () => {
      const e1 = await store.write(
        mkInput({ from: { ns: 's', type: 'S', id: 1 }, to: { ns: 't', type: 'T', id: 'a' } })
      );
      const e2 = await store.write(
        mkInput({ from: { ns: 's', type: 'S', id: 2 }, to: { ns: 't', type: 'U', id: 'b' } })
      );
      const dead = await store.write(
        mkInput({ from: { ns: 's', type: 'S', id: 3 }, to: { ns: 't', type: 'T', id: 'a' } })
      );
      await store.tombstone(dead.id);

      const hits = await store.findEdgesToMany([
        { ns: 't', type: 'T', id: 'a' },
        { ns: 't', type: 'U', id: 'b' },
        { ns: 't', type: 'T', id: 'missing' }
      ]);
      expect(new Set(hits.map((e) => e.id))).toEqual(new Set([e1.id, e2.id]));
    });

    it('empty refs → empty array', async () => {
      await store.write(mkInput());
      expect(await store.findEdgesToMany([])).toEqual([]);
    });

    it('distinguishes string "5" from number 5 (strict id semantics)', async () => {
      const strEdge = await store.write(
        mkInput({ from: { ns: 's', type: 'S', id: 1 }, to: { ns: 't', type: 'T', id: '5' } })
      );
      await store.write(
        mkInput({ from: { ns: 's', type: 'S', id: 2 }, to: { ns: 't', type: 'T', id: 5 } })
      );
      const hits = await store.findEdgesToMany([{ ns: 't', type: 'T', id: '5' }]);
      expect(hits.map((e) => e.id)).toEqual([strEdge.id]);
    });
  });

  describe('canDelete', () => {
    it('ok: true when no restrict edges exist', async () => {
      await store.write(mkInput({ policy: 'set_null' }));
      const res = await store.canDelete({ ns: 'ns-b', type: 'B', id: 2 });
      expect(res.ok).toBe(true);
    });

    it('ok: false when a live restrict edge points at ref', async () => {
      const restrict = await store.write(mkInput({ policy: 'restrict' }));
      const res = await store.canDelete({ ns: 'ns-b', type: 'B', id: 2 });
      if (res.ok) throw new Error('expected blocked');
      expect(res.blockedBy.map((e) => e.id)).toEqual([restrict.id]);
    });

    it('ignores tombstoned restrict edges', async () => {
      const r = await store.write(mkInput({ policy: 'restrict' }));
      await store.tombstone(r.id);
      const res = await store.canDelete({ ns: 'ns-b', type: 'B', id: 2 });
      expect(res.ok).toBe(true);
    });
  });

  describe('findBlocked', () => {
    it('returns only live edges with blocked=true', async () => {
      const blocked = await store.write(mkInput());
      const notBlocked = await store.write(mkInput());
      const blockedThenDead = await store.write(mkInput());
      await store.update({ id: blocked.id, blocked: true });
      await store.update({ id: blockedThenDead.id, blocked: true });
      await store.tombstone(blockedThenDead.id);

      const hits = await store.findBlocked();
      expect(hits.map((e) => e.id).sort()).toEqual([blocked.id].sort());
      expect(hits.map((e) => e.id)).not.toContain(notBlocked.id);
      expect(hits.map((e) => e.id)).not.toContain(blockedThenDead.id);
    });
  });

  describe('withTransaction', () => {
    it('commits on resolve — writes inside are visible after', async () => {
      let writtenId = '';
      await store.withTransaction(async (tx) => {
        const e = await tx.write(mkInput());
        writtenId = e.id;
      });
      const batch = await store.readNextBatch(null, 10);
      expect(batch.edges.map((e) => e.id)).toEqual([writtenId]);
    });

    it('rolls back on throw — writes inside are NOT visible after', async () => {
      await expect(
        store.withTransaction(async (tx) => {
          await tx.write(mkInput());
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      const batch = await store.readNextBatch(null, 10);
      expect(batch.edges).toHaveLength(0);
    });

    it('rolls back tombstone on throw', async () => {
      const e = await store.write(mkInput());
      await expect(
        store.withTransaction(async (tx) => {
          await tx.tombstone(e.id);
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      const hits = await store.findEdgesFrom(e.from);
      expect(hits).toHaveLength(1);
    });

    it('rolls back update on throw', async () => {
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
      const e = await store.write(mkInput());
      await expect(
        store.withTransaction(async (outerTx) => {
          await outerTx.update({ id: e.id, blocked: true });
          await outerTx.withTransaction(async (innerTx) => {
            await innerTx.write(mkInput());
            throw new Error('inner boom');
          });
        })
      ).rejects.toThrow('inner boom');

      const blocked = await store.findBlocked();
      expect(blocked).toHaveLength(0);
      const all = await store.readNextBatch(null, 10);
      expect(all.edges).toHaveLength(1);
      expect(all.edges[0]?.id).toBe(e.id);
    });

    it('returns the callback value on commit', async () => {
      const val = await store.withTransaction(async (tx) => {
        const e = await tx.write(mkInput());
        return e.id;
      });
      expect(typeof val).toBe('string');
    });

    // The ref-keyed lookups consult a secondary index. These
    // pin that the index is restored on rollback (and consistent on commit) —
    // the existing write-rollback test asserts via readNextBatch (a full scan),
    // which would not catch a stale index entry.
    it('rolls back a write so the indexed lookups (findEdgesFrom/To) do not see it', async () => {
      await expect(
        store.withTransaction(async (tx) => {
          await tx.write(mkInput());
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      const input = mkInput();
      expect(await store.findEdgesFrom(input.from)).toEqual([]);
      expect(await store.findEdgesTo(input.to)).toEqual([]);
    });

    it('commits a write so indexed lookups see it after the tx', async () => {
      let id = '';
      await store.withTransaction(async (tx) => {
        const e = await tx.write(mkInput());
        id = e.id;
      });

      const input = mkInput();
      expect((await store.findEdgesFrom(input.from)).map((e) => e.id)).toEqual([id]);
      expect((await store.findEdgesTo(input.to)).map((e) => e.id)).toEqual([id]);
    });

    it('rolls back a drop so the indexed lookups see the edge again', async () => {
      // The drop prunes the edge from the index mid-tx; the rollback restores
      // the edges map to a snapshot that still contains it. Without rebuilding
      // the index on rollback, findEdgesFrom/To would miss the restored edge.
      const e = await store.write(mkInput());
      await expect(
        store.withTransaction(async (tx) => {
          await tx.dropEdgesByNamespace('ns-a');
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      expect((await store.findEdgesFrom(e.from)).map((x) => x.id)).toEqual([e.id]);
      expect((await store.findEdgesTo(e.to)).map((x) => x.id)).toEqual([e.id]);
    });
  });
});
