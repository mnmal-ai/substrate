import type { EdgeWriteInput } from '@mnmal-ai/substrate-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryEdgesStore } from '../src/index.js';

function mkInput(overrides: Partial<EdgeWriteInput> = {}): EdgeWriteInput {
  return {
    from: { ns: 'a', type: 'Foo', id: '1' },
    to: { ns: 'b', type: 'Bar', id: '2' },
    fieldName: 'ref',
    policy: 'set_null',
    ...overrides
  };
}

describe('MemoryEdgesStore drop primitives', () => {
  let edges: MemoryEdgesStore;

  beforeEach(() => {
    edges = new MemoryEdgesStore({ now: () => new Date('2026-04-23T00:00:00Z') });
  });

  describe('findEdgesTouchingNamespace', () => {
    it('returns edges with either endpoint in the ns', async () => {
      await edges.write(
        mkInput({
          from: { ns: 'a', type: 'Foo', id: '1' },
          to: { ns: 'b', type: 'Bar', id: '2' }
        })
      );
      await edges.write(
        mkInput({
          from: { ns: 'c', type: 'Baz', id: '3' },
          to: { ns: 'a', type: 'Foo', id: '4' }
        })
      );
      await edges.write(
        mkInput({
          from: { ns: 'c', type: 'Baz', id: '5' },
          to: { ns: 'd', type: 'Qux', id: '6' }
        })
      );
      const results = await edges.findEdgesTouchingNamespace('a', 10);
      expect(results).toHaveLength(2);
    });

    it('excludes tombstoned edges', async () => {
      const e = await edges.write(
        mkInput({
          from: { ns: 'a', type: 'Foo', id: '1' },
          to: { ns: 'b', type: 'Bar', id: '2' }
        })
      );
      await edges.tombstone(e.id);
      const results = await edges.findEdgesTouchingNamespace('a', 10);
      expect(results).toHaveLength(0);
    });

    it('respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await edges.write(
          mkInput({
            from: { ns: 'a', type: 'Foo', id: String(i) },
            to: { ns: 'b', type: 'Bar', id: '0' }
          })
        );
      }
      const results = await edges.findEdgesTouchingNamespace('a', 2);
      expect(results).toHaveLength(2);
    });
  });

  describe('findEdgesTouchingType', () => {
    it('scopes to (ns, type) on either endpoint', async () => {
      await edges.write(
        mkInput({
          from: { ns: 'a', type: 'Foo', id: '1' },
          to: { ns: 'b', type: 'Bar', id: '2' }
        })
      );
      await edges.write(
        mkInput({
          from: { ns: 'a', type: 'NotFoo', id: '3' },
          to: { ns: 'b', type: 'Bar', id: '4' }
        })
      );
      const results = await edges.findEdgesTouchingType('a', 'Foo', 10);
      expect(results).toHaveLength(1);
    });

    it('matches on to endpoint as well as from', async () => {
      await edges.write(
        mkInput({
          from: { ns: 'x', type: 'X', id: '1' },
          to: { ns: 'a', type: 'Foo', id: '2' }
        })
      );
      const results = await edges.findEdgesTouchingType('a', 'Foo', 10);
      expect(results).toHaveLength(1);
    });

    it('excludes tombstoned edges', async () => {
      const e = await edges.write(
        mkInput({
          from: { ns: 'a', type: 'Foo', id: '1' },
          to: { ns: 'b', type: 'Bar', id: '2' }
        })
      );
      await edges.tombstone(e.id);
      const results = await edges.findEdgesTouchingType('a', 'Foo', 10);
      expect(results).toHaveLength(0);
    });

    it('respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await edges.write(
          mkInput({
            from: { ns: 'a', type: 'Foo', id: String(i) },
            to: { ns: 'b', type: 'Bar', id: '0' }
          })
        );
      }
      const results = await edges.findEdgesTouchingType('a', 'Foo', 3);
      expect(results).toHaveLength(3);
    });
  });

  describe('dropEdgesByNamespace', () => {
    it('physically removes every edge touching the ns, including tombstoned', async () => {
      const live = await edges.write(
        mkInput({
          from: { ns: 'a', type: 'Foo', id: '1' },
          to: { ns: 'b', type: 'Bar', id: '2' }
        })
      );
      void live;
      const dead = await edges.write(
        mkInput({
          from: { ns: 'a', type: 'Foo', id: '3' },
          to: { ns: 'c', type: 'Baz', id: '4' }
        })
      );
      await edges.tombstone(dead.id);

      const count = await edges.dropEdgesByNamespace('a');

      expect(count).toBe(2);
      // Live query returns nothing after drop
      const remaining = await edges.findEdgesTouchingNamespace('a', 10);
      expect(remaining).toHaveLength(0);
      // Physical removal confirmed via readNextBatch (includes tombstoned)
      const batch = await edges.readNextBatch(null, 100);
      expect(batch.edges.filter((e) => e.from.ns === 'a' || e.to.ns === 'a')).toHaveLength(0);
    });

    it('leaves untouched edges intact', async () => {
      await edges.write(
        mkInput({
          from: { ns: 'a', type: 'Foo', id: '1' },
          to: { ns: 'b', type: 'Bar', id: '2' }
        })
      );
      await edges.write(
        mkInput({
          from: { ns: 'x', type: 'X', id: '3' },
          to: { ns: 'y', type: 'Y', id: '4' }
        })
      );

      const count = await edges.dropEdgesByNamespace('a');
      expect(count).toBe(1);

      const batch = await edges.readNextBatch(null, 100);
      expect(batch.edges).toHaveLength(1);
      expect(batch.edges[0]?.from.ns).toBe('x');
    });

    it('is rolled back on tx throw', async () => {
      await edges.write(
        mkInput({
          from: { ns: 'a', type: 'Foo', id: '1' },
          to: { ns: 'b', type: 'Bar', id: '2' }
        })
      );

      await expect(
        edges.withTransaction(async (tx) => {
          await tx.dropEdgesByNamespace('a');
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      const remaining = await edges.findEdgesTouchingNamespace('a', 10);
      expect(remaining).toHaveLength(1);
    });
  });

  describe('dropEdgesByType', () => {
    it('is scoped to (ns, type) — only removes matching edges', async () => {
      await edges.write(
        mkInput({
          from: { ns: 'a', type: 'Foo', id: '1' },
          to: { ns: 'b', type: 'Bar', id: '2' }
        })
      );
      await edges.write(
        mkInput({
          from: { ns: 'a', type: 'NotFoo', id: '3' },
          to: { ns: 'b', type: 'Bar', id: '4' }
        })
      );

      const count = await edges.dropEdgesByType('a', 'Foo');
      expect(count).toBe(1);

      const remaining = await edges.findEdgesTouchingNamespace('a', 10);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.from.type).toBe('NotFoo');
    });

    it('includes tombstoned edges', async () => {
      const e = await edges.write(
        mkInput({
          from: { ns: 'a', type: 'Foo', id: '1' },
          to: { ns: 'b', type: 'Bar', id: '2' }
        })
      );
      await edges.tombstone(e.id);

      const count = await edges.dropEdgesByType('a', 'Foo');
      expect(count).toBe(1);

      const batch = await edges.readNextBatch(null, 100);
      expect(batch.edges).toHaveLength(0);
    });

    it('is rolled back on tx throw', async () => {
      await edges.write(
        mkInput({
          from: { ns: 'a', type: 'Foo', id: '1' },
          to: { ns: 'b', type: 'Bar', id: '2' }
        })
      );

      await expect(
        edges.withTransaction(async (tx) => {
          await tx.dropEdgesByType('a', 'Foo');
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      const remaining = await edges.findEdgesTouchingType('a', 'Foo', 10);
      expect(remaining).toHaveLength(1);
    });
  });
});
