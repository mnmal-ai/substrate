/**
 * Cluster-wide namespace fanout tests.
 *
 * Two Engine instances share a single LoopbackPubSub. When instance A
 * runs propose_namespace, the cluster NOTIFY must drive instance B to install
 * the new namespace into its own engine — without diverging from A's view.
 *
 * Mirrors the LoopbackPubSub pattern from multi-instance.test.ts so the
 * synchronous fan-out is observable before/after the mutate call returns.
 */

import {
  Engine,
  loadPlugins,
  MemoryEdgesStore,
  type NamespaceConfig
} from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { Dataset, RequestContext } from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
import type { PubSub } from '../src/config.js';
import { CONTROL_NAMESPACE } from '../src/control-plane.js';
import { createProposalsPlugin } from '../src/index.js';
import { CLUSTER_DROP_CHANNEL } from '../src/multi-instance.js';
import { CLUSTER_CHANNEL } from '../src/propose-namespace-resolver.js';

/** In-process PubSub: handlers are called synchronously in notify(). */
class LoopbackPubSub implements PubSub {
  private readonly handlers = new Map<string, Array<(payload: string) => void | Promise<void>>>();

  async listen(channel: string, handler: (payload: string) => void | Promise<void>): Promise<void> {
    const list = this.handlers.get(channel) ?? [];
    list.push(handler);
    this.handlers.set(channel, list);
  }

  async notify(channel: string, payload: string): Promise<void> {
    const list = this.handlers.get(channel) ?? [];
    for (const h of list) await h(payload);
  }
}

function makeCtx(overrides: Partial<RequestContext> = {}): Partial<RequestContext> {
  return {
    identity: {
      id: 'agent-1',
      tokenId: 'agent-1',
      grants: { '*': ['substrate.propose', 'read', 'mutate'] }
    },
    now: new Date('2026-05-03T00:00:00Z'),
    headers: {},
    meta: {},
    ...overrides
  };
}

async function buildEngine(pubsub: PubSub, datasets: MemoryDatasetRegistry): Promise<Engine> {
  datasets.set(CONTROL_NAMESPACE, new MemoryDataset({ namespace: CONTROL_NAMESPACE }));

  const plugin = createProposalsPlugin({
    ownedNamespaces: [],
    pubsub,
    datasetFor: (ns: string): Dataset | undefined => datasets.get(ns)
  });

  const edges = new MemoryEdgesStore({ now: () => new Date() });

  const loaded = await loadPlugins({
    plugins: [plugin],
    edges,
    datasetFor: (ns): Dataset | undefined => datasets.get(ns)
  });

  const namespaceMap = new Map<string, NamespaceConfig>();
  for (const [ns, cfg] of loaded.namespaces) {
    namespaceMap.set(ns, cfg);
  }

  const engine = new Engine({
    namespaces: namespaceMap,
    datasets,
    edges
  });

  await loaded.runOnStart(engine);
  return engine;
}

describe('multi-instance namespace fanout', () => {
  it('a propose_namespace on instance A adds the ns to instance B', async () => {
    const pubsub = new LoopbackPubSub();
    const datasetsA = new MemoryDatasetRegistry();
    const datasetsB = new MemoryDatasetRegistry();

    const engineA = await buildEngine(pubsub, datasetsA);
    const engineB = await buildEngine(pubsub, datasetsB);

    expect(engineA.registryFor('user-zoe')).toBeUndefined();
    expect(engineB.registryFor('user-zoe')).toBeUndefined();

    // Both hosts pre-provision the dataset for the new ns. (In production this
    // would be a shared pg substrate; in the test each instance has its own
    // MemoryDataset — what matters is that datasetFor() returns one.)
    datasetsA.set('user-zoe', new MemoryDataset({ namespace: 'user-zoe' }));
    datasetsB.set('user-zoe', new MemoryDataset({ namespace: 'user-zoe' }));

    const envelope = await engineA.mutate({
      frame: {
        '_system_proposals/propose_namespace': {
          params: { ns: 'user-zoe', proposedBy: 'home', proposedReason: 'invite' },
          fields: { id: true }
        }
      },
      ctx: makeCtx()
    });
    expect(envelope.errors).toBeUndefined();

    expect(engineA.registryFor('user-zoe')).toBeDefined();
    // The cluster listener on instance B should have picked up the NOTIFY and
    // installed the ns into its own engine.
    expect(engineB.registryFor('user-zoe')).toBeDefined();

    // Regression: `installHotAddedNamespace` must register the proposal
    // mutations, so propose_type works on cluster-installed nses, not just on
    // the proposing instance. Assert the wiring at instance B.
    const typeEnv = await engineB.mutate({
      frame: {
        'user-zoe/propose_type': {
          params: {
            typeName: 'PersonalNote',
            fields: { body: { kind: 'scalar', type: 'string' } },
            proposedBy: 'home',
            proposedReason: 'cluster-install propose_type smoke'
          },
          fields: { id: true, applied: true }
        }
      },
      ctx: makeCtx()
    });
    expect(typeEnv.errors).toBeUndefined();
    const typeResult = typeEnv.data['user-zoe/propose_type'] as Record<string, unknown>;
    expect(typeResult.applied).toBe(true);
    // PersonalNote landed on instance B's user-zoe registry, with autoCRUD
    // mutations generated alongside it.
    const userZoeOnB = engineB.registryFor('user-zoe');
    expect(userZoeOnB?.has('PersonalNote')).toBe(true);
    expect(userZoeOnB?.has('createPersonalNote')).toBe(true);
  });

  it('cluster listener is idempotent — duplicate notifies are no-ops', async () => {
    const pubsub = new LoopbackPubSub();
    const datasets = new MemoryDatasetRegistry();
    const engine = await buildEngine(pubsub, datasets);

    // Pre-add a ns directly via propose_namespace
    datasets.set('user-yvonne', new MemoryDataset({ namespace: 'user-yvonne' }));
    await engine.mutate({
      frame: {
        '_system_proposals/propose_namespace': {
          params: { ns: 'user-yvonne', proposedBy: 'home', proposedReason: 'first' },
          fields: { id: true }
        }
      },
      ctx: makeCtx()
    });
    expect(engine.registryFor('user-yvonne')).toBeDefined();

    // Now manually re-fire the cluster NOTIFY for the same ns. The handler
    // must not throw "namespace already registered" (engine.addNamespace's
    // collision semantics) — the listener's idempotency check should catch
    // it first.
    await expect(pubsub.notify(CLUSTER_CHANNEL, 'user-yvonne')).resolves.not.toThrow();

    // Engine state is unchanged.
    expect(engine.registryFor('user-yvonne')).toBeDefined();
  });

  // When a peer broadcasts a ns the local host can't see (datasetFor
  // returns undefined — typically a host misconfiguration), the listener must
  // skip silently AND emit `_system_proposals.cluster_skip_no_dataset` so
  // operators can detect the divergence. Throwing in a NOTIFY handler tears
  // down the LISTEN connection, so a metric is the only viable surface.
  it('emits cluster_skip_no_dataset metric when peer broadcasts a ns the host has no dataset for', async () => {
    const pubsub = new LoopbackPubSub();
    const datasets = new MemoryDatasetRegistry();
    const metricCalls: Array<{ name: string; payload?: unknown }> = [];

    datasets.set(CONTROL_NAMESPACE, new MemoryDataset({ namespace: CONTROL_NAMESPACE }));
    const plugin = createProposalsPlugin({
      ownedNamespaces: [],
      pubsub,
      datasetFor: (ns: string): Dataset | undefined => datasets.get(ns)
    });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const loaded = await loadPlugins({
      plugins: [plugin],
      edges,
      datasetFor: (ns): Dataset | undefined => datasets.get(ns),
      metric: (name, payload) => {
        metricCalls.push({ name, payload });
      }
    });
    const namespaceMap = new Map<string, NamespaceConfig>();
    for (const [ns, cfg] of loaded.namespaces) namespaceMap.set(ns, cfg);
    const engine = new Engine({ namespaces: namespaceMap, datasets, edges });
    await loaded.runOnStart(engine);

    // Peer broadcasts a ns we don't have a dataset for — datasets.get returns
    // undefined for 'user-from-peer-only'.
    await pubsub.notify(CLUSTER_CHANNEL, 'user-from-peer-only');

    expect(engine.registryFor('user-from-peer-only')).toBeUndefined();
    const skipMetric = metricCalls.find(
      (m) => m.name === '_system_proposals.cluster_skip_no_dataset'
    );
    expect(skipMetric).toBeDefined();
    expect(skipMetric?.payload).toEqual({ ns: 'user-from-peer-only' });
  });

  it('a drop on instance A takes the ns off B; a drop message with a standing proposal is ignored', async () => {
    const pubsub = new LoopbackPubSub();
    const datasetsA = new MemoryDatasetRegistry();
    const datasetsB = new MemoryDatasetRegistry();
    const engineA = await buildEngine(pubsub, datasetsA);
    const engineB = await buildEngine(pubsub, datasetsB);
    for (const ds of [datasetsA, datasetsB]) {
      ds.set('user-kim', new MemoryDataset({ namespace: 'user-kim' }));
    }
    const env = await engineA.mutate({
      frame: {
        '_system_proposals/propose_namespace': {
          params: { ns: 'user-kim', proposedReason: 'invite' },
          fields: { id: true }
        }
      },
      ctx: makeCtx()
    });
    expect(env.errors).toBeUndefined();
    expect(engineB.namespaceState('user-kim')).toBe('live');

    // A forged drop message: A still has its standing proposal row, so A keeps it.
    await pubsub.notify(CLUSTER_DROP_CHANNEL, 'user-kim');
    expect(engineA.namespaceState('user-kim')).toBe('live');

    engineA.tombstoneNamespace('user-kim');
    await vi.waitFor(() => expect(engineA.namespaceState('user-kim')).toBe('absent'));
    expect(engineB.namespaceState('user-kim')).toBe('absent');
  });
});
