/**
 * Post-commit write-event fanout for BATCHED ARRAYS: a frame whose transaction
 * rolled back must not be announced to subscribers.
 *
 * `engine.mutate` dispatches write events after the transactions. A
 * whole-mutate throw skips that dispatch, but `#runArrayEntry` catches an
 * array's rollback, records `batched_frame_rolled_back` and returns normally,
 * so events from frames that ran before the failure must be discarded
 * explicitly rather than relying on the throw.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { RequestContext, Resolver, Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import type { NamespaceConfig } from '../src/index.js';
import { Engine, MemoryEdgesStore, Registry } from '../src/index.js';

const NS = 'default';

function makeCtx(): RequestContext {
  return { namespace: NS, identity: null } as unknown as RequestContext;
}

function bootstrap(): { engine: Engine; registry: Registry; dataset: MemoryDataset } {
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
  return { engine, registry, dataset };
}

/** Registers a Todo type plus a create mutation whose `boom` id throws. */
function registerTodo(registry: Registry): void {
  registry.register('Todo', {
    kind: 'type',
    fields: { id: { kind: 'scalar', type: 'string' }, title: { kind: 'scalar', type: 'string' } },
    resolver: (async () => []) as unknown as Resolver
  });
  const resolver: Resolver = async (_ctx, args) => {
    const params = (args.params ?? {}) as { id?: string };
    if (params.id === 'boom') throw new Error('frame 1 explodes');
    const row = { id: params.id ?? 'x', title: 'x' } as Row;
    await args.dataset?.write('Todo', [row]);
    args.onWrite?.({ ns: NS, type: 'Todo', id: row.id as string, operation: 'create', row });
    return row;
  };
  registry.register('createTodo', { kind: 'mutation', resolver });
}

describe('batched rollback must not dispatch write events', () => {
  it('does not push for a frame whose transaction rolled back', async () => {
    const { engine, registry, dataset } = bootstrap();
    registerTodo(registry);

    const pushed: Array<unknown> = [];
    await engine.subscribe({
      id: 'sub-1',
      frame: { [`${NS}/Todo`]: { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (f: { kind: string; data?: unknown }) => {
        // The snapshot is not a write event; only later pushes are.
        if (f.kind !== 'snapshot') pushed.push(f);
      }
    });

    const envelope = await engine.mutate({
      frame: {
        [`${NS}/createTodo`]: [{ params: { id: 't1' } }, { params: { id: 'boom' } }]
      },
      ctx: makeCtx()
    });

    // Precondition: the batch really did roll back.
    expect(envelope.errors?.[0]?.code).toBe('batched_frame_rolled_back');
    const { rows } = await dataset.read('Todo', { includeDeleted: true });
    expect(rows).toHaveLength(0);

    // Let any queued dispatch drain before asserting on its absence — a
    // same-tick assertion would pass for the wrong reason.
    await new Promise((r) => setTimeout(r, 20));

    // THE POINT: frame 0 committed nothing, so nothing may be announced.
    expect(pushed).toEqual([]);
  });

  it('POSITIVE CONTROL — a batch that COMMITS does push, so the assertion above can fail', async () => {
    // Without this, the test above is a null result from a possibly-blind
    // instrument: "no push observed" and "cannot observe pushes" look
    // identical.
    const { engine, registry } = bootstrap();
    registerTodo(registry);

    const pushed: Array<unknown> = [];
    await engine.subscribe({
      id: 'sub-2',
      frame: { [`${NS}/Todo`]: { params: {}, fields: { id: true } } },
      ctx: makeCtx(),
      onFrame: (f: { kind: string; data?: unknown }) => {
        if (f.kind !== 'snapshot') pushed.push(f);
      }
    });

    const envelope = await engine.mutate({
      frame: {
        [`${NS}/createTodo`]: [{ params: { id: 'ok1' } }, { params: { id: 'ok2' } }]
      },
      ctx: makeCtx()
    });
    expect(envelope.errors ?? []).toEqual([]);

    await new Promise((r) => setTimeout(r, 20));
    expect(pushed.length).toBeGreaterThan(0);
  });
});
