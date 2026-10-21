/**
 * The `_system` key interceptors must not depend on a READ.
 *
 * The `createKey` / `updateKey` wrapper runs INSIDE the writing
 * transaction, so a re-read cannot see its own uncommitted write: on create it
 * finds nothing and evicts the new key; on update it finds the STALE
 * pre-update row and re-caches a revoked key as live.
 *
 * Resolvers write through the real store while the registry reads a view that
 * sees only what has committed. An end-to-end test cannot reproduce this,
 * because `MemoryDataset` does not model pg's transaction visibility.
 */

import { MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { Dataset, RequestContext, ResolverArgs, Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { installSystemNamespace } from '../../src/_system/install.js';
import { SYSTEM_NAMESPACE } from '../../src/_system/types.js';

const KID = 'agent@vanilla';

const CTX: RequestContext = {
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

/**
 * The PLAIN (non-transactional) handle the registry is built with at
 * `installSystemNamespace`. On postgres it sees only what has COMMITTED, so it cannot
 * see the in-flight write the interceptor is reacting to. `snapshot` is that
 * committed view, and the test drives it explicitly.
 */
function committedView(backing: Dataset, snapshot: { rows: Array<Row> }): Dataset {
  return new Proxy(backing, {
    get(target, prop, receiver) {
      if (prop === 'read') return async () => ({ rows: snapshot.rows });
      return Reflect.get(target, prop, receiver);
    }
  }) as Dataset;
}

async function installed(): Promise<{
  store: Dataset;
  snapshot: { rows: Array<Row> };
  registry: Registry;
  keyRegistry: Awaited<ReturnType<typeof installSystemNamespace>>['keyRegistry'];
}> {
  // The real store. Resolvers write and read through this as `args.dataset`,
  // exactly as the engine hands it to them inside a transaction.
  const store = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
  // What has COMMITTED, from the registry's point of view. Starts empty.
  const snapshot = { rows: [] as Array<Row> };
  const registry = new Registry();
  const { keyRegistry } = await installSystemNamespace({
    registry,
    dataset: committedView(store, snapshot),
    edges: new MemoryEdgesStore({ now: () => new Date() })
  });
  return { store, snapshot, registry, keyRegistry };
}

function keyParams(overrides: Record<string, unknown> = {}): Row {
  return {
    kid: KID,
    name: 'agent',
    algorithm: 'EdDSA',
    publicKey: 'pk-write-through',
    namespaces: 'probe',
    capabilities: 'read,mutate',
    revokedAt: null,
    ...overrides
  } as unknown as Row;
}

describe('_system key interceptors — write-through must not re-read', () => {
  it('createKey caches the new key while the committed view still shows nothing', async () => {
    const { store, registry, keyRegistry } = await installed();
    const entry = registry.get('createKey');
    expect(entry).toBeDefined();

    await entry?.resolver(CTX, {
      params: keyParams(),
      // The projection the admin register route asks for. It narrows the
      // response ENVELOPE, never the resolver's return value.
      fields: { id: true, kid: true },
      dataset: store
    } as unknown as ResolverArgs);

    // Snapshot is still empty: the insert has not committed. A re-reading
    // implementation gets rows=0 here and evicts the key it just created.
    const found = keyRegistry.lookup(KID);
    expect(found).not.toBeNull();
    expect(found?.publicKey).toBe('pk-write-through');
    expect(found?.capabilities).toEqual(['read', 'mutate']);
  });

  it('updateKey stops a revoked key resolving at once (the fail-OPEN half)', async () => {
    const { store, snapshot, registry, keyRegistry } = await installed();

    const created = (await registry.get('createKey')?.resolver(CTX, {
      params: keyParams(),
      dataset: store
    } as unknown as ResolverArgs)) as Row;
    expect(keyRegistry.lookup(KID)).not.toBeNull();

    // That create commits. The registry's committed view now shows the key as
    // LIVE — which is the state a re-read would find during the revoke below.
    snapshot.rows = [created];

    await registry.get('updateKey')?.resolver(CTX, {
      params: { id: created.id, revokedAt: new Date(Date.now() - 1000).toISOString() },
      // Same shape the revoke frame uses — again, envelope only.
      fields: { id: true, kid: true, revokedAt: true },
      dataset: store
    } as unknown as ResolverArgs);

    // The fail-OPEN direction. A re-reading implementation gets the STALE
    // pre-update row with revokedAt null and re-caches it as live. The
    // empty-read guard cannot help here: this read is not empty.
    expect(keyRegistry.lookup(KID)).toBeNull();
  });
});
