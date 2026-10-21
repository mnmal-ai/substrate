import { describe, expect, it } from 'vitest';
import { MemoryDataset, NamespaceMismatch, ReservedField } from '../src/index.js';

const mkDs = (namespace = 'test') => new MemoryDataset({ namespace });

describe('MemoryDataset', () => {
  describe('namespace + capabilities', () => {
    it('readonly namespace matches constructor arg', () => {
      const ds = mkDs('claude');
      expect(ds.namespace).toBe('claude');
    });

    it('exposes full §5.2 operator capability set', () => {
      const ds = mkDs();
      expect(ds.capabilities.orderBy).toBe(true);
      expect(ds.capabilities.cursor).toBe(true);
      expect(ds.capabilities.operators['scalar.number']).toContain('eq');
      expect(ds.capabilities.operators['scalar.number']).toContain('between');
      expect(ds.capabilities.operators['scalar.string']).toContain('contains');
      expect(ds.capabilities.operators['scalar.boolean']).toEqual(['eq']);
      // A crossRef stores a target id, so set membership is as meaningful on it
      // as equality.
      expect(ds.capabilities.operators.crossRef).toEqual(['eq', 'neq', 'in', 'nin']);
    });
  });

  describe('write', () => {
    it('upserts rows', async () => {
      const ds = mkDs();
      const res = await ds.write('Todo', [
        { id: 1, title: 'a' },
        { id: 2, title: 'b' }
      ]);
      expect(res.written).toBe(2);
      expect(res.ids).toEqual([1, 2]);

      const { rows } = await ds.read('Todo', {});
      expect(rows).toHaveLength(2);
    });

    it('returns merged rows in WriteResult.rows', async () => {
      const ds = mkDs();
      // First write — returned rows match what landed (auto-fill adds _metadata).
      const first = await ds.write('Todo', [
        { id: 1, title: 'a', tag: 'x' },
        { id: 2, title: 'b' }
      ]);
      expect(first.rows).toEqual([
        expect.objectContaining({ id: 1, title: 'a', tag: 'x' }),
        expect.objectContaining({ id: 2, title: 'b' })
      ]);

      // Second write merges per-key — returned rows reflect the merge so
      // autoCRUD update can skip its post-read.
      const second = await ds.write('Todo', [{ id: 1, title: 'updated' }]);
      expect(second.rows).toEqual([expect.objectContaining({ id: 1, title: 'updated', tag: 'x' })]);
    });

    it('WriteResult.rows preserves _metadata via per-field merge', async () => {
      const ds = mkDs();
      await ds.write('Todo', [
        {
          id: 1,
          title: 'a',
          _metadata: {
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            createdBy: { kind: 'agent', id: 'orig' },
            updatedBy: { kind: 'agent', id: 'orig' }
          }
        }
      ]);
      // Update with null createdAt/createdBy + new updatedAt/updatedBy — the
      // shape autoCRUD update passes. mergeRowMetadata treats null as no-change.
      const res = await ds.write('Todo', [
        {
          id: 1,
          title: 'b',
          _metadata: {
            createdAt: null,
            updatedAt: '2026-04-26T00:00:00.000Z',
            createdBy: null,
            updatedBy: { kind: 'agent', id: 'updater' }
          }
        }
      ]);
      const merged = res.rows[0];
      expect(merged?.title).toBe('b');
      expect(merged?._metadata).toEqual({
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-04-26T00:00:00.000Z',
        createdBy: { kind: 'agent', id: 'orig' },
        updatedBy: { kind: 'agent', id: 'updater' }
      });
    });

    it('merges on second write with same id', async () => {
      const ds = mkDs();
      await ds.write('Todo', [{ id: 1, title: 'a', tag: 'x' }]);
      await ds.write('Todo', [{ id: 1, title: 'updated' }]);

      const { rows } = await ds.read('Todo', { id: 1 });
      expect(rows[0]).toEqual(expect.objectContaining({ id: 1, title: 'updated', tag: 'x' }));
    });

    it('ignores caller-supplied _deletedAt (stored live)', async () => {
      const ds = mkDs();
      await ds.write('Todo', [
        // biome-ignore lint/suspicious/noExplicitAny: test casts for reserved field
        { id: 1, title: 'a', _deletedAt: new Date() } as any
      ]);

      const { rows } = await ds.read('Todo', { id: 1 });
      expect(rows[0]).toBeDefined();
      expect(rows[0]?._deletedAt).toBeUndefined();
    });

    it('ignores caller-supplied _deletedAt: null (stored live)', async () => {
      const ds = mkDs();
      await ds.write('Todo', [{ id: 1, title: 'a', _deletedAt: null }]);

      const { rows } = await ds.read('Todo', {});
      expect(rows).toHaveLength(1);
      expect(rows[0]?._deletedAt).toBeUndefined();
    });

    it('write cannot revive a tombstone via _deletedAt: null', async () => {
      const ds = mkDs();
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      await ds.tombstone('Todo', [1]);

      // Caller tries to revive via explicit null.
      await ds.write('Todo', [{ id: 1, title: 'revived', _deletedAt: null }]);

      const { rows: live } = await ds.read('Todo', {});
      expect(live).toHaveLength(0);
      const { rows: all } = await ds.read('Todo', { includeDeleted: true });
      expect(all).toHaveLength(1);
      expect(all[0]?._deletedAt).toBeInstanceOf(Date);
    });
  });

  describe('read', () => {
    it('filters tombstoned rows by default', async () => {
      const ds = mkDs();
      await ds.write('Todo', [
        { id: 1, title: 'a' },
        { id: 2, title: 'b' }
      ]);
      await ds.tombstone('Todo', [1]);

      const { rows } = await ds.read('Todo', {});
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(2);
    });

    it('includeDeleted: true returns tombstoned rows', async () => {
      const ds = mkDs();
      await ds.write('Todo', [
        { id: 1, title: 'a' },
        { id: 2, title: 'b' }
      ]);
      await ds.tombstone('Todo', [1]);

      const { rows } = await ds.read('Todo', { includeDeleted: true });
      expect(rows).toHaveLength(2);
    });

    it('returns empty array for unknown type', async () => {
      const ds = mkDs();
      const { rows } = await ds.read('Unknown', {});
      expect(rows).toEqual([]);
    });

    it('filters by id', async () => {
      const ds = mkDs();
      await ds.write('Todo', [
        { id: 1, title: 'a' },
        { id: 2, title: 'b' }
      ]);
      const { rows } = await ds.read('Todo', { id: 2 });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(2);
    });

    it('filters by ids', async () => {
      const ds = mkDs();
      await ds.write('Todo', [
        { id: 1, title: 'a' },
        { id: 2, title: 'b' },
        { id: 3, title: 'c' }
      ]);
      const { rows } = await ds.read('Todo', { ids: [1, 3] });
      const ids = rows.map((r) => r.id).sort();
      expect(ids).toEqual([1, 3]);
    });

    it('honours limit — caller receives at most n live rows', async () => {
      const ds = mkDs();
      await ds.write(
        'Todo',
        Array.from({ length: 25 }, (_, i) => ({ id: i + 1, title: `t${i + 1}` }))
      );

      const { rows: capped } = await ds.read('Todo', { limit: 10 });
      expect(capped).toHaveLength(10);

      const { rows: zero } = await ds.read('Todo', { limit: 0 });
      expect(zero).toHaveLength(0);

      const { rows: unbounded } = await ds.read('Todo', {});
      expect(unbounded).toHaveLength(25);
    });

    it('limit is applied after _deletedAt filter', async () => {
      const ds = mkDs();
      await ds.write('Todo', [
        { id: 1, title: 'a' },
        { id: 2, title: 'b' },
        { id: 3, title: 'c' },
        { id: 4, title: 'd' }
      ]);
      await ds.tombstone('Todo', [1, 2]);

      const { rows } = await ds.read('Todo', { limit: 10 });
      expect(rows.map((r) => r.id).sort()).toEqual([3, 4]);
    });
  });

  describe('tombstone', () => {
    it('stamps _deletedAt', async () => {
      const ds = mkDs();
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      const res = await ds.tombstone('Todo', [1]);

      expect(res.deleted).toBe(1);
      expect(res.ids).toEqual([1]);

      const { rows } = await ds.read('Todo', { id: 1, includeDeleted: true });
      expect(rows[0]?._deletedAt).toBeInstanceOf(Date);
    });

    it('preserves original _deletedAt on already-tombstoned row (terminal)', async () => {
      const ds = mkDs();
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      await ds.tombstone('Todo', [1]);

      const { rows: firstRows } = await ds.read('Todo', { id: 1, includeDeleted: true });
      const originalStamp = firstRows[0]?._deletedAt as Date;

      // Force any clock drift between the two calls.
      await new Promise((r) => setTimeout(r, 5));

      const res = await ds.tombstone('Todo', [1]);
      expect(res.deleted).toBe(0);
      expect(res.ids).toEqual([]);

      const { rows: secondRows } = await ds.read('Todo', { id: 1, includeDeleted: true });
      expect(secondRows[0]?._deletedAt).toBe(originalStamp);
    });

    it('silent no-op for nonexistent id (returns 0)', async () => {
      const ds = mkDs();
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      const res = await ds.tombstone('Todo', [999]);
      expect(res.deleted).toBe(0);
      expect(res.ids).toEqual([]);
    });

    it('silent no-op for unknown type', async () => {
      const ds = mkDs();
      const res = await ds.tombstone('Unknown', [1, 2]);
      expect(res.deleted).toBe(0);
      expect(res.ids).toEqual([]);
    });

    it('mixed batch: counts only newly-stamped ids', async () => {
      const ds = mkDs();
      await ds.write('Todo', [
        { id: 1, title: 'a' },
        { id: 2, title: 'b' },
        { id: 3, title: 'c' }
      ]);
      await ds.tombstone('Todo', [1]); // already tombstoned

      const res = await ds.tombstone('Todo', [1, 2, 999]);
      expect(res.deleted).toBe(1);
      expect(res.ids).toEqual([2]);
    });
  });

  describe('purge', () => {
    it('removes live rows', async () => {
      const ds = mkDs();
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      const res = await ds.purge('Todo', [1]);
      expect(res.deleted).toBe(1);
      expect(res.ids).toEqual([1]);

      const { rows } = await ds.read('Todo', { includeDeleted: true });
      expect(rows).toHaveLength(0);
    });

    it('removes tombstoned rows', async () => {
      const ds = mkDs();
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      await ds.tombstone('Todo', [1]);
      const res = await ds.purge('Todo', [1]);
      expect(res.deleted).toBe(1);

      const { rows } = await ds.read('Todo', { includeDeleted: true });
      expect(rows).toHaveLength(0);
    });

    it('returns 0 on nonexistent id', async () => {
      const ds = mkDs();
      const res = await ds.purge('Todo', [999]);
      expect(res.deleted).toBe(0);
      expect(res.ids).toEqual([]);
    });
  });

  describe('updateField', () => {
    it('sets a field', async () => {
      const ds = mkDs();
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      await ds.updateField({ type: 'Todo', id: 1 }, 'status', 'done');

      const { rows } = await ds.read('Todo', { id: 1 });
      expect(rows[0]?.status).toBe('done');
    });

    it('throws ReservedField when updating _deletedAt', async () => {
      const ds = mkDs();
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      await expect(
        ds.updateField({ type: 'Todo', id: 1 }, '_deletedAt', new Date())
      ).rejects.toBeInstanceOf(ReservedField);
    });

    it('throws NamespaceMismatch for mismatched ref.ns', async () => {
      const ds = mkDs('claude');
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      await expect(
        ds.updateField({ ns: 'default', type: 'Todo', id: 1 }, 'status', 'done')
      ).rejects.toBeInstanceOf(NamespaceMismatch);
    });

    it('succeeds with matching ref.ns', async () => {
      const ds = mkDs('claude');
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      await ds.updateField({ ns: 'claude', type: 'Todo', id: 1 }, 'status', 'done');

      const { rows } = await ds.read('Todo', { id: 1 });
      expect(rows[0]?.status).toBe('done');
    });

    it('silent no-op on nonexistent row', async () => {
      const ds = mkDs();
      await expect(
        ds.updateField({ type: 'Todo', id: 999 }, 'status', 'done')
      ).resolves.toBeUndefined();
    });

    it('silent no-op on nonexistent type', async () => {
      const ds = mkDs();
      await expect(
        ds.updateField({ type: 'Unknown', id: 1 }, 'status', 'done')
      ).resolves.toBeUndefined();
    });

    it('validation order: namespace mismatch fires BEFORE reserved-field check', async () => {
      const ds = mkDs('claude');
      await ds.write('Todo', [{ id: 1, title: 'a' }]);
      // Mismatched ns + reserved field — must be NamespaceMismatch, not ReservedField.
      await expect(
        ds.updateField({ ns: 'default', type: 'Todo', id: 1 }, '_deletedAt', new Date())
      ).rejects.toBeInstanceOf(NamespaceMismatch);
    });

    it('validation order: reserved-field check fires BEFORE missing-row check', async () => {
      const ds = mkDs();
      // No rows exist. Reserved field must still throw (not silent no-op).
      await expect(
        ds.updateField({ type: 'Todo', id: 999 }, '_deletedAt', new Date())
      ).rejects.toBeInstanceOf(ReservedField);
    });
  });

  // ----------------------------------------------------------------------
  // conditionalUpdate (§5.12 Phase 2 / Dispatch B)
  // ----------------------------------------------------------------------

  describe('conditionalUpdate', () => {
    it('returns matched:true + merged row when every match clause holds', async () => {
      const ds = mkDs();
      await ds.write('Invite', [{ id: 'inv-1', consumedAt: null, capacity: 5 }]);
      const res = await ds.conditionalUpdate(
        'Invite',
        'inv-1',
        { consumedAt: null },
        { consumedAt: new Date('2026-04-19T00:00:00Z'), consumedBy: 'kid-abc' }
      );
      expect(res.matched).toBe(true);
      expect(res.row).toBeDefined();
      expect(res.row?.consumedBy).toBe('kid-abc');
      // Original fields preserved.
      expect(res.row?.capacity).toBe(5);
    });

    it('returns matched:false when the match predicate fails (no write lands)', async () => {
      const ds = mkDs();
      const alreadyConsumed = new Date('2026-04-18T00:00:00Z');
      await ds.write('Invite', [{ id: 'inv-2', consumedAt: alreadyConsumed, consumedBy: 'kid-x' }]);
      const res = await ds.conditionalUpdate(
        'Invite',
        'inv-2',
        { consumedAt: null },
        { consumedBy: 'kid-y' }
      );
      expect(res.matched).toBe(false);
      expect(res.row).toBeNull();
      const { rows } = await ds.read('Invite', { id: 'inv-2' });
      expect(rows[0]?.consumedBy).toBe('kid-x');
    });

    it('returns matched:false on a tombstoned row, and writes nothing', async () => {
      const ds = mkDs();
      await ds.write('Invite', [{ id: 'inv-del', consumedAt: null }]);
      await ds.tombstone('Invite', ['inv-del']);
      const res = await ds.conditionalUpdate(
        'Invite',
        'inv-del',
        { consumedAt: null },
        { consumedBy: 'kid-y' }
      );
      expect(res).toEqual({ matched: false, row: null });
      const { rows } = await ds.read('Invite', { id: 'inv-del', includeDeleted: true });
      expect(rows[0]?.consumedBy).toBeUndefined();
    });

    it('returns matched:false when the row does not exist', async () => {
      const ds = mkDs();
      const res = await ds.conditionalUpdate('Invite', 'missing', {}, { foo: 'bar' });
      expect(res).toEqual({ matched: false, row: null });
    });

    it('concurrent callers serialise — exactly one matches on a single-consume row', async () => {
      const ds = mkDs();
      await ds.write('Invite', [{ id: 'race', consumedAt: null }]);
      const fire = (): Promise<{ matched: boolean }> =>
        ds.conditionalUpdate(
          'Invite',
          'race',
          { consumedAt: null },
          { consumedAt: new Date(), consumedBy: 'winner' }
        );
      const results = await Promise.all([fire(), fire(), fire(), fire()]);
      const matched = results.filter((r) => r.matched);
      expect(matched).toHaveLength(1);
    });

    it('Date equality works against stored Date values', async () => {
      const ds = mkDs();
      const at = new Date('2026-01-01T00:00:00Z');
      await ds.write('Token', [{ id: 't1', rotatedAt: at }]);
      const ok = await ds.conditionalUpdate(
        'Token',
        't1',
        { rotatedAt: new Date(at.getTime()) },
        { rotatedAt: new Date('2026-06-01T00:00:00Z') }
      );
      expect(ok.matched).toBe(true);
      const fail = await ds.conditionalUpdate(
        'Token',
        't1',
        { rotatedAt: new Date('2025-01-01T00:00:00Z') },
        { rotatedAt: new Date() }
      );
      expect(fail.matched).toBe(false);
    });

    it('silently strips _deletedAt and id from the updates map', async () => {
      const ds = mkDs();
      await ds.write('Todo', [{ id: 'r1', title: 'original' }]);
      const res = await ds.conditionalUpdate(
        'Todo',
        'r1',
        {},
        { id: 'r2', _deletedAt: new Date(), title: 'updated' }
      );
      expect(res.matched).toBe(true);
      expect(res.row?.id).toBe('r1');
      expect(res.row?._deletedAt).toBeUndefined();
      expect(res.row?.title).toBe('updated');
    });

    // ─── Metadata bump ─────────────────────────────────────────────────────
    // Without this bump, rows mutated through conditionalUpdate stay at their
    // original updatedAt and silently drift out of recency-ranked recall.

    it('bumps _metadata.updatedAt + updatedBy on a successful match', async () => {
      const ds = mkDs();
      const createdAt = '2026-01-01T00:00:00.000Z';
      const createdBy = { kind: 'agent' as const, id: 'a-original' };
      await ds.write('Invite', [
        {
          id: 'inv-1',
          consumedAt: null,
          _metadata: { createdAt, updatedAt: createdAt, createdBy, updatedBy: createdBy }
        }
      ]);

      const beforeMs = Date.now();
      const actor = { kind: 'agent' as const, id: 'kid-abc' };
      const res = await ds.conditionalUpdate(
        'Invite',
        'inv-1',
        { consumedAt: null },
        { consumedAt: new Date('2026-04-19T00:00:00Z'), consumedBy: 'kid-abc' },
        actor
      );
      const afterMs = Date.now();

      expect(res.matched).toBe(true);
      const meta = res.row?._metadata;
      expect(meta).toBeDefined();
      // updatedAt bumped to ~now
      const updatedMs = Date.parse(meta?.updatedAt ?? '');
      expect(updatedMs).toBeGreaterThanOrEqual(beforeMs);
      expect(updatedMs).toBeLessThanOrEqual(afterMs);
      // updatedBy stamped with the supplied actor
      expect(meta?.updatedBy).toEqual(actor);
      // createdAt + createdBy preserved
      expect(meta?.createdAt).toBe(createdAt);
      expect(meta?.createdBy).toEqual(createdBy);
    });

    it('falls back to system/anonymous when actor is omitted', async () => {
      const ds = mkDs();
      await ds.write('Invite', [
        {
          id: 'inv-noActor',
          consumedAt: null,
          _metadata: {
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            createdBy: { kind: 'agent', id: 'a1' },
            updatedBy: { kind: 'agent', id: 'a1' }
          }
        }
      ]);

      const res = await ds.conditionalUpdate(
        'Invite',
        'inv-noActor',
        { consumedAt: null },
        { consumedBy: 'someone' }
      );

      expect(res.matched).toBe(true);
      expect(res.row?._metadata?.updatedBy).toEqual({ kind: 'system', id: 'anonymous' });
    });

    it('failed match does not touch _metadata', async () => {
      const ds = mkDs();
      const meta = {
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        createdBy: { kind: 'agent' as const, id: 'a1' },
        updatedBy: { kind: 'agent' as const, id: 'a1' }
      };
      await ds.write('Invite', [
        { id: 'inv-fail', consumedAt: new Date('2026-02-01T00:00:00Z'), _metadata: meta }
      ]);

      // Match against `consumedAt: null` but the row's consumedAt is set → fail.
      const res = await ds.conditionalUpdate(
        'Invite',
        'inv-fail',
        { consumedAt: null },
        { consumedBy: 'attempted' }
      );
      expect(res.matched).toBe(false);

      // Read back: _metadata must be unchanged.
      const { rows } = await ds.read('Invite', { id: 'inv-fail' });
      expect(rows[0]?._metadata).toEqual(meta);
    });
  });
});

describe('MemoryDataset short-id methods', () => {
  it('allocateShortId advances per-(ns, type) counter', async () => {
    const ds = new MemoryDataset({ namespace: 'claude' });
    expect(await ds.allocateShortId('Todo')).toBe(1);
    expect(await ds.allocateShortId('Todo')).toBe(2);
    expect(await ds.allocateShortId('Decision')).toBe(1);
    // Different dataset instance (different namespace) has its own counter.
    const planeDs = new MemoryDataset({ namespace: 'plane' });
    expect(await planeDs.allocateShortId('Observation')).toBe(1);
  });

  it('resolveShortId returns null pre-bind and the rowId post-bind', async () => {
    const ds = new MemoryDataset({ namespace: 'claude' });
    const short = await ds.allocateShortId('Todo');
    expect(await ds.resolveShortId('Todo', short)).toBeNull();
    await ds.bindShortId('Todo', short, 'uuid-a');
    expect(await ds.resolveShortId('Todo', short)).toBe('uuid-a');
  });

  it('getShortIdForRow is the inverse of bindShortId', async () => {
    const ds = new MemoryDataset({ namespace: 'claude' });
    const short = await ds.allocateShortId('Todo');
    await ds.bindShortId('Todo', short, 'uuid-a');
    expect(await ds.getShortIdForRow('Todo', 'uuid-a')).toBe(short);
    expect(await ds.getShortIdForRow('Todo', 'nope')).toBeNull();
  });

  it('short-id state is isolated between dataset instances with different namespaces', async () => {
    const claudeDs = new MemoryDataset({ namespace: 'claude' });
    const planeDs = new MemoryDataset({ namespace: 'plane' });
    await claudeDs.allocateShortId('Todo'); // claude/Todo = 1
    expect(await planeDs.allocateShortId('Observation')).toBe(1); // plane/Observation starts at 1
    // Two different instances don't share state.
    expect(await planeDs.resolveShortId('Todo', 1)).toBeNull();
  });
});
