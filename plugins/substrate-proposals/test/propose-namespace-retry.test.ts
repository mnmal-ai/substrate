/**
 * propose_namespace recovers from a failure part-way through: a retry
 * completes the install and the namespace becomes usable.
 *
 * Runs in two modes. `independent commits` gives the control namespace a
 * dataset whose transactions do not roll back, so the proposal row survives
 * the failure as an applied=false row; a different proposer is then still
 * refused. `rolled back` is the plain memory dataset, whose transaction
 * discards the row while the namespace stays installed, as pg does.
 */

import {
  Engine,
  loadPlugins,
  MemoryEdgesStore,
  type NamespaceConfig
} from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { Dataset, RequestContext } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { CONTROL_NAMESPACE } from '../src/control-plane.js';
import { createNoopPubSub, createProposalsPlugin } from '../src/index.js';

function makeCtx(kid = 'agent-1'): Partial<RequestContext> {
  return {
    identity: {
      id: kid,
      tokenId: kid,
      grants: { '*': ['substrate.propose', 'read', 'mutate'] }
    },
    now: new Date('2026-05-03T00:00:00Z'),
    headers: {},
    meta: {}
  };
}

function withoutRollback(ds: MemoryDataset): Dataset {
  return new Proxy(ds, {
    get(target, prop): unknown {
      if (prop === 'withScopedTransaction') return undefined;
      if (prop === 'withTransaction') {
        return <T>(fn: (tx: Dataset) => Promise<T>): Promise<T> => fn(target);
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  }) as Dataset;
}

async function bootEngine(
  independentCommits: boolean
): Promise<{ engine: Engine; datasets: MemoryDatasetRegistry }> {
  const datasets = new MemoryDatasetRegistry();
  const control = new MemoryDataset({ namespace: CONTROL_NAMESPACE });
  datasets.set(CONTROL_NAMESPACE, independentCommits ? withoutRollback(control) : control);
  const plugin = createProposalsPlugin({
    ownedNamespaces: [],
    pubsub: createNoopPubSub(),
    datasetFor: (ns: string): Dataset | undefined => datasets.get(ns)
  });
  const edges = new MemoryEdgesStore({ now: () => new Date('2026-05-03T00:00:00Z') });
  const loaded = await loadPlugins({
    plugins: [plugin],
    edges,
    datasetFor: (ns): Dataset | undefined => datasets.get(ns)
  });
  const namespaceMap = new Map<string, NamespaceConfig>();
  for (const [ns, cfg] of loaded.namespaces) namespaceMap.set(ns, cfg);
  const engine = new Engine({ namespaces: namespaceMap, datasets, edges });
  await loaded.runOnStart(engine);
  datasets.set('tenant-y', new MemoryDataset({ namespace: 'tenant-y' }));
  return { engine, datasets };
}

function proposeNs(engine: Engine, kid: string): Promise<unknown> {
  return engine.mutate({
    frame: {
      '_system_proposals/propose_namespace': {
        // The param names the original proposer; only the signed kid may resume.
        params: { ns: 'tenant-y', proposedBy: 'agent-1', proposedReason: 'retry' },
        fields: { id: true, applied: true }
      }
    },
    ctx: makeCtx(kid)
  });
}

async function proposalRows(
  datasets: MemoryDatasetRegistry
): Promise<Array<Record<string, unknown>>> {
  const ds = datasets.get(CONTROL_NAMESPACE);
  if (ds === undefined) throw new Error('no control dataset');
  return (await ds.read('NamespaceProposal', { limit: 10 })).rows as Array<Record<string, unknown>>;
}

async function expectUsable(engine: Engine): Promise<void> {
  const typeEnv = await engine.mutate({
    frame: {
      'tenant-y/propose_type': {
        params: {
          typeName: 'Note',
          fields: { body: { kind: 'scalar', type: 'string' } },
          proposedBy: 'home',
          proposedReason: 'usable'
        },
        fields: { id: true, applied: true }
      }
    },
    ctx: makeCtx()
  });
  expect(typeEnv.errors).toBeUndefined();
  const createEnv = await engine.mutate({
    frame: { 'tenant-y/createNote': { params: { body: 'hi' }, fields: { id: true } } },
    ctx: makeCtx()
  });
  expect(createEnv.errors).toBeUndefined();
}

describe.each([
  ['independent commits', true],
  ['rolled back', false]
])('propose_namespace retry after a partial failure (%s)', (_label, independentCommits) => {
  async function expectStranded(datasets: MemoryDatasetRegistry, engine: Engine): Promise<void> {
    // The failed attempt's transaction did not commit, so nothing serves the ns.
    expect(engine.registryFor('tenant-y')).toBeUndefined();
    const rows = await proposalRows(datasets);
    if (independentCommits) {
      expect(rows).toHaveLength(1);
      expect(rows[0]?.applied).toBe(false);
      await expect(proposeNs(engine, 'someone-else')).resolves.toMatchObject({
        errors: [expect.objectContaining({ code: 'namespace_already_proposed' })]
      });
    } else {
      expect(rows).toHaveLength(0);
    }
  }

  it('completes the install when a step after addNamespace threw', async () => {
    const { engine, datasets } = await bootEngine(independentCommits);

    const createRegistry = engine.createRegistry.bind(engine);
    let injected = false;
    engine.createRegistry = () => {
      const registry = createRegistry();
      const register = registry.register.bind(registry);
      registry.register = (key, input): void => {
        const name = typeof key === 'string' ? key : key.name;
        if (!injected && name === 'propose_type') {
          injected = true;
          throw new Error('injected install failure');
        }
        register(key, input);
      };
      return registry;
    };

    await expect(proposeNs(engine, 'home')).rejects.toThrow('injected install failure');
    await expectStranded(datasets, engine);

    const retry = (await proposeNs(engine, 'home')) as { errors?: unknown };
    expect(retry.errors).toBeUndefined();

    const rows = await proposalRows(datasets);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.applied).toBe(true);
    await expectUsable(engine);
  });

  it('marks the row applied when only the step-7 update failed', async () => {
    const { engine, datasets } = await bootEngine(independentCommits);

    const registry = engine.registryFor(CONTROL_NAMESPACE);
    const update = registry?.get('updateNamespaceProposal');
    if (registry === undefined || update === undefined) throw new Error('no update entry');
    let injected = false;
    registry.replace('updateNamespaceProposal', {
      ...update,
      resolver: (ctx, args) => {
        if (injected) return update.resolver(ctx, args);
        injected = true;
        return Promise.reject(new Error('injected update failure'));
      }
    });

    await expect(proposeNs(engine, 'home')).rejects.toThrow('injected update failure');
    await expectStranded(datasets, engine);

    const retry = (await proposeNs(engine, 'home')) as { errors?: unknown };
    expect(retry.errors).toBeUndefined();

    const rows = await proposalRows(datasets);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.applied).toBe(true);
    await expectUsable(engine);
  });
});
