import type { Dataset, Id } from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
import { resolveEntityId, resolveEntityRow } from '../src/short-id-resolver.js';

function fakeDataset(opts: { rawHit?: Id; shortMap?: Record<number, string> }): Dataset {
  return {
    read: vi.fn(async (_type: string, { id }: { id?: Id }) => {
      if (id !== undefined && id === opts.rawHit) {
        return { rows: [{ id, body: {}, deletedAt: null }], hasMore: false };
      }
      return { rows: [], hasMore: false };
    }),
    resolveShortId: vi.fn(async (_type: string, short: number) => opts.shortMap?.[short] ?? null)
  } as unknown as Dataset;
}

describe('resolveEntityId', () => {
  it('returns raw id when rows has it (UUID case)', async () => {
    const ds = fakeDataset({ rawHit: 'bf03fcf8-uuid' });
    expect(await resolveEntityId(ds, 'Todo', 'bf03fcf8-uuid')).toBe('bf03fcf8-uuid');
  });

  it('returns raw id when rows has a legacy numeric-string id', async () => {
    const ds = fakeDataset({ rawHit: '1052' });
    expect(await resolveEntityId(ds, 'Todo', '1052')).toBe('1052');
  });

  it('falls back to sidecar when raw misses and input is int-like', async () => {
    const ds = fakeDataset({ rawHit: 'bf03fcf8-uuid', shortMap: { 1056: 'bf03fcf8-uuid' } });
    expect(await resolveEntityId(ds, 'Todo', '1056')).toBe('bf03fcf8-uuid');
  });

  it('returns null for a short id bound to a row that is no longer live', async () => {
    const ds = fakeDataset({ shortMap: { 1056: 'tombstoned-uuid' } });
    expect(await resolveEntityId(ds, 'Todo', '1056')).toBeNull();
  });

  it('returns null when raw misses and input is not int-like', async () => {
    const ds = fakeDataset({});
    expect(await resolveEntityId(ds, 'Todo', 'unknown-ref')).toBeNull();
  });

  it('returns null when raw misses and sidecar misses too', async () => {
    const ds = fakeDataset({});
    expect(await resolveEntityId(ds, 'Todo', '9999')).toBeNull();
  });

  it('prefers raw over sidecar (collision-safe)', async () => {
    const ds = fakeDataset({ rawHit: '42', shortMap: { 42: 'different-uuid' } });
    expect(await resolveEntityId(ds, 'Todo', '42')).toBe('42');
    // Short-circuit invariant: sidecar MUST NOT be consulted on a raw hit.
    expect(ds.resolveShortId).not.toHaveBeenCalled();
  });

  it('preserves numeric id type when the row stored a number (not a stringified form)', async () => {
    // Regression: a stringified numeric id misses MemoryDataset's
    // Map-keyed updateField/delete, so the resolver returns the id as stored.
    const ds = fakeDataset({ rawHit: 1 });
    const resolved = await resolveEntityId(ds, 'Meeting', 1);
    expect(resolved).toBe(1);
    expect(typeof resolved).toBe('number');
  });

  it('returns null for numeric inputs beyond Number.MAX_SAFE_INTEGER', async () => {
    // PG bigint holds up to 2^63; JS Number precision ends at 2^53 - 1.
    // parseInt of "9007199254740993" returns 9007199254740992 — truncated.
    // Resolver must short-circuit to null rather than ask the sidecar for
    // a wrong id.
    const ds = fakeDataset({});
    expect(await resolveEntityId(ds, 'Todo', '9007199254740993')).toBeNull();
    // 17+ digit inputs short-circuit on length before parseInt.
    expect(await resolveEntityId(ds, 'Todo', '99999999999999999')).toBeNull();
    expect(ds.resolveShortId).not.toHaveBeenCalled();
  });
});

describe('resolveEntityRow', () => {
  it('returns the row from the raw lookup in a single read', async () => {
    const ds = fakeDataset({ rawHit: 'bf03fcf8-uuid' });
    const row = await resolveEntityRow(ds, 'Message', 'bf03fcf8-uuid');
    expect(row?.id).toBe('bf03fcf8-uuid');
    // The raw-hit path must not pay a second read — that is the point of the
    // row-shaped variant over resolveEntityId + re-read.
    expect(ds.read).toHaveBeenCalledTimes(1);
    expect(ds.resolveShortId).not.toHaveBeenCalled();
  });

  it('resolves short-form input to the row via the sidecar + one extra read', async () => {
    const ds = fakeDataset({ rawHit: 'bf03fcf8-uuid', shortMap: { 1056: 'bf03fcf8-uuid' } });
    const row = await resolveEntityRow(ds, 'Message', '1056');
    expect(row?.id).toBe('bf03fcf8-uuid');
    expect(ds.read).toHaveBeenCalledTimes(2);
  });

  it('returns null when both raw and sidecar lookups miss', async () => {
    const ds = fakeDataset({});
    expect(await resolveEntityRow(ds, 'Message', '9999')).toBeNull();
    expect(await resolveEntityRow(ds, 'Message', 'unknown-ref')).toBeNull();
  });

  it('returns null when the sidecar resolves but the row read misses (tombstoned)', async () => {
    const ds = fakeDataset({ shortMap: { 7: 'gone-uuid' } });
    expect(await resolveEntityRow(ds, 'Message', '7')).toBeNull();
  });
});
