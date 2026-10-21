/**
 * Concurrent propose_* calls for the same identity: exactly one applies, the
 * other gets the existing refusal (or the idempotent prior row for a matching
 * field spec), and no applied=false row is left behind.
 *
 * Runs twice: once on datasets exposing `withAdvisoryLock`, once on datasets
 * that hide it, which exercises the plugin's process-local fallback.
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

function makeCtx(): Partial<RequestContext> {
  return {
    identity: {
      id: 'agent-1',
      tokenId: 'agent-1',
      grants: { '*': ['substrate.propose', 'read', 'mutate'] }
    },
    now: new Date('2026-05-03T00:00:00Z'),
    headers: {},
    meta: {}
  };
}

function withoutAdvisoryLock(ds: MemoryDataset): Dataset {
  return new Proxy(ds, {
    get(target, prop): unknown {
      if (prop === 'withAdvisoryLock') return undefined;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  }) as Dataset;
}

async function bootEngine(hideLock: boolean): Promise<{
  engine: Engine;
  datasets: MemoryDatasetRegistry;
  makeDataset: (ns: string) => Dataset;
}> {
  const datasets = new MemoryDatasetRegistry();
  const makeDataset = (ns: string): Dataset => {
    const ds = new MemoryDataset({ namespace: ns });
    return hideLock ? withoutAdvisoryLock(ds) : ds;
  };
  datasets.set(CONTROL_NAMESPACE, makeDataset(CONTROL_NAMESPACE));
  datasets.set('app', makeDataset('app'));

  const plugin = createProposalsPlugin({
    ownedNamespaces: ['app'],
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
  return { engine, datasets, makeDataset };
}

function proposeType(engine: Engine, proposedBy: string): Promise<unknown> {
  return engine.mutate({
    frame: {
      'app/propose_type': {
        params: {
          typeName: 'Note',
          fields: { body: { kind: 'scalar', type: 'string' } },
          proposedBy,
          proposedReason: 'race'
        },
        fields: { id: true, applied: true }
      }
    },
    ctx: makeCtx()
  });
}

/** The refusal code a mutate envelope carries, or undefined when it applied. */
function errorCode(env: unknown): string | undefined {
  return (env as { errors?: Array<{ code?: string }> }).errors?.[0]?.code;
}

async function rowsOf(
  datasets: MemoryDatasetRegistry,
  ns: string,
  type: string
): Promise<Array<Record<string, unknown>>> {
  const ds = datasets.get(ns);
  if (ds === undefined) throw new Error(`no dataset for ${ns}`);
  return (await ds.read(type, { limit: 100 })).rows as Array<Record<string, unknown>>;
}

describe.each([
  ['dataset advisory lock', false],
  ['process-local fallback lock', true]
])('concurrent propose_* (%s)', (_label, hideLock) => {
  it('propose_type: one applies, the other is refused, no orphan row', async () => {
    const { engine, datasets } = await bootEngine(hideLock);

    const results = await Promise.all([proposeType(engine, 'a'), proposeType(engine, 'b')]);
    expect(results.map(errorCode).sort()).toEqual(['type_already_proposed', undefined]);

    const rows = await rowsOf(datasets, 'app', 'TypeProposal');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.applied).toBe(true);
  });

  it('propose_field: same spec twice yields one applied row and no orphan', async () => {
    const { engine, datasets } = await bootEngine(hideLock);
    await proposeType(engine, 'a');

    const proposeField = (): Promise<unknown> =>
      engine.mutate({
        frame: {
          'app/propose_field': {
            params: {
              targetType: 'Note',
              fieldName: 'tag',
              fieldSpec: { kind: 'scalar', type: 'string', nullable: true },
              proposedBy: 'a',
              proposedReason: 'race'
            },
            fields: { id: true, applied: true }
          }
        },
        ctx: makeCtx()
      });

    const results = await Promise.allSettled([proposeField(), proposeField()]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);

    const rows = await rowsOf(datasets, 'app', 'FieldProposal');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.applied).toBe(true);
  });

  it('propose_namespace: one applies, the other is refused, no orphan row', async () => {
    const { engine, datasets, makeDataset } = await bootEngine(hideLock);
    datasets.set('tenant-x', makeDataset('tenant-x'));

    const proposeNs = (proposedBy: string): Promise<unknown> =>
      engine.mutate({
        frame: {
          '_system_proposals/propose_namespace': {
            params: { ns: 'tenant-x', proposedBy, proposedReason: 'race' },
            fields: { id: true }
          }
        },
        ctx: makeCtx()
      });

    const results = await Promise.all([proposeNs('a'), proposeNs('b')]);
    expect(results.map(errorCode).sort()).toEqual(['namespace_already_proposed', undefined]);

    const rows = await rowsOf(datasets, CONTROL_NAMESPACE, 'NamespaceProposal');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.applied).toBe(true);
    expect(engine.registryFor('tenant-x')?.has('propose_type')).toBe(true);
  });
});
