/**
 * A redeemed invite becomes a key row, and `createInvite` / `updateInvite`
 * are reachable through plain `mutate` as well as `POST /_system/invites`.
 * So the grant checks that route runs hold in the interceptors too: a grant
 * must parse, and one that confers admin needs `allowAdmin: true`.
 */

import { MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { RequestContext, ResolverArgs } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { installSystemNamespace } from '../../src/_system/install.js';
import { INVITE_TYPE, SYSTEM_NAMESPACE } from '../../src/_system/types.js';

const CTX = {
  identity: {
    kind: 'agent',
    id: 'admin@test',
    agentKeyId: 'admin@test',
    kid: 'admin@test',
    grants: { '*': ['read', 'mutate', 'admin'] },
    capabilities: ['admin'],
    namespaces: ['*']
  },
  now: new Date()
} as unknown as RequestContext;

async function setup() {
  const store = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
  const registry = new Registry();
  await installSystemNamespace({
    registry,
    dataset: store,
    edges: new MemoryEdgesStore({ now: () => new Date() })
  });
  const call = (op: string, params: Record<string, unknown>) =>
    registry.get(op)?.resolver(CTX, { params, dataset: store } as unknown as ResolverArgs);
  const create = (id: string, overrides: Record<string, unknown> = {}) =>
    call('createInvite', {
      id,
      namespaces: 'notes',
      capabilities: 'read',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...overrides
    });
  const stored = async (id: string) => (await store.read(INVITE_TYPE, { id })).rows[0];
  return { call, create, stored };
}

describe('_system invite interceptors — grant checks', () => {
  it('createInvite refuses a grant that will not parse, and writes nothing', async () => {
    const { create, stored } = await setup();
    await expect(create('inv-bad', { namespaces: 'notes:' })).rejects.toMatchObject({
      code: 'invalid_grant_entry'
    });
    expect(await stored('inv-bad')).toBeUndefined();
  });

  it('createInvite refuses an admin grant without allowAdmin, and takes it with', async () => {
    const { create, stored } = await setup();
    await expect(create('inv-admin', { namespaces: '_system:admin' })).rejects.toMatchObject({
      code: 'admin_requires_opt_in'
    });
    expect(await stored('inv-admin')).toBeUndefined();

    await create('inv-admin', { namespaces: '_system:admin', allowAdmin: true });
    const row = await stored('inv-admin');
    expect(row?.namespaces).toBe('_system:admin');
    expect(row).not.toHaveProperty('allowAdmin');
  });

  it('updateInvite checks the grant it would leave, and only when the grant changes', async () => {
    const { call, create, stored } = await setup();
    await create('inv-u');
    await expect(call('updateInvite', { id: 'inv-u', namespaces: 'notes:' })).rejects.toMatchObject(
      { code: 'invalid_grant_entry' }
    );
    await expect(
      call('updateInvite', { id: 'inv-u', capabilities: 'read,admin' })
    ).rejects.toMatchObject({ code: 'admin_requires_opt_in' });
    expect((await stored('inv-u'))?.capabilities).toBe('read');

    await call('updateInvite', { id: 'inv-u', capabilities: 'read,admin', allowAdmin: true });
    expect((await stored('inv-u'))?.capabilities).toBe('read,admin');
    await call('updateInvite', { id: 'inv-u', consumedBy: 'kid-x' });
    expect((await stored('inv-u'))?.consumedBy).toBe('kid-x');
  });

  it('refuses updateManyInvite: a write by filter would skip the updateInvite check', async () => {
    const { call, create } = await setup();
    await create('inv-m');
    await expect(
      call('updateManyInvite', { where: { id: { eq: 'inv-m' } }, set: { namespaces: 'notes:' } })
    ).rejects.toMatchObject({ code: 'capability_unsupported' });
  });
});
