import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type {
  CoordinatorPlugin,
  Dataset,
  EdgesStore,
  EngineHandle,
  EngineInput,
  KernelPlugin,
  NamespaceConfig,
  NamespaceDefinition,
  NamespaceInstallContext,
  PackEnvelope,
  PostWriteHook,
  Registry,
  Row
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import {
  loadPlugins,
  MemoryEdgesStore,
  PluginNamespaceCollision,
  type Resolver
} from '../src/index.js';
import { MissingPluginDataset } from '../src/load-plugins.js';

function stubEngine(): EngineHandle {
  const empty = async (_input: EngineInput): Promise<PackEnvelope> => ({
    schemaVersion: 'test',
    data: {},
    shapes: {}
  });
  return {
    query: empty,
    mutate: empty,
    invalidateSchemaCaches: (): void => {},
    addNamespace: (_ns: string, _config: NamespaceConfig): void => {
      throw new Error('test fake: addNamespace not supported');
    },
    tombstoneNamespace: (_ns: string): void => {},
    removeNamespace: () => {},
    namespaceState: () => 'absent' as const,
    onNamespaceTombstoned: () => () => {},
    addDropParticipant: () => () => {},
    dropParticipants: () => [],
    evaluateReadPolicy: () => ({ allow: true }),
    createRegistry: (): Registry => {
      throw new Error('test fake: createRegistry not supported');
    },
    datasetFor: (_ns: string): Dataset | undefined => undefined
  };
}

function makeEdges(): EdgesStore {
  return new MemoryEdgesStore({ now: () => new Date('2026-04-19T00:00:00Z') });
}

function makeDataset(namespace: string): MemoryDataset {
  return new MemoryDataset({ namespace });
}

const noopResolver: Resolver = async (): Promise<Row[]> => [];

function simplePlugin(
  name: string,
  namespaces: Array<{
    namespace: string;
    install?: (ctx: NamespaceInstallContext) => void | Promise<void>;
    typeName?: string;
  }>,
  onStart?: CoordinatorPlugin['onStart']
): CoordinatorPlugin {
  const base: CoordinatorPlugin = {
    name,
    contractVersion: '*',
    namespaces: namespaces.map((n) => ({
      namespace: n.namespace,
      install:
        n.install ??
        ((ctx): void => {
          ctx.registry.register(n.typeName ?? 'Todo', { resolver: noopResolver });
        })
    }))
  };
  if (onStart !== undefined) base.onStart = onStart;
  return base;
}

describe('loadPlugins', () => {
  it('installs a single-namespace plugin and returns its registry + dataset', async () => {
    const dataset = makeDataset('default');
    const edges = makeEdges();
    const installCalls: Array<{ ns: string }> = [];

    const plugin = simplePlugin('demo', [
      {
        namespace: 'default',
        install: (ctx): void => {
          installCalls.push({ ns: ctx.dataset.namespace });
          ctx.registry.register('Todo', { resolver: noopResolver });
        }
      }
    ]);

    const loaded = await loadPlugins({
      plugins: [plugin],
      edges,
      datasetFor: (ns): Dataset | undefined => (ns === 'default' ? dataset : undefined)
    });

    expect(installCalls).toEqual([{ ns: 'default' }]);
    expect(loaded.namespaces.size).toBe(1);
    expect(loaded.datasets.get('default')).toBe(dataset);
    const cfg = loaded.namespaces.get('default');
    expect(cfg).toBeDefined();
    expect(cfg?.registry.has('Todo')).toBe(true);
  });

  it('handles a plugin that contributes multiple namespaces', async () => {
    const prices = makeDataset('prices');
    const products = makeDataset('products');
    const edges = makeEdges();

    const plugin = simplePlugin('catalog', [
      { namespace: 'prices', typeName: 'Price' },
      { namespace: 'products', typeName: 'Product' }
    ]);

    const loaded = await loadPlugins({
      plugins: [plugin],
      edges,
      datasetFor: (ns): Dataset | undefined => {
        if (ns === 'prices') return prices;
        if (ns === 'products') return products;
        return undefined;
      }
    });

    expect(loaded.namespaces.size).toBe(2);
    const pricesCfg = loaded.namespaces.get('prices');
    const productsCfg = loaded.namespaces.get('products');
    expect(pricesCfg).toBeDefined();
    expect(productsCfg).toBeDefined();
    expect(pricesCfg).not.toBe(productsCfg);
    expect(pricesCfg?.registry.has('Price')).toBe(true);
    expect(pricesCfg?.registry.has('Product')).toBe(false);
    expect(productsCfg?.registry.has('Product')).toBe(true);
    expect(productsCfg?.registry.has('Price')).toBe(false);
  });

  it('throws PluginNamespaceCollision when two plugins claim the same namespace', async () => {
    const dataset = makeDataset('default');
    const edges = makeEdges();

    const first = simplePlugin('a', [{ namespace: 'default' }]);
    const second = simplePlugin('b', [{ namespace: 'default' }]);

    await expect(
      loadPlugins({
        plugins: [first, second],
        edges,
        datasetFor: (): Dataset | undefined => dataset
      })
    ).rejects.toBeInstanceOf(PluginNamespaceCollision);
  });

  it('throws MissingPluginDataset when no dataset resolves for a claimed namespace', async () => {
    const edges = makeEdges();
    const plugin = simplePlugin('orphans', [{ namespace: 'orphans' }]);

    await expect(
      loadPlugins({
        plugins: [plugin],
        edges,
        datasetFor: (): Dataset | undefined => undefined
      })
    ).rejects.toBeInstanceOf(MissingPluginDataset);
  });

  it('runOnStart invokes every plugin hook in registration order', async () => {
    const dataset = makeDataset('default');
    const edges = makeEdges();
    const order: string[] = [];

    const first: CoordinatorPlugin = {
      name: 'first',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'a',
          install: (ctx): void => {
            ctx.registry.register('A', { resolver: noopResolver });
          }
        }
      ],
      onStart: async (): Promise<void> => {
        order.push('first');
      }
    };

    const second: CoordinatorPlugin = {
      name: 'second',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'b',
          install: (ctx): void => {
            ctx.registry.register('B', { resolver: noopResolver });
          }
        }
      ],
      onStart: (ctx): void => {
        order.push('second');
        ctx.metric('ready', { plugin: 'second' });
      }
    };

    const metricCalls: Array<{ name: string; payload: unknown }> = [];
    const loaded = await loadPlugins({
      plugins: [first, second],
      edges,
      datasetFor: (): Dataset | undefined => dataset,
      metric: (name, payload): void => {
        metricCalls.push({ name, payload });
      }
    });

    await loaded.runOnStart(stubEngine());
    expect(order).toEqual(['first', 'second']);
    expect(metricCalls).toEqual([{ name: 'ready', payload: { plugin: 'second' } }]);
  });

  it('runOnStop fires hooks in REVERSE registration order', async () => {
    const dataset = makeDataset('default');
    const edges = makeEdges();
    const order: string[] = [];

    const first: CoordinatorPlugin = {
      name: 'first',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'a',
          install: (ctx): void => {
            ctx.registry.register('A', { resolver: noopResolver });
          }
        }
      ],
      onStop: async (): Promise<void> => {
        order.push('first');
      }
    };
    const second: CoordinatorPlugin = {
      name: 'second',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'b',
          install: (ctx): void => {
            ctx.registry.register('B', { resolver: noopResolver });
          }
        }
      ],
      onStop: async (): Promise<void> => {
        order.push('second');
      }
    };

    const loaded = await loadPlugins({
      plugins: [first, second],
      edges,
      datasetFor: (): Dataset | undefined => dataset
    });
    await loaded.runOnStop(stubEngine());
    // Reverse registration → second tears down first, then first.
    expect(order).toEqual(['second', 'first']);
  });

  it('runOnStop catches per-plugin errors and continues — one bad teardown does not block the rest', async () => {
    const dataset = makeDataset('default');
    const edges = makeEdges();
    const torn: string[] = [];

    const ok: CoordinatorPlugin = {
      name: 'ok',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'a',
          install: (ctx): void => {
            ctx.registry.register('A', { resolver: noopResolver });
          }
        }
      ],
      onStop: async (): Promise<void> => {
        torn.push('ok');
      }
    };
    const bad: CoordinatorPlugin = {
      name: 'bad',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'b',
          install: (ctx): void => {
            ctx.registry.register('B', { resolver: noopResolver });
          }
        }
      ],
      onStop: async (): Promise<void> => {
        throw new Error('teardown boom');
      }
    };

    const metricCalls: Array<{ name: string; payload: unknown }> = [];
    const loaded = await loadPlugins({
      plugins: [ok, bad],
      edges,
      datasetFor: (): Dataset | undefined => dataset,
      metric: (name, payload): void => {
        metricCalls.push({ name, payload });
      }
    });
    // Should NOT throw — the bad plugin's error is caught + logged.
    await expect(loaded.runOnStop(stubEngine())).resolves.toBeUndefined();
    // The other plugin's onStop still ran.
    expect(torn).toEqual(['ok']);
    // The error was reported via the metric sink under a known event name.
    const errorEvents = metricCalls.filter((c) => c.name === 'plugin_on_stop_error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]?.payload).toMatchObject({
      plugin: 'bad',
      message: 'teardown boom'
    });
  });

  it('runOnStop is a no-op when no plugins declare onStop', async () => {
    const dataset = makeDataset('default');
    const edges = makeEdges();
    const loaded = await loadPlugins({
      plugins: [simplePlugin('p', [{ namespace: 'a', typeName: 'A' }])],
      edges,
      datasetFor: (): Dataset | undefined => dataset
    });
    // Plugins exist but none declared onStop — runOnStop resolves cleanly.
    await expect(loaded.runOnStop(stubEngine())).resolves.toBeUndefined();
  });

  it('awaits async install() before moving on', async () => {
    const dataset = makeDataset('default');
    const edges = makeEdges();
    const order: string[] = [];

    const plugin: CoordinatorPlugin = {
      name: 'async',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'default',
          install: async (ctx): Promise<void> => {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 5);
              timer.unref?.();
            });
            order.push('install');
            ctx.registry.register('Slow', { resolver: noopResolver });
          }
        }
      ]
    };

    const loaded = await loadPlugins({
      plugins: [plugin],
      edges,
      datasetFor: (): Dataset | undefined => dataset
    });

    expect(order).toEqual(['install']);
    expect(loaded.namespaces.get('default')?.registry.has('Slow')).toBe(true);
  });
});

describe('loadPlugins — plugin-global policy threading', () => {
  it('composes plugin.policies via and() and threads as pluginPolicy into NamespaceInstallContext', async () => {
    const dataset = makeDataset('default');
    const edges = makeEdges();
    let seenPluginPolicy: ((ctx: never, args: never) => unknown) | undefined;

    const policyA = (): { allow: boolean } => ({ allow: true });
    const policyB = (): { allow: boolean } => ({ allow: true });

    const plugin: CoordinatorPlugin = {
      name: 'with-policies',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'default',
          install: (ctx): void => {
            seenPluginPolicy = ctx.pluginPolicy;
            ctx.registry.register('Todo', { resolver: noopResolver });
          }
        }
      ],
      policies: [policyA, policyB]
    };

    await loadPlugins({
      plugins: [plugin],
      edges,
      datasetFor: (): Dataset | undefined => dataset
    });

    expect(seenPluginPolicy).toBeDefined();
    // Invoke the composed policy — both layers allow, so the combined allows.
    const decision = seenPluginPolicy?.({} as never, {} as never) as { allow: boolean };
    expect(decision.allow).toBe(true);
  });

  it('short-circuits on first deny — plugin-global composition honours and() semantics', async () => {
    const dataset = makeDataset('default');
    const edges = makeEdges();
    let seenPluginPolicy: ((ctx: never, args: never) => unknown) | undefined;

    const allow = (): { allow: boolean } => ({ allow: true });
    const deny = (): { allow: boolean; reason: string } => ({
      allow: false,
      reason: 'plugin policy denied'
    });

    const plugin: CoordinatorPlugin = {
      name: 'deny-plugin',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'default',
          install: (ctx): void => {
            seenPluginPolicy = ctx.pluginPolicy;
            ctx.registry.register('Todo', { resolver: noopResolver });
          }
        }
      ],
      policies: [allow, deny]
    };

    await loadPlugins({
      plugins: [plugin],
      edges,
      datasetFor: (): Dataset | undefined => dataset
    });

    expect(seenPluginPolicy).toBeDefined();
    const decision = seenPluginPolicy?.({} as never, {} as never) as {
      allow: boolean;
      reason?: string;
    };
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('plugin policy denied');
  });

  it('omits pluginPolicy when plugin.policies is undefined', async () => {
    const dataset = makeDataset('default');
    const edges = makeEdges();
    let seenPluginPolicy: unknown = 'unset-sentinel';

    const plugin = simplePlugin('no-policies', [
      {
        namespace: 'default',
        install: (ctx): void => {
          seenPluginPolicy = ctx.pluginPolicy;
        }
      }
    ]);

    await loadPlugins({
      plugins: [plugin],
      edges,
      datasetFor: (): Dataset | undefined => dataset
    });

    expect(seenPluginPolicy).toBeUndefined();
  });

  it('omits pluginPolicy when plugin.policies is an empty array', async () => {
    const dataset = makeDataset('default');
    const edges = makeEdges();
    let seenPluginPolicy: unknown = 'unset-sentinel';

    const plugin: CoordinatorPlugin = {
      name: 'empty-policies',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'default',
          install: (ctx): void => {
            seenPluginPolicy = ctx.pluginPolicy;
          }
        }
      ],
      policies: []
    };

    await loadPlugins({
      plugins: [plugin],
      edges,
      datasetFor: (): Dataset | undefined => dataset
    });

    expect(seenPluginPolicy).toBeUndefined();
  });
});

describe('loadPlugins — kernel contributePostWrites walk', () => {
  it('merges kernel contributions into postWriteContributions before install', async () => {
    const dataset = makeDataset('memory');
    const edges = makeEdges();
    let seenContributions: Record<string, PostWriteHook[]> | undefined;

    // Fake PostWriteHook that records calls via side-effect counter.
    let hookCallCount = 0;
    const fakeHook: PostWriteHook = async (_row: Row): Promise<void> => {
      hookCallCount++;
    };

    // Substrate plugin that contributes fakeHook for the 'Memory' type.
    const kernelPlugin: KernelPlugin = {
      name: 'fake-recall',
      contractVersion: '*',
      contributePostWrites: (ns: NamespaceDefinition): Record<string, PostWriteHook> => {
        // Only contribute for namespaces that have a 'Memory' type with embed.
        if (ns.types?.Memory?.embed !== undefined) {
          return { Memory: fakeHook };
        }
        return {};
      }
    };

    // Coordinator plugin with a namespace declaring Memory with embed.source.
    const coordinatorPlugin: CoordinatorPlugin = {
      name: 'fake-coordinator',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'memory',
          types: {
            Memory: {
              fields: { body: { kind: 'scalar', type: 'string' } },
              embed: { source: (row: Row): string => String(row.body ?? '') }
            }
          },
          install: (ctx: NamespaceInstallContext): void => {
            seenContributions = ctx.postWriteContributions;
            ctx.registry.register('Memory', { resolver: noopResolver });
          }
        }
      ]
    };

    await loadPlugins({
      plugins: [coordinatorPlugin],
      kernelPlugins: [kernelPlugin],
      edges,
      datasetFor: (): Dataset | undefined => dataset
    });

    // The install context should have received the substrate's contribution.
    expect(seenContributions).toBeDefined();
    if (seenContributions === undefined) return; // narrow for TS
    expect(seenContributions.Memory).toHaveLength(1);
    expect(seenContributions.Memory?.[0]).toBe(fakeHook);
    // hookCallCount is 0 — hooks are contributed, not yet called (install only wires).
    expect(hookCallCount).toBe(0);
  });

  it('stacks contributions from multiple kernel plugins in composition order', async () => {
    const dataset = makeDataset('ns');
    const edges = makeEdges();
    let seenContributions: Record<string, PostWriteHook[]> | undefined;

    const hookA: PostWriteHook = async (): Promise<void> => {};
    const hookB: PostWriteHook = async (): Promise<void> => {};

    const subA: KernelPlugin = {
      name: 'substrate-a',
      contractVersion: '*',
      contributePostWrites: (): Record<string, PostWriteHook> => ({ Widget: hookA })
    };
    const subB: KernelPlugin = {
      name: 'substrate-b',
      contractVersion: '*',
      contributePostWrites: (): Record<string, PostWriteHook> => ({ Widget: hookB })
    };

    const coordinator: CoordinatorPlugin = {
      name: 'multi-sub-coordinator',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'ns',
          install: (ctx: NamespaceInstallContext): void => {
            seenContributions = ctx.postWriteContributions;
            ctx.registry.register('Widget', { resolver: noopResolver });
          }
        }
      ]
    };

    await loadPlugins({
      plugins: [coordinator],
      kernelPlugins: [subA, subB],
      edges,
      datasetFor: (): Dataset | undefined => dataset
    });

    // Both hooks stacked in substrate composition order.
    expect(seenContributions).toBeDefined();
    if (seenContributions === undefined) return; // narrow for TS
    expect(seenContributions.Widget).toHaveLength(2);
    expect(seenContributions.Widget?.[0]).toBe(hookA);
    expect(seenContributions.Widget?.[1]).toBe(hookB);
  });

  it('omits postWriteContributions when no kernel defines contributePostWrites', async () => {
    const dataset = makeDataset('plain');
    const edges = makeEdges();
    let seenContributions: unknown = 'unset-sentinel';

    // Substrate without contributePostWrites.
    const subNoHooks: KernelPlugin = {
      name: 'substrate-no-hooks',
      contractVersion: '*'
    };

    const coordinator: CoordinatorPlugin = {
      name: 'plain-coordinator',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'plain',
          install: (ctx: NamespaceInstallContext): void => {
            seenContributions = ctx.postWriteContributions;
            ctx.registry.register('Item', { resolver: noopResolver });
          }
        }
      ]
    };

    await loadPlugins({
      plugins: [coordinator],
      kernelPlugins: [subNoHooks],
      edges,
      datasetFor: (): Dataset | undefined => dataset
    });

    expect(seenContributions).toBeUndefined();
  });

  it('omits postWriteContributions when kernel plugins list is empty', async () => {
    const dataset = makeDataset('empty');
    const edges = makeEdges();
    let seenContributions: unknown = 'unset-sentinel';

    const coordinator: CoordinatorPlugin = {
      name: 'empty-substrates-coordinator',
      contractVersion: '*',
      namespaces: [
        {
          namespace: 'empty',
          install: (ctx: NamespaceInstallContext): void => {
            seenContributions = ctx.postWriteContributions;
            ctx.registry.register('Thing', { resolver: noopResolver });
          }
        }
      ]
    };

    await loadPlugins({
      plugins: [coordinator],
      kernelPlugins: [],
      edges,
      datasetFor: (): Dataset | undefined => dataset
    });

    expect(seenContributions).toBeUndefined();
  });
});
