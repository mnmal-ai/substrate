/**
 * Engine-level subscribe test: string range operators in subscriptions.
 *
 * Verifies that:
 *  - The snapshot frame only includes rows matching the string-range where.
 *  - A live push for a row entering the range produces an `add` frame.
 *  - A live push for that row leaving the range produces a `remove` frame.
 *
 * Bootstrap pattern from async-cancellation.test.ts.
 */

import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { FieldDef, RequestContext, WsResponseFrame } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { installAutoCrud } from '../src/index.js';

function makeEdges(nowMs = Date.parse('2026-04-18T00:00:00Z')): MemoryEdgesStore {
  return new MemoryEdgesStore({ now: () => new Date(nowMs) });
}

function makeCtx(overrides: Partial<RequestContext> = {}): Partial<RequestContext> {
  return {
    identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } },
    now: new Date('2026-04-18T00:00:00Z'),
    headers: {},
    meta: {},
    ...overrides
  };
}

function todoFields(): Record<string, FieldDef> {
  return {
    id: { kind: 'scalar', type: 'string', indexed: true },
    title: { kind: 'scalar', type: 'string', indexed: true }
  };
}

interface Bootstrapped {
  engine: Engine;
  dataset: MemoryDataset;
}

function bootstrap(): Bootstrapped {
  const dataset = new MemoryDataset({ namespace: 'default' });
  const edges = makeEdges();
  const registry = new Registry();
  installAutoCrud(registry, 'Todo', dataset, edges, { fields: todoFields() });
  const datasets = new MemoryDatasetRegistry();
  datasets.set('default', dataset);
  const namespaces = new Map<string, NamespaceConfig>([['default', { registry }]]);
  const engine = new Engine({ namespaces, datasets, edges });
  return { engine, dataset };
}

describe('subscribe — string range where filter (ask 3)', () => {
  it('snapshot filters by string range, live pushes enter/leave correctly', async () => {
    const ctx = bootstrap();

    // Seed one in-range (gt 'm': 'zebra' > 'm') and one out-of-range ('apple' <= 'm')
    // BEFORE subscribing.
    await ctx.engine.mutate({
      frame: { 'default/createTodo': { params: { id: 's1', title: 'zebra' } } },
      ctx: makeCtx()
    });
    await ctx.engine.mutate({
      frame: { 'default/createTodo': { params: { id: 's2', title: 'apple' } } },
      ctx: makeCtx()
    });

    const frames: WsResponseFrame[] = [];
    await ctx.engine.subscribe({
      id: 'rng-1',
      frame: {
        'default/Todo': {
          params: { where: { title: { gt: 'm' } } },
          fields: { id: true, title: true }
        }
      },
      ctx: makeCtx(),
      onFrame: (f) => {
        frames.push(f);
      }
    });

    // Snapshot must contain only the in-range row ('zebra').
    // Regression: string range operators must yield a snapshot, not an
    // unknown_operator error frame.
    const snap = frames.find((f) => f.kind === 'snapshot');
    expect(snap).toBeDefined();
    const rows = (snap!.data as Record<string, Array<{ id: string }>>)['default/Todo'];
    expect(rows?.map((r) => r.id)).toEqual(['s1']);

    // Mutate a new row whose title enters the range (title: 'nectarine' > 'm').
    await ctx.engine.mutate({
      frame: { 'default/createTodo': { params: { id: 's3', title: 'nectarine' } } },
      ctx: makeCtx()
    });
    // Then move that row out of the range (title: 'fig' <= 'm') → remove frame.
    await ctx.engine.mutate({
      frame: { 'default/updateTodo': { params: { id: 's3', title: 'fig' } } },
      ctx: makeCtx()
    });

    // Allow the subscription bus to drain.
    await new Promise<void>((r) => setTimeout(r, 20));

    expect(frames.some((f) => f.kind === 'add')).toBe(true);
    expect(
      frames.some((f) => f.kind === 'remove' && (f as { removedId?: string }).removedId === 's3')
    ).toBe(true);
  });
});
