/**
 * Json path predicates end to end: the engine validates the path
 * form against a declared json field, and a live subscription moves a row in
 * and out of the filter as its json value changes.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { RequestContext, Resolver, Row, WsResponseFrame } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import { MemoryEdgesStore } from '../src/memory-edges-store.js';
import { Registry } from '../src/registry.js';

const NS = 'default';
const NOW = (): Date => new Date('2026-09-23T00:00:00Z');
const ctx = (): Partial<RequestContext> => ({ now: NOW() });

async function settled(
  frames: WsResponseFrame[],
  want: (f: WsResponseFrame[]) => boolean
): Promise<void> {
  const deadline = Date.now() + 500;
  while (!want(frames) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

function setup(): Engine {
  const store = new Map<string, Row>();
  const list: Resolver = async () => [...store.values()];
  const put: Resolver = async (_c, args) => {
    const r: Row = { id: String(args.params?.id), values: args.params?.values };
    const op = store.has(String(r.id)) ? 'update' : 'create';
    store.set(String(r.id), r);
    args.onWrite?.({ ns: NS, type: 'Item', id: r.id, operation: op, row: r });
    return r;
  };
  const registry = new Registry();
  registry.register('Item', {
    resolver: list,
    fields: { values: { kind: 'scalar', type: 'json', indexed: false } }
  });
  registry.register('putItem', { kind: 'mutation', resolver: put });
  const datasets = new MemoryDatasetRegistry();
  datasets.set(NS, new MemoryDataset({ namespace: NS }));
  return new Engine({
    namespaces: new Map([[NS, { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: NOW })
  });
}

describe('json path predicates through the engine', () => {
  it('a subscription gains and loses a row as its json value crosses the filter', async () => {
    const engine = setup();
    const frames: WsResponseFrame[] = [];
    await engine.subscribe({
      id: 's1',
      frame: {
        'default/Item': {
          params: { where: { values: { path: ['year'], gt: 1990 } }, _allowTableScan: true },
          fields: { id: true }
        }
      },
      ctx: ctx(),
      onFrame: (f) => void frames.push(f)
    });
    await settled(frames, (f) => f.some((x) => x.kind === 'snapshot'));

    const put = (values: unknown) =>
      engine.mutate({ frame: { 'default/putItem': { params: { id: 'a', values } } }, ctx: ctx() });

    await put({ year: 2001 });
    await settled(frames, (f) => f.some((x) => x.kind === 'add'));
    expect(frames.some((f) => f.kind === 'add')).toBe(true);

    await put({ year: '2001' }); // a string: type-strict, so it leaves the filter
    await settled(frames, (f) => f.some((x) => x.kind === 'remove'));
    expect(frames.find((f) => f.kind === 'remove')).toMatchObject({ removedId: 'a' });
    expect(frames.some((f) => f.kind === 'error')).toBe(false);
  });

  it('a scanning operator without _allowTableScan is accepted at subscribe time', async () => {
    const engine = setup();
    const frames: WsResponseFrame[] = [];
    await engine.subscribe({
      id: 's2',
      frame: {
        'default/Item': {
          params: { where: { values: { path: ['year'], gt: 1990 } } },
          fields: { id: true }
        }
      },
      ctx: ctx(),
      onFrame: (f) => void frames.push(f)
    });
    await settled(frames, (f) => f.some((x) => x.kind === 'snapshot' || x.kind === 'error'));
    expect(frames.some((f) => f.kind === 'error')).toBe(false);
    expect(frames.some((f) => f.kind === 'snapshot')).toBe(true);
  });
});
