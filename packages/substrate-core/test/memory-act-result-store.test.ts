import type { ActResultRecord, ActResultStore } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { MemoryActResultStore } from '../src/memory-act-result-store.js';

const rec = (id: string, owner: string, extra: Partial<ActResultRecord> = {}): ActResultRecord => ({
  id,
  owner,
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-02T00:00:00.000Z',
  mode: 'write',
  ok: true,
  schemaVersion: 'v1',
  sketch: 'find Thing',
  plan: { steps: [] } as unknown as ActResultRecord['plan'],
  steps: [],
  ...extra
});

function cases(make: () => ActResultStore): void {
  const DAY = 86_400_000;
  it('put then get by owner returns the record', async () => {
    const s = make();
    await s.put(rec('r1', 'alice'), DAY);
    expect(await s.get('r1', 'alice')).toMatchObject({ id: 'r1', owner: 'alice' });
  });
  it('get by another owner is undefined', async () => {
    const s = make();
    await s.put(rec('r1', 'alice'), DAY);
    expect(await s.get('r1', 'bob')).toBeUndefined();
  });
  it('ttlMs 0 is expired at once and reaped', async () => {
    const s = make();
    await s.put(rec('r1', 'alice'), 0);
    expect(await s.get('r1', 'alice')).toBeUndefined();
    expect(await s.reapExpired()).toEqual({ deleted: 1 });
  });
  it('first live write for (owner, key) wins', async () => {
    const s = make();
    await s.put(rec('r1', 'alice', { idempotencyKey: 'k' }), DAY);
    await s.put(rec('r2', 'alice', { idempotencyKey: 'k' }), DAY);
    expect((await s.findByIdempotencyKey('alice', 'k'))?.id).toBe('r1');
    expect(await s.get('r2', 'alice')).toBeUndefined();
  });
  it('the same key under another owner is independent', async () => {
    const s = make();
    await s.put(rec('r1', 'alice', { idempotencyKey: 'k' }), DAY);
    await s.put(rec('r2', 'bob', { idempotencyKey: 'k' }), DAY);
    expect((await s.findByIdempotencyKey('alice', 'k'))?.id).toBe('r1');
    expect((await s.findByIdempotencyKey('bob', 'k'))?.id).toBe('r2');
  });
  it('an expired key is replaced by a new put', async () => {
    const s = make();
    await s.put(rec('r1', 'alice', { idempotencyKey: 'k' }), 0);
    await s.put(rec('r2', 'alice', { idempotencyKey: 'k' }), DAY);
    expect((await s.findByIdempotencyKey('alice', 'k'))?.id).toBe('r2');
  });
  it('bigint comes back as a decimal string', async () => {
    const s = make();
    const steps = [{ step: 1, action: 'find', type: 'Thing', rows: [{ big: 9007199254740993n }] }];
    await s.put(rec('r1', 'alice', { steps: steps as unknown as ActResultRecord['steps'] }), DAY);
    expect((await s.get('r1', 'alice'))?.steps[0]?.rows?.[0]?.big).toBe('9007199254740993');
  });
}

describe('MemoryActResultStore', () => cases(() => new MemoryActResultStore()));
