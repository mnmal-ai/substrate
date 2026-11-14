/**
 * A mutate array under one op-key calls the entry's `batch` resolver when it
 * has one. `_system`'s interceptors wrap only `resolver`, so a wrapped entry
 * that kept autoCRUD's `batch` let an array skip them (#1953): no
 * `invite_created` audit row, no key-cache write-through.
 */

import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { RequestContext } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { installSystemNamespace } from '../../src/_system/install.js';
import { AUDIT_EVENT_TYPE, SYSTEM_NAMESPACE } from '../../src/_system/types.js';

const NOW = (): Date => new Date('2026-11-01T00:00:00Z');
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
  now: NOW(),
  headers: {},
  meta: {}
} as unknown as Partial<RequestContext>;

async function setup() {
  const dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
  const registry = new Registry();
  const edges = new MemoryEdgesStore({ now: NOW });
  const { keyRegistry } = await installSystemNamespace({ registry, dataset, edges });
  const datasets = new MemoryDatasetRegistry();
  datasets.set(SYSTEM_NAMESPACE, dataset);
  const engine = new Engine({
    namespaces: new Map<string, NamespaceConfig>([[SYSTEM_NAMESPACE, { registry }]]),
    datasets,
    edges
  });
  return { engine, dataset, keyRegistry, registry };
}

describe('_system interceptors on a mutate array (#1953)', () => {
  it('wrapped entries carry no batch resolver', async () => {
    const { registry } = await setup();
    for (const op of ['createKey', 'updateKey', 'deleteKey', 'createInvite']) {
      expect(registry.get(op)?.batch, op).toBeUndefined();
    }
  });

  it('createInvite array writes one invite_created audit row per element', async () => {
    const { engine, dataset } = await setup();
    const expiresAt = new Date(NOW().getTime() + 86_400_000).toISOString();
    const invite = (id: string) => ({
      params: { id, namespaces: '*', capabilities: 'read', expiresAt },
      fields: { id: true }
    });
    const env = await engine.mutate({
      frame: { [`${SYSTEM_NAMESPACE}/createInvite`]: [invite('inv-a'), invite('inv-b')] },
      ctx: CTX
    });
    expect(env.errors ?? []).toEqual([]);
    const audits = (await dataset.read(AUDIT_EVENT_TYPE, {})).rows.filter(
      (r) => r.kind === 'invite_created'
    );
    expect(audits.map((r) => r.targetKid).sort()).toEqual(['inv-a', 'inv-b']);
  });

  it('createKey array installs every key in the registry cache', async () => {
    const { engine, keyRegistry } = await setup();
    const key = (kid: string) => ({
      params: {
        kid,
        name: kid,
        algorithm: 'EdDSA',
        publicKey: `pk-${kid}`,
        namespaces: '*',
        capabilities: 'read,mutate,admin',
        revokedAt: null
      },
      fields: { id: true }
    });
    const env = await engine.mutate({
      frame: { [`${SYSTEM_NAMESPACE}/createKey`]: [key('a@test'), key('b@test')] },
      ctx: CTX
    });
    expect(env.errors ?? []).toEqual([]);
    expect(keyRegistry.lookup('a@test')).not.toBeNull();
    expect(keyRegistry.lookup('b@test')).not.toBeNull();
  });
});
