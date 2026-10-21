/**
 * `postWrite` runs only once the engine transaction commits: a rolled-back
 * update must not fire it on the prior row.
 */

import { Engine, MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { ResolverFrameError } from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
import { defineNamespace, field } from '../src/index.js';

describe('postWrite after commit', () => {
  it('is not called for an update the transaction rolls back', async () => {
    const dataset = new MemoryDataset({ namespace: 'test' });
    const edges = new MemoryEdgesStore({ now: () => new Date() });
    const postWrite = vi.fn().mockResolvedValue(undefined);
    const registry = new Registry();
    defineNamespace('test', {
      Widget: { fields: { name: field.string() }, postWrite }
    }).install({ registry, dataset, edges });
    registry.register('refuse', {
      resolver: async () => {
        throw new ResolverFrameError('not_found', 'no such row');
      }
    });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('test', dataset);
    const engine = new Engine({ namespaces: new Map([['test', { registry }]]), datasets, edges });
    const identity = { kind: 'system' as const, id: 'test', grants: { '*': ['read', 'mutate'] } };
    const ctx = { identity, headers: {}, meta: {} };
    await dataset.write('Widget', [{ id: 'w1', name: 'before' }], { identity, now: new Date() });

    await engine.mutate({
      frame: {
        'test/updateWidget': { params: { id: 'w1', name: 'after' }, fields: { id: true } },
        'test/refuse': { params: {} }
      },
      ctx
    });
    expect((await dataset.read('Widget', { id: 'w1' })).rows[0]?.name).toBe('before');
    expect(postWrite).not.toHaveBeenCalled();

    await engine.mutate({
      frame: { 'test/updateWidget': { params: { id: 'w1', name: 'after' }, fields: { id: true } } },
      ctx
    });
    expect(postWrite).toHaveBeenCalledTimes(1);
  });
});
