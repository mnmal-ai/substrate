/**
 * A subscription filtered on a vocabulary alias matches rows stored under the
 * canonical value, as a one-shot query does.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { RequestContext, Resolver, Row, WsResponseFrame } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import { MemoryEdgesStore } from '../src/memory-edges-store.js';
import { Registry } from '../src/registry.js';

const NS = 'default';
const NOW = (): Date => new Date('2026-10-03T00:00:00Z');
const ctx = (): Partial<RequestContext> => ({ now: NOW() });

function setup(): Engine {
  const store = new Map<string, Row>();
  const list: Resolver = async () => [...store.values()];
  const put: Resolver = async (_c, args) => {
    const r: Row = { id: String(args.params?.id), status: args.params?.status };
    store.set(String(r.id), r);
    args.onWrite?.({ ns: NS, type: 'Decision', id: r.id, operation: 'create', row: r });
    return r;
  };
  const registry = new Registry();
  registry.register('Decision', {
    resolver: list,
    fields: {
      status: {
        kind: 'scalar',
        type: 'string',
        indexed: true,
        enum: ['open', 'active'],
        aliases: { accepted: 'active' }
      }
    }
  });
  registry.register('putDecision', { kind: 'mutation', resolver: put });
  const datasets = new MemoryDatasetRegistry();
  datasets.set(NS, new MemoryDataset({ namespace: NS }));
  return new Engine({
    namespaces: new Map([[NS, { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: NOW })
  });
}

describe('subscriptions on a governed vocabulary', () => {
  it('delivers a canonical row to a subscription filtered on its alias', async () => {
    const engine = setup();
    const frames: WsResponseFrame[] = [];
    await engine.subscribe({
      id: 's1',
      frame: {
        'default/Decision': {
          params: { where: { status: { eq: 'accepted' } } },
          fields: { id: true }
        }
      },
      ctx: ctx(),
      onFrame: (f) => void frames.push(f)
    });
    await engine.mutate({
      frame: { 'default/putDecision': { params: { id: 'd1', status: 'active' } } },
      ctx: ctx()
    });
    await engine.mutate({
      frame: { 'default/putDecision': { params: { id: 'd2', status: 'open' } } },
      ctx: ctx()
    });
    const deadline = Date.now() + 500;
    while (!frames.some((f) => f.kind === 'add') && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 5));
    const added = frames.filter((f) => f.kind === 'add').map((f) => JSON.stringify(f.data));
    expect(added.some((d) => d.includes('d1'))).toBe(true);
    expect(added.some((d) => d.includes('d2'))).toBe(false);
  });
});
