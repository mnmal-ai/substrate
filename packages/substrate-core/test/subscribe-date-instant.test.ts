/**
 * The live matcher compares a `date` field as an instant, so a push agrees
 * with the pg snapshot when the filter operand carries an offset.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { RequestContext, Resolver, Row, WsResponseFrame } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import { MemoryEdgesStore } from '../src/memory-edges-store.js';
import { Registry } from '../src/registry.js';

const NS = 'default';
const NOW = (): Date => new Date('2026-10-20T09:30:00Z');
const ctx = (): Partial<RequestContext> => ({ now: NOW() });

function setup(): Engine {
  const list: Resolver = async () => [];
  const put: Resolver = async (_c, args) => {
    const id = String(args.params?.id);
    const r: Row = { id, dueAt: String(args.params?.dueAt) };
    args.onWrite?.({ ns: NS, type: 'Task', id, operation: 'create', row: r });
    return r;
  };
  const registry = new Registry();
  registry.register('Task', {
    resolver: list,
    fields: { dueAt: { kind: 'scalar', type: 'date', indexed: true } }
  });
  registry.register('putTask', { kind: 'mutation', resolver: put });
  const datasets = new MemoryDatasetRegistry();
  datasets.set(NS, new MemoryDataset({ namespace: NS }));
  return new Engine({
    namespaces: new Map([[NS, { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: NOW })
  });
}

describe('subscriptions on a date field', () => {
  it('pushes a row whose instant matches an offset operand', async () => {
    const engine = setup();
    const frames: WsResponseFrame[] = [];
    await engine.subscribe({
      id: 's1',
      frame: {
        'default/Task': {
          // 11:00+02:00 is 09:00Z.
          params: { where: { dueAt: { gt: '2026-10-20T11:00:00+02:00' } } },
          fields: { id: true }
        }
      },
      ctx: ctx(),
      onFrame: (f) => void frames.push(f)
    });
    expect(frames.find((f) => f.kind === 'error')).toBeUndefined();

    // t1 (09:30Z) is after 09:00Z; t2 (08:30Z) is before it, though it sorts after as text.
    await engine.mutate({
      frame: { 'default/putTask': { params: { id: 't1', dueAt: '2026-10-20T09:30:00.000Z' } } },
      ctx: ctx()
    });
    await engine.mutate({
      frame: { 'default/putTask': { params: { id: 't2', dueAt: '2026-10-20T10:30:00+02:00' } } },
      ctx: ctx()
    });
    const deadline = Date.now() + 500;
    while (!frames.some((f) => f.kind === 'add') && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 5));
    const added = frames.filter((f) => f.kind === 'add').map((f) => JSON.stringify(f.data));
    expect(added.some((d) => d.includes('t1'))).toBe(true);
    expect(added.some((d) => d.includes('t2'))).toBe(false);
  });
});
