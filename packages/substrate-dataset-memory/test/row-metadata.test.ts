import type { RowMetadata } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { MemoryDataset } from '../src/index.js';

describe('MemoryDataset row metadata round-trip', () => {
  it('stores _metadata on write and projects it on read', async () => {
    const ds = new MemoryDataset({ namespace: 'test' });
    const meta: RowMetadata = {
      createdAt: '2026-04-25T00:00:00.000Z',
      updatedAt: '2026-04-25T00:00:00.000Z',
      createdBy: { kind: 'agent', id: 'a1' },
      updatedBy: { kind: 'agent', id: 'a1' }
    };
    await ds.write('Thing', [{ id: 't1', name: 'x', _metadata: meta }]);
    const result = await ds.read('Thing', {});
    const row = result.rows.find((r) => r.id === 't1');
    expect(row?._metadata).toEqual(meta);
  });

  it('preserves _metadata across multiple writes (later write wins per row)', async () => {
    const ds = new MemoryDataset({ namespace: 'test' });
    const t0 = '2026-04-25T00:00:00.000Z';
    const t1 = '2026-04-25T01:00:00.000Z';
    await ds.write('Thing', [
      {
        id: 't2',
        name: 'first',
        _metadata: {
          createdAt: t0,
          updatedAt: t0,
          createdBy: { kind: 'agent', id: 'a1' },
          updatedBy: { kind: 'agent', id: 'a1' }
        }
      }
    ]);
    await ds.write('Thing', [
      {
        id: 't2',
        name: 'second',
        _metadata: {
          createdAt: t0,
          updatedAt: t1,
          createdBy: { kind: 'agent', id: 'a1' },
          updatedBy: { kind: 'agent', id: 'a2' }
        }
      }
    ]);
    const result = await ds.read('Thing', {});
    const row = result.rows.find((r) => r.id === 't2');
    expect(row?.name).toBe('second');
    expect((row?._metadata as RowMetadata | undefined)?.updatedAt).toBe(t1);
    expect((row?._metadata as RowMetadata | undefined)?.updatedBy?.id).toBe('a2');
    // createdAt is preserved — caller is responsible for passing it through on update writes
    expect((row?._metadata as RowMetadata | undefined)?.createdAt).toBe(t0);
  });

  it('raw write with no opts auto-fills timestamps; identity columns null', async () => {
    const ds = new MemoryDataset({ namespace: 'test' });
    const before = Date.now();
    await ds.write('Thing', [{ id: 't3', name: 'no-meta' }]);
    const after = Date.now();
    const result = await ds.read('Thing', {});
    const row = result.rows.find((r) => r.id === 't3');
    expect(row?.name).toBe('no-meta');
    expect(row?._metadata).toBeDefined();
    expect(row?._metadata?.createdAt).toBeTypeOf('string');
    expect(row?._metadata?.updatedAt).toBeTypeOf('string');
    // Wall-clock fallback — within the bracketed window.
    const createdMs = Date.parse(row?._metadata?.createdAt ?? '');
    expect(createdMs).toBeGreaterThanOrEqual(before);
    expect(createdMs).toBeLessThanOrEqual(after);
    expect(row?._metadata?.createdBy).toBeNull();
    expect(row?._metadata?.updatedBy).toBeNull();
  });

  it('raw write with { identity, now } opts populates all four metadata fields from hint', async () => {
    const ds = new MemoryDataset({ namespace: 'test' });
    const fixedNow = new Date('2026-04-27T12:00:00.000Z');
    const actor = { kind: 'agent' as const, id: 'k-test' };
    await ds.write('Thing', [{ id: 't-hint', name: 'hinted' }], { now: fixedNow, identity: actor });
    const result = await ds.read('Thing', {});
    const row = result.rows.find((r) => r.id === 't-hint');
    expect(row?._metadata).toEqual({
      createdAt: '2026-04-27T12:00:00.000Z',
      updatedAt: '2026-04-27T12:00:00.000Z',
      createdBy: actor,
      updatedBy: actor
    });
  });

  it('partial _metadata write preserves existing createdAt/createdBy via per-field merge', async () => {
    // Mirrors pg-dataset's COALESCE(EXCLUDED, existing) semantics: a partial
    // _metadata struct (createdAt/createdBy null or absent) must NOT clobber
    // the existing immutable fields.
    const ds = new MemoryDataset({ namespace: 'test' });
    const t0 = '2026-04-25T00:00:00.000Z';
    const t1 = '2026-04-25T01:00:00.000Z';
    await ds.write('Thing', [
      {
        id: 't4',
        name: 'first',
        _metadata: {
          createdAt: t0,
          updatedAt: t0,
          createdBy: { kind: 'agent', id: 'a1' },
          updatedBy: { kind: 'agent', id: 'a1' }
        }
      }
    ]);
    // Partial _metadata — createdAt/createdBy null. Per pg parity, existing
    // values should survive.
    await ds.write('Thing', [
      {
        id: 't4',
        name: 'second',
        _metadata: {
          createdAt: null,
          updatedAt: t1,
          createdBy: null,
          updatedBy: { kind: 'agent', id: 'a2' }
        }
      }
    ]);
    const row = (await ds.read('Thing', {})).rows.find((r) => r.id === 't4');
    const meta = row?._metadata as RowMetadata | undefined;
    expect(meta?.createdAt).toBe(t0);
    expect(meta?.createdBy?.id).toBe('a1');
    expect(meta?.updatedAt).toBe(t1);
    expect(meta?.updatedBy?.id).toBe('a2');
    expect(row?.name).toBe('second');
  });

  it('raw write without _metadata over autoCRUD row: bumps updatedAt; preserves createdAt + createdBy + updatedBy', async () => {
    // Raw writes participate in the row-metadata contract: auto-fill creates
    // timestamps + null actor, then mergeRowMetadata preserves immutable
    // `created*` and adopts incoming `updated*`. The null incoming updatedBy
    // falls back to existing on per-field merge.
    const ds = new MemoryDataset({ namespace: 'test' });
    const meta: RowMetadata = {
      createdAt: '2026-04-25T00:00:00.000Z',
      updatedAt: '2026-04-25T00:00:00.000Z',
      createdBy: { kind: 'agent', id: 'a1' },
      updatedBy: { kind: 'agent', id: 'a1' }
    };
    await ds.write('Thing', [{ id: 't5', name: 'first', _metadata: meta }]);
    const before = Date.now();
    await ds.write('Thing', [{ id: 't5', name: 'second' }]);
    const after = Date.now();
    const row = (await ds.read('Thing', {})).rows.find((r) => r.id === 't5');
    expect(row?.name).toBe('second');
    expect(row?._metadata?.createdAt).toBe('2026-04-25T00:00:00.000Z');
    expect(row?._metadata?.createdBy).toEqual({ kind: 'agent', id: 'a1' });
    // updatedAt bumped to wall-clock now (auto-fill + incoming-wins on updated*)
    const updatedMs = Date.parse(row?._metadata?.updatedAt ?? '');
    expect(updatedMs).toBeGreaterThanOrEqual(before);
    expect(updatedMs).toBeLessThanOrEqual(after);
    // updatedBy: auto-fill set incoming.updatedBy=null; per-field merge falls
    // back to existing.updatedBy.
    expect(row?._metadata?.updatedBy).toEqual({ kind: 'agent', id: 'a1' });
  });

  it('raw upsert with { now } over an existing row preserves createdAt; bumps updatedAt', async () => {
    const ds = new MemoryDataset({ namespace: 'test' });
    const t0 = new Date('2026-04-27T10:00:00.000Z');
    const t1 = new Date('2026-04-27T11:00:00.000Z');
    const actor0 = { kind: 'agent' as const, id: 'creator' };
    const actor1 = { kind: 'agent' as const, id: 'updater' };

    await ds.write('Thing', [{ id: 'imm', name: 'v0' }], { now: t0, identity: actor0 });
    await ds.write('Thing', [{ id: 'imm', name: 'v1' }], { now: t1, identity: actor1 });

    const result = await ds.read('Thing', {});
    const row = result.rows.find((r) => r.id === 'imm');
    expect(row?.name).toBe('v1');
    expect(row?._metadata?.createdAt).toBe('2026-04-27T10:00:00.000Z');
    expect(row?._metadata?.updatedAt).toBe('2026-04-27T11:00:00.000Z');
    expect(row?._metadata?.createdBy).toEqual(actor0);
    expect(row?._metadata?.updatedBy).toEqual(actor1);
  });
});
