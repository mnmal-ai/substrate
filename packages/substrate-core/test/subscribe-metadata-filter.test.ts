/**
 * A subscription filtered on an author spelling the read path returns
 * (`createdBy`) reaches the snapshot resolver and the live matcher as the
 * canonical column, as a one-shot query does.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { RequestContext, Resolver, Row, WsResponseFrame } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import { MemoryEdgesStore } from '../src/memory-edges-store.js';
import { Registry } from '../src/registry.js';

const NS = 'default';
const NOW = (): Date => new Date('2026-10-09T00:00:00Z');
const ctx = (): Partial<RequestContext> => ({ now: NOW() });

function setup(seenWhere: unknown[]): Engine {
  const list: Resolver = async (_c, args) => {
    seenWhere.push(args.params?.where);
    return [];
  };
  const put: Resolver = async (_c, args) => {
    const id = String(args.params?.id);
    const r: Row = {
      id,
      title: 't',
      _metadata: {
        createdAt: NOW().toISOString(),
        updatedAt: NOW().toISOString(),
        createdBy: { kind: 'agent', id: String(args.params?.by) },
        updatedBy: { kind: 'agent', id: String(args.params?.by) }
      }
    };
    args.onWrite?.({ ns: NS, type: 'Note', id, operation: 'create', row: r });
    return r;
  };
  const registry = new Registry();
  registry.register('Note', {
    resolver: list,
    fields: { title: { kind: 'scalar', type: 'string', indexed: true } }
  });
  registry.register('putNote', { kind: 'mutation', resolver: put });
  const datasets = new MemoryDatasetRegistry();
  datasets.set(NS, new MemoryDataset({ namespace: NS }));
  return new Engine({
    namespaces: new Map([[NS, { registry }]]),
    datasets,
    edges: new MemoryEdgesStore({ now: NOW })
  });
}

describe('subscriptions on an author spelling', () => {
  it('hands the snapshot resolver the canonical column and pushes only matching rows', async () => {
    const seenWhere: unknown[] = [];
    const engine = setup(seenWhere);
    const frames: WsResponseFrame[] = [];
    await engine.subscribe({
      id: 's1',
      frame: {
        'default/Note': {
          params: { where: { createdBy: { eq: { kind: 'agent', id: 'me' } } } },
          fields: { id: true }
        }
      },
      ctx: ctx(),
      onFrame: (f) => void frames.push(f)
    });
    expect(frames.find((f) => f.kind === 'error')).toBeUndefined();
    expect(seenWhere).toEqual([
      { AND: [{ createdById: { eq: 'me' }, createdByKind: { eq: 'agent' } }] }
    ]);

    await engine.mutate({
      frame: { 'default/putNote': { params: { id: 'n1', by: 'me' } } },
      ctx: ctx()
    });
    await engine.mutate({
      frame: { 'default/putNote': { params: { id: 'n2', by: 'other' } } },
      ctx: ctx()
    });
    const deadline = Date.now() + 500;
    while (!frames.some((f) => f.kind === 'add') && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 5));
    const added = frames.filter((f) => f.kind === 'add').map((f) => JSON.stringify(f.data));
    expect(added.some((d) => d.includes('n1'))).toBe(true);
    expect(added.some((d) => d.includes('n2'))).toBe(false);
  });
});
