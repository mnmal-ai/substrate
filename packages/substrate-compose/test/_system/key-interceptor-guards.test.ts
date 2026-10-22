/**
 * The key mutations are reachable through plain `mutate` as well as the
 * `/_system/keys` routes, so the guards that must hold whatever the caller
 * asked for live in the interceptors: no write may leave zero active admins,
 * and no write may store a grant that will not parse. And a write to an OLD,
 * already-revoked row of a rotated kid must not touch the live key's cache entry.
 */

import { MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { RequestContext, ResolverArgs, Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { installSystemNamespace } from '../../src/_system/install.js';
import { SYSTEM_NAMESPACE } from '../../src/_system/types.js';

const CTX = {
  identity: {
    kind: 'agent',
    id: 'admin@test',
    agentKeyId: 'admin@test',
    kid: 'admin@test',
    capabilities: ['admin'],
    namespaces: ['*']
  },
  now: new Date()
} as unknown as RequestContext;

async function setup() {
  const store = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
  const registry = new Registry();
  const { keyRegistry } = await installSystemNamespace({
    registry,
    dataset: store,
    edges: new MemoryEdgesStore({ now: () => new Date() })
  });
  const call = (op: string, params: Record<string, unknown>) =>
    registry.get(op)?.resolver(CTX, { params, dataset: store } as unknown as ResolverArgs);
  const create = async (kid: string, overrides: Record<string, unknown> = {}) =>
    (await call('createKey', {
      kid,
      name: kid,
      algorithm: 'EdDSA',
      publicKey: `pk-${kid}`,
      namespaces: '*',
      capabilities: 'read,mutate,admin',
      revokedAt: null,
      ...overrides
    })) as Row;
  return { store, keyRegistry, call, create };
}

const LATER = new Date(Date.now() - 1000).toISOString();

describe('_system key interceptors — lockout guard', () => {
  it('refuses revoking the last active admin key through updateKey', async () => {
    const { call, create, keyRegistry } = await setup();
    const admin = await create('root@test');
    await expect(call('updateKey', { id: admin.id, revokedAt: LATER })).rejects.toMatchObject({
      code: 'last_active_admin'
    });
    expect(keyRegistry.lookup('root@test')).not.toBeNull();
  });

  it('refuses dropping admin from the last active admin key', async () => {
    const { call, create } = await setup();
    const admin = await create('root@test');
    await expect(
      call('updateKey', { id: admin.id, capabilities: 'read,mutate' })
    ).rejects.toMatchObject({ code: 'last_active_admin' });
  });

  it('refuses deleting the last active admin key', async () => {
    const { call, create } = await setup();
    const admin = await create('root@test');
    await expect(call('deleteKey', { id: admin.id })).rejects.toMatchObject({
      code: 'last_active_admin'
    });
  });

  it('allows revoking an admin while another stays active', async () => {
    const { call, create, keyRegistry } = await setup();
    const a = await create('a@test');
    await create('b@test');
    await call('updateKey', { id: a.id, revokedAt: LATER });
    expect(keyRegistry.lookup('a@test')).toBeNull();
  });

  it('of two concurrent revokes of the last two admins, refuses one', async () => {
    const { call, create, keyRegistry } = await setup();
    const a = await create('a@test');
    const b = await create('b@test');
    const results = await Promise.allSettled([
      call('updateKey', { id: a.id, revokedAt: LATER }),
      call('updateKey', { id: b.id, revokedAt: LATER })
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const live = ['a@test', 'b@test'].filter((k) => keyRegistry.lookup(k) !== null);
    expect(live).toHaveLength(1);
  });
});

describe('_system key interceptors — grant parsing', () => {
  it('refuses storing a grant that will not parse', async () => {
    const { call, create } = await setup();
    await create('root@test');
    const agent = await create('agent@test', { capabilities: 'read' });
    await expect(call('updateKey', { id: agent.id, namespaces: 'notes:' })).rejects.toMatchObject({
      code: 'invalid_grant_entry'
    });
    await expect(create('bad@test', { namespaces: 'notes:' })).rejects.toMatchObject({
      code: 'invalid_grant_entry'
    });
  });
});

describe('_system key interceptors — rotated kid', () => {
  async function rotated() {
    const ctx = await setup();
    await ctx.create('root@test');
    const old = await ctx.create('agent@test', { capabilities: 'read', publicKey: 'pk-old' });
    await ctx.call('updateKey', { id: old.id, revokedAt: LATER });
    await ctx.create('agent@test', { capabilities: 'read', publicKey: 'pk-new' });
    expect(ctx.keyRegistry.lookup('agent@test')?.publicKey).toBe('pk-new');
    return { ...ctx, old };
  }

  it('deleting the old revoked row keeps the live key', async () => {
    const { call, keyRegistry, old } = await rotated();
    await call('deleteKey', { id: old.id });
    expect(keyRegistry.lookup('agent@test')?.publicKey).toBe('pk-new');
  });

  it('renaming the old revoked row keeps the live key', async () => {
    const { call, keyRegistry, old } = await rotated();
    await call('updateKey', { id: old.id, name: 'retired' });
    expect(keyRegistry.lookup('agent@test')?.publicKey).toBe('pk-new');
  });
});
