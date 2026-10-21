/**
 * §5.12 — `Invite` reaper.
 *
 * `runInviteSweep(dataset)` soft-deletes every `Invite` row whose
 * `consumedAt` is null and `expiresAt` predates the cutoff. Tests seed rows
 * directly via the dataset to bypass the admin gate (same trick the register
 * route uses) and inspect post-call state with `includeDeleted: true` to
 * observe tombstones.
 */

import { INVITE_TYPE, runInviteSweep, SYSTEM_NAMESPACE } from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function seed(dataset: MemoryDataset, id: string, fields: Record<string, unknown>): void {
  void dataset.write(INVITE_TYPE, [
    {
      id,
      namespaces: 'default',
      capabilities: 'read',
      consumedAt: null,
      consumedBy: null,
      ...fields
    }
  ]);
}

describe('runInviteSweep', () => {
  let dataset: MemoryDataset;
  const now = new Date('2026-04-20T12:00:00.000Z');

  beforeEach(() => {
    dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
  });

  afterEach(() => {
    // Memory dataset has no resources to release.
  });

  it('removes expired unconsumed invites, preserves consumed and still-valid ones', async () => {
    // (a) expired + unconsumed → should be tombstoned.
    seed(dataset, 'a-expired-unconsumed', {
      expiresAt: new Date(now.getTime() - 60_000),
      consumedAt: null
    });
    // (b) expired + consumed → should be kept (audit trail).
    seed(dataset, 'b-expired-consumed', {
      expiresAt: new Date(now.getTime() - 60_000),
      consumedAt: new Date(now.getTime() - 120_000),
      consumedBy: 'kid-xyz'
    });
    // (c) not-expired + unconsumed → should be kept.
    seed(dataset, 'c-future-unconsumed', {
      expiresAt: new Date(now.getTime() + 60_000),
      consumedAt: null
    });

    const result = await runInviteSweep(dataset, { now: () => now });
    expect(result).toEqual({ deleted: 1 });

    // Only (a) should be tombstoned. Default read hides tombstones.
    const live = await dataset.read(INVITE_TYPE, {});
    const liveIds = live.rows.map((r) => r.id).sort();
    expect(liveIds).toEqual(['b-expired-consumed', 'c-future-unconsumed']);

    const all = await dataset.read(INVITE_TYPE, { includeDeleted: true });
    const tombstoned = all.rows.filter((r) => r._deletedAt != null).map((r) => r.id);
    expect(tombstoned).toEqual(['a-expired-unconsumed']);
  });

  it('is idempotent: second call with no change returns { deleted: 0 }', async () => {
    seed(dataset, 'a-expired-unconsumed', {
      expiresAt: new Date(now.getTime() - 60_000),
      consumedAt: null
    });
    const first = await runInviteSweep(dataset, { now: () => now });
    expect(first).toEqual({ deleted: 1 });
    const second = await runInviteSweep(dataset, { now: () => now });
    expect(second).toEqual({ deleted: 0 });
  });

  it('empty dataset returns { deleted: 0 }', async () => {
    const result = await runInviteSweep(dataset, { now: () => now });
    expect(result).toEqual({ deleted: 0 });
  });

  it('sweeps multiple expired rows in a single transactional tombstone', async () => {
    for (let i = 0; i < 5; i++) {
      seed(dataset, `expired-${i}`, {
        expiresAt: new Date(now.getTime() - 60_000),
        consumedAt: null
      });
    }
    seed(dataset, 'fresh', {
      expiresAt: new Date(now.getTime() + 60_000),
      consumedAt: null
    });
    const result = await runInviteSweep(dataset, { now: () => now });
    expect(result).toEqual({ deleted: 5 });
    const live = await dataset.read(INVITE_TYPE, {});
    expect(live.rows.map((r) => r.id)).toEqual(['fresh']);
  });

  it('defaults `now` to wall-clock Date — works without a test seam', async () => {
    seed(dataset, 'long-expired', {
      expiresAt: new Date(Date.now() - 86_400_000),
      consumedAt: null
    });
    const result = await runInviteSweep(dataset);
    expect(result).toEqual({ deleted: 1 });
  });
});
