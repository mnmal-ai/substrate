import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import { MemoryEdgesStore } from '../src/memory-edges-store.js';
import { Registry } from '../src/registry.js';

const NOW = (): Date => new Date('2026-05-03T00:00:00Z');

describe('Engine.addNamespace', () => {
  it('extends the engine with a new namespace at runtime', () => {
    const datasets = new MemoryDatasetRegistry();
    datasets.set('alpha', new MemoryDataset({ namespace: 'alpha' }));
    const edges = new MemoryEdgesStore({ now: NOW });

    const engine = new Engine({
      namespaces: new Map([['alpha', { registry: new Registry() }]]),
      datasets,
      edges
    });

    expect(engine.registryFor('beta')).toBeUndefined();

    datasets.set('beta', new MemoryDataset({ namespace: 'beta' }));
    engine.addNamespace('beta', { registry: new Registry() });

    expect(engine.registryFor('beta')).toBeDefined();
  });

  it('throws on duplicate namespace registration', () => {
    const datasets = new MemoryDatasetRegistry();
    datasets.set('alpha', new MemoryDataset({ namespace: 'alpha' }));
    const engine = new Engine({
      namespaces: new Map([['alpha', { registry: new Registry() }]]),
      datasets,
      edges: new MemoryEdgesStore({ now: NOW })
    });
    expect(() => engine.addNamespace('alpha', { registry: new Registry() })).toThrow(
      /already registered/
    );
  });

  it('invalidates federated schema cache when a namespace is added', () => {
    const datasets = new MemoryDatasetRegistry();
    datasets.set('alpha', new MemoryDataset({ namespace: 'alpha' }));
    const engine = new Engine({
      namespaces: new Map([['alpha', { registry: new Registry() }]]),
      datasets,
      edges: new MemoryEdgesStore({ now: NOW })
    });

    const before = engine.federatedSchema();
    expect(Object.keys(before).sort()).toEqual(['alpha']);

    datasets.set('beta', new MemoryDataset({ namespace: 'beta' }));
    engine.addNamespace('beta', { registry: new Registry() });

    const after = engine.federatedSchema();
    expect(Object.keys(after).sort()).toEqual(['alpha', 'beta']);
  });

  it('addNamespace is reachable through EngineHandle', () => {
    const datasets = new MemoryDatasetRegistry();
    datasets.set('alpha', new MemoryDataset({ namespace: 'alpha' }));
    const engine = new Engine({
      namespaces: new Map([['alpha', { registry: new Registry() }]]),
      datasets,
      edges: new MemoryEdgesStore({ now: () => new Date() })
    });

    // Type assertion: Engine satisfies EngineHandle including addNamespace
    const handle: import('@mnmal-ai/substrate-types').EngineHandle = engine;
    datasets.set('gamma', new MemoryDataset({ namespace: 'gamma' }));
    handle.addNamespace('gamma', { registry: new Registry() });

    expect(engine.registryFor('gamma')).toBeDefined();
  });
});

describe('Engine.removeNamespace', () => {
  it('takes the namespace out of the schema and frees the name, even after a tombstone', () => {
    const datasets = new MemoryDatasetRegistry();
    datasets.set('alpha', new MemoryDataset({ namespace: 'alpha' }));
    datasets.set('beta', new MemoryDataset({ namespace: 'beta' }));
    const engine = new Engine({
      namespaces: new Map([['alpha', { registry: new Registry() }]]),
      datasets,
      edges: new MemoryEdgesStore({ now: NOW })
    });
    engine.addNamespace('beta', { registry: new Registry() });
    engine.tombstoneNamespace('beta');

    engine.removeNamespace('beta');
    engine.removeNamespace('beta');

    expect(engine.registryFor('beta')).toBeUndefined();
    expect(Object.keys(engine.federatedSchema())).toEqual(['alpha']);
    engine.addNamespace('beta', { registry: new Registry() });
    expect(engine.registryFor('beta')).toBeDefined();
  });
});
