/**
 * Subscribers hear each commit when it commits, not when the whole mutate ends.
 * A mutate's single-frame bucket and each array key commit separately; pushing
 * once at the end lets a slower mutate's older write reach subscribers after a
 * newer one, and a later failure loses the push for an earlier commit.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { RequestContext, Resolver, Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import type { NamespaceConfig } from '../src/index.js';
import { Engine, MemoryEdgesStore, Registry } from '../src/index.js';

const NS = 'default';
const ctx = (): RequestContext => ({ namespace: NS, identity: null }) as unknown as RequestContext;

describe('subscriber pushes per commit', () => {
  it('pushes the single-frame bucket before a later array key finishes', async () => {
    const dataset = new MemoryDataset({ namespace: NS });
    const datasets = new MemoryDatasetRegistry();
    datasets.set(NS, dataset);
    const registry = new Registry();
    const namespaces = new Map<string, NamespaceConfig>([[NS, { registry }]]);
    const engine = new Engine({
      namespaces,
      datasets,
      edges: new MemoryEdgesStore({ now: () => new Date() }),
      metric: () => {}
    });
    registry.register('Todo', {
      kind: 'type',
      fields: { id: { kind: 'scalar', type: 'string' }, title: { kind: 'scalar', type: 'string' } },
      resolver: (async () => []) as unknown as Resolver
    });
    let started!: () => void;
    const slowStarted = new Promise<void>((r) => {
      started = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const create =
      (slow: boolean): Resolver =>
      async (_ctx, args) => {
        if (slow) {
          started();
          await gate;
        }
        const id = String((args.params as { id: string }).id);
        const row = { id, title: id } as Row;
        await args.dataset?.write('Todo', [row]);
        args.onWrite?.({ ns: NS, type: 'Todo', id, operation: 'create', row });
        return row;
      };
    registry.register('createTodo', { kind: 'mutation', resolver: create(false) });
    registry.register('slowCreateTodo', { kind: 'mutation', resolver: create(true) });

    const pushed: unknown[] = [];
    await engine.subscribe({
      id: 'sub',
      frame: { [`${NS}/Todo`]: { params: {}, fields: { id: true } } },
      ctx: ctx(),
      onFrame: (f: { kind: string }) => {
        if (f.kind !== 'snapshot') pushed.push(f);
      }
    });

    const done = engine.mutate({
      frame: {
        [`${NS}/createTodo`]: { params: { id: 'a' } },
        [`${NS}/slowCreateTodo`]: [{ params: { id: 'b' } }]
      },
      ctx: ctx()
    });
    await slowStarted;
    await new Promise((r) => setTimeout(r, 20));
    // `a` committed with the single-frame bucket; its push must not wait for `b`.
    expect(pushed.length).toBe(1);

    release();
    await done;
    await new Promise((r) => setTimeout(r, 20));
    expect(pushed.length).toBe(2);
  });
});
