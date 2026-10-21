/**
 * A write that commits DURING the snapshot resolver, after the resolver has
 * captured its view, must still reach the subscriber as a live push. The entry
 * registers (buffering raw events) BEFORE the resolver runs and replays the
 * buffer after the snapshot.
 *
 * The race is reproduced deterministically: the snapshot resolver itself
 * commits a racing write via a re-entrant engine.mutate, after capturing its
 * (empty) snapshot view.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { RequestContext, Resolver, Row, WsResponseFrame } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/engine/engine.js';
import { MemoryEdgesStore } from '../src/memory-edges-store.js';
import { Registry } from '../src/registry.js';

const NS = 'default';
const NOW = (): Date => new Date('2026-06-28T00:00:00Z');

function ctx(): Partial<RequestContext> {
  return { now: NOW() };
}

/** Frame delivery is enqueue + lazy drain — poll until the predicate holds. */
async function settled(
  frames: WsResponseFrame[],
  want: (f: WsResponseFrame[]) => boolean,
  ms = 500
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!want(frames) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('subscription registers before the snapshot resolver', () => {
  it('delivers a write that commits during the snapshot resolver (no lost event)', async () => {
    const store = new Map<string, Row>();
    let engine!: Engine;
    let raced = false;

    const list: Resolver = async () => {
      // Capture the snapshot view FIRST so the racing write is not reflected in
      // it (the write must arrive as a live push, not via the snapshot).
      const view = [...store.values()];
      if (!raced) {
        raced = true;
        // A concurrent mutate commits while this subscribe is mid-registration.
        await engine.mutate({
          frame: { 'default/createItem': { params: { id: 'race1' } } },
          ctx: ctx()
        });
      }
      return view;
    };
    const create: Resolver = async (_c, args) => {
      const r: Row = { id: String(args.params?.id) };
      store.set(String(r.id), r);
      args.onWrite?.({ ns: NS, type: 'Item', id: r.id, operation: 'create', row: r });
      return r;
    };

    const registry = new Registry();
    registry.register('Item', { resolver: list });
    registry.register('createItem', { kind: 'mutation', resolver: create });

    const datasets = new MemoryDatasetRegistry();
    datasets.set(NS, new MemoryDataset({ namespace: NS }));
    engine = new Engine({
      namespaces: new Map([[NS, { registry }]]),
      datasets,
      edges: new MemoryEdgesStore({ now: NOW })
    });

    const frames: WsResponseFrame[] = [];
    await engine.subscribe({
      id: 's1',
      frame: { 'default/Item': { params: {}, fields: { id: true } } },
      ctx: ctx(),
      onFrame: (f) => void frames.push(f)
    });

    await settled(frames, (f) => f.some((x) => x.kind === 'add'));

    const snapshot = frames.find((f) => f.kind === 'snapshot');
    expect(snapshot).toBeDefined();
    // The racing write was NOT captured by the snapshot...
    expect((snapshot as { data: Record<string, unknown> }).data['default/Item']).toEqual([]);
    // ...so it must arrive as a live add.
    const add = frames.find((f) => f.kind === 'add');
    expect(add).toBeDefined();
    expect((add as { data: Record<string, unknown> }).data['default/Item']).toEqual({
      id: 'race1'
    });

    // Ordering: snapshot precedes the push.
    expect(frames.findIndex((f) => f.kind === 'snapshot')).toBeLessThan(
      frames.findIndex((f) => f.kind === 'add')
    );
  });

  it('does not duplicate-deliver a row already present in the snapshot', async () => {
    // Regression guard for the replay path: a write that races but whose row is
    // already in the snapshot must not produce a spurious second `add`.
    const store = new Map<string, Row>([['seed', { id: 'seed' }]]);
    let engine!: Engine;
    let raced = false;

    const list: Resolver = async () => {
      const view = [...store.values()];
      if (!raced) {
        raced = true;
        await engine.mutate({
          frame: { 'default/touchItem': { params: { id: 'seed' } } },
          ctx: ctx()
        });
      }
      return view; // includes 'seed'
    };
    const touch: Resolver = async (_c, args) => {
      const r: Row = { id: String(args.params?.id) };
      store.set(String(r.id), r);
      args.onWrite?.({ ns: NS, type: 'Item', id: r.id, operation: 'update', row: r });
      return r;
    };

    const registry = new Registry();
    registry.register('Item', { resolver: list });
    registry.register('touchItem', { kind: 'mutation', resolver: touch });

    const datasets = new MemoryDatasetRegistry();
    datasets.set(NS, new MemoryDataset({ namespace: NS }));
    engine = new Engine({
      namespaces: new Map([[NS, { registry }]]),
      datasets,
      edges: new MemoryEdgesStore({ now: NOW })
    });

    const frames: WsResponseFrame[] = [];
    await engine.subscribe({
      id: 's2',
      frame: { 'default/Item': { params: {}, fields: { id: true } } },
      ctx: ctx(),
      onFrame: (f) => void frames.push(f)
    });

    await settled(frames, (f) => f.length >= 2);

    // The snapshot already contains 'seed'; the racing write replays as an
    // `update` (state the client already has), never a second `add`.
    expect(frames.filter((f) => f.kind === 'add')).toHaveLength(0);
  });
});
