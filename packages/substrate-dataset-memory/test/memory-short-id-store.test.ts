import { describe, expect, it } from 'vitest';
import { MemoryShortIdStore } from '../src/memory-short-id-store.js';

describe('MemoryShortIdStore', () => {
  it('allocates monotonic ids per (namespace, type)', async () => {
    const store = new MemoryShortIdStore();
    expect(await store.allocate('claude', 'Todo', 'uuid-a')).toBe(1);
    expect(await store.allocate('claude', 'Todo', 'uuid-b')).toBe(2);
    expect(await store.allocate('claude', 'Decision', 'uuid-c')).toBe(1);
    expect(await store.allocate('plane', 'Observation', 'uuid-d')).toBe(1);
  });

  it('resolves short id to row id', async () => {
    const store = new MemoryShortIdStore();
    await store.allocate('claude', 'Todo', 'uuid-a');
    const rid = await store.resolveShortId('claude', 'Todo', 1);
    expect(rid).toBe('uuid-a');
  });

  it('returns null for unknown short id', async () => {
    const store = new MemoryShortIdStore();
    expect(await store.resolveShortId('claude', 'Todo', 999)).toBeNull();
  });

  it('returns the short id for a known row id', async () => {
    const store = new MemoryShortIdStore();
    await store.allocate('claude', 'Todo', 'uuid-a');
    expect(await store.getShortIdForRow('claude', 'Todo', 'uuid-a')).toBe(1);
  });

  it('returns null for unknown row id', async () => {
    const store = new MemoryShortIdStore();
    expect(await store.getShortIdForRow('claude', 'Todo', 'unknown')).toBeNull();
  });

  it('supports preload for backfill paths', async () => {
    const store = new MemoryShortIdStore();
    store.preload('claude', 'Todo', [
      { shortId: 1052, rowId: '1052' },
      { shortId: 828, rowId: '828' }
    ]);
    expect(await store.resolveShortId('claude', 'Todo', 1052)).toBe('1052');
    expect(await store.allocate('claude', 'Todo', 'new-uuid')).toBe(1053);
  });

  it('allocateUnbound advances the counter without recording a mapping', async () => {
    const store = new MemoryShortIdStore();
    const short = await store.allocateUnbound('claude', 'Todo');
    expect(short).toBe(1);
    // No mapping yet — resolve returns null until bind is called.
    expect(await store.resolveShortId('claude', 'Todo', 1)).toBeNull();
    await store.bind('claude', 'Todo', short, 'uuid-a');
    expect(await store.resolveShortId('claude', 'Todo', 1)).toBe('uuid-a');
    expect(await store.getShortIdForRow('claude', 'Todo', 'uuid-a')).toBe(1);
  });

  it('bind without prior allocateUnbound still records the mapping (idempotent)', async () => {
    const store = new MemoryShortIdStore();
    await store.bind('claude', 'Todo', 42, 'uuid-x');
    expect(await store.resolveShortId('claude', 'Todo', 42)).toBe('uuid-x');
  });

  it('_unbind removes the (shortId → rowId) mapping but leaves next advanced', async () => {
    const store = new MemoryShortIdStore();
    await store.allocate('claude', 'Todo', 'uuid-a');
    expect(await store.resolveShortId('claude', 'Todo', 1)).toBe('uuid-a');
    expect(await store.getShortIdForRow('claude', 'Todo', 'uuid-a')).toBe(1);

    store._unbind('claude', 'Todo', 1, 'uuid-a');

    expect(await store.resolveShortId('claude', 'Todo', 1)).toBeNull();
    expect(await store.getShortIdForRow('claude', 'Todo', 'uuid-a')).toBeNull();
    // Counter burned: next allocate returns 2, not 1.
    expect(await store.allocate('claude', 'Todo', 'uuid-b')).toBe(2);
  });

  it('_unbind is idempotent on unknown (shortId, rowId)', () => {
    const store = new MemoryShortIdStore();
    expect(() => store._unbind('claude', 'Todo', 999, 'nope')).not.toThrow();
  });

  describe('snapshotByRow', () => {
    it('returns an empty map when no bucket exists for (ns, type)', () => {
      const store = new MemoryShortIdStore();
      const snap = store.snapshotByRow('claude', 'Todo');
      expect(snap.size).toBe(0);
    });

    it('returns the current rowId → shortId mapping', async () => {
      const store = new MemoryShortIdStore();
      await store.allocate('claude', 'Todo', 'uuid-a');
      await store.allocate('claude', 'Todo', 'uuid-b');
      await store.allocate('claude', 'Decision', 'uuid-c');

      const snap = store.snapshotByRow('claude', 'Todo');
      expect(snap.get('uuid-a')).toBe(1);
      expect(snap.get('uuid-b')).toBe(2);
      expect(snap.size).toBe(2);
      // Decisions live in a different bucket — not visible here.
      expect(snap.get('uuid-c')).toBeUndefined();
    });

    it('reflects _unbind removals', async () => {
      const store = new MemoryShortIdStore();
      await store.allocate('claude', 'Todo', 'uuid-a');
      await store.allocate('claude', 'Todo', 'uuid-b');
      store._unbind('claude', 'Todo', 1, 'uuid-a');

      const snap = store.snapshotByRow('claude', 'Todo');
      expect(snap.get('uuid-a')).toBeUndefined();
      expect(snap.get('uuid-b')).toBe(2);
    });

    it('does not create a bucket when called on an unknown (ns, type)', async () => {
      const store = new MemoryShortIdStore();
      store.snapshotByRow('claude', 'Ghost');
      // First allocation should still start at 1 — the snapshot probe must not
      // have advanced any counter.
      expect(await store.allocate('claude', 'Ghost', 'uuid-a')).toBe(1);
    });
  });
});
