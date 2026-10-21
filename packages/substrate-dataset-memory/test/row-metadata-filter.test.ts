import type { ActorIdentity, RowMetadata } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { MemoryDataset } from '../src/index.js';

const ROWS = [
  {
    id: 't1',
    name: 'a',
    _metadata: meta('2026-04-25T00:00:00Z', { kind: 'agent' as const, id: 'a1' })
  },
  {
    id: 't2',
    name: 'b',
    _metadata: meta('2026-04-25T01:00:00Z', { kind: 'agent' as const, id: 'a2' })
  },
  {
    id: 't3',
    name: 'c',
    _metadata: meta('2026-04-25T02:00:00Z', { kind: 'user' as const, id: 'u1' })
  }
];

function meta(at: string, by: ActorIdentity): RowMetadata {
  return { createdAt: at, updatedAt: at, createdBy: by, updatedBy: by };
}

describe('MemoryDataset filter dispatch on _metadata', () => {
  it('where on createdAt routes to _metadata (gt range)', async () => {
    const ds = new MemoryDataset({ namespace: 'test' });
    await ds.write('Thing', ROWS);
    const result = await ds.read('Thing', {
      where: { createdAt: { gt: '2026-04-25T00:30:00Z' } }
    });
    expect(result.rows.map((r) => r.id).sort()).toEqual(['t2', 't3']);
  });

  it('where on createdAt with eq exact match', async () => {
    const ds = new MemoryDataset({ namespace: 'test' });
    await ds.write('Thing', ROWS);
    const result = await ds.read('Thing', {
      where: { createdAt: { eq: '2026-04-25T01:00:00Z' } }
    });
    expect(result.rows.map((r) => r.id)).toEqual(['t2']);
  });

  it('where on createdByKind filters by metadata identity kind', async () => {
    const ds = new MemoryDataset({ namespace: 'test' });
    await ds.write('Thing', ROWS);
    const result = await ds.read('Thing', {
      where: { createdByKind: { eq: 'user' } }
    });
    expect(result.rows.map((r) => r.id)).toEqual(['t3']);
  });

  it('where on createdById filters by metadata identity id', async () => {
    const ds = new MemoryDataset({ namespace: 'test' });
    await ds.write('Thing', ROWS);
    const result = await ds.read('Thing', {
      where: { createdById: { eq: 'a2' } }
    });
    expect(result.rows.map((r) => r.id)).toEqual(['t2']);
  });

  it('where on updatedAt routes to _metadata (between)', async () => {
    const ds = new MemoryDataset({ namespace: 'test' });
    await ds.write('Thing', ROWS);
    const result = await ds.read('Thing', {
      where: { updatedAt: { between: ['2026-04-25T00:30:00Z', '2026-04-25T01:30:00Z'] } }
    });
    expect(result.rows.map((r) => r.id)).toEqual(['t2']);
  });

  it('where on createdAt for raw write (no opts) auto-filled timestamp respects gt filter', async () => {
    const ds = new MemoryDataset({ namespace: 'test' });
    // Write 't4' with no _metadata and a fixed past now so its auto-filled
    // createdAt is predictably before the threshold.
    const pastNow = new Date('2026-04-24T12:00:00.000Z');
    await ds.write('Thing', [{ id: 't4', name: 'legacy' }], { now: pastNow });
    await ds.write('Thing', ROWS);
    const result = await ds.read('Thing', {
      where: { createdAt: { gt: '2026-04-25T00:00:00Z' } }
    });
    // 't4' was auto-filled with createdAt='2026-04-24T12:00:00Z' (before threshold),
    // so it is excluded. 't2' and 't3' are included.
    expect(result.rows.map((r) => r.id).sort()).toEqual(['t2', 't3']);
  });
});
