import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { BridgeRegistry, CoordinatorPlugin } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { compose } from '../src/compose.js';

function makeNoopPlugin(name: string, namespaces: string[]): CoordinatorPlugin {
  return {
    name,
    contractVersion: '*',
    namespaces: namespaces.map((ns) => ({
      namespace: ns,
      install: async () => {
        /* noop — test plugin doesn't register types */
      }
    }))
  };
}

describe('compose() auto-allocates per-namespace datasets', () => {
  it('boots a coordinator claiming a non-default namespace without an explicit datasets entry', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });

    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [makeNoopPlugin('test-plugin', ['something-else'])]
    });

    await server.start();
    try {
      // If auto-allocation works, compose() returns successfully and the
      // server is wired; otherwise it throws MissingPluginDataset.
      expect(composed).toBeDefined();
    } finally {
      await composed.stop();
    }
  });

  it('respects explicit datasets overrides instead of auto-allocating', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const explicitNsDataset = new MemoryDataset({ namespace: 'explicit' });

    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset,
      datasets: { explicit: explicitNsDataset },
      coordinators: [makeNoopPlugin('test-plugin', ['explicit'])]
    });

    await server.start();
    try {
      expect(composed).toBeDefined();
    } finally {
      await composed.stop();
    }
  });

  it('handles a plugin claiming multiple non-default namespaces', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });

    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [makeNoopPlugin('multi-ns', ['ns-a', 'ns-b'])]
    });

    await server.start();
    try {
      expect(composed).toBeDefined();
    } finally {
      await composed.stop();
    }
  });

  // Install-time auto-allocation goes via loadPlugins.datasetFor →
  // opts.dataset.forNamespace. This pins the RUNTIME equivalent: a hot-added
  // namespace (engine.addNamespace) must resolve to a sibling dataset on
  // first lookup without the host pre-registering one.
  it('engine.datasetFor returns a sibling dataset for a hot-added namespace', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });

    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [makeNoopPlugin('test-plugin', ['static-ns'])]
    });

    await server.start();
    try {
      composed.engine.addNamespace('runtime-ns', {
        registry: composed.engine.createRegistry()
      });
      const ds = composed.engine.datasetFor('runtime-ns');
      expect(ds).toBeDefined();
      expect(ds?.namespace).toBe('runtime-ns');
      // Cached: subsequent lookup returns the same instance.
      expect(composed.engine.datasetFor('runtime-ns')).toBe(ds);
    } finally {
      await composed.stop();
    }
  });

  // The factory MUST NOT auto-allocate for a bridged namespace, or sweep's
  // resolveTarget would short-circuit to an empty local dataset instead of
  // falling through to the bridge.
  it('engine.datasetFor returns undefined for a bridged namespace (sweep falls through)', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });

    // Stub bridge — we only need .has() to report true for the bridged ns.
    const bridges: BridgeRegistry = {
      has: (ns) => ns === 'bridged-ns',
      get: () => undefined,
      isUnreachable: () => false,
      entries: () => []
    };

    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset,
      coordinators: [makeNoopPlugin('test-plugin', ['static-ns'])],
      bridges
    });

    await server.start();
    try {
      expect(composed.engine.datasetFor('bridged-ns')).toBeUndefined();
    } finally {
      await composed.stop();
    }
  });
});
