/**
 * A caller refused by its grant is told the same thing whether the namespace,
 * the type or neither exists behind the refusal.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { Identity, WsResponseFrame } from '@mnmal-ai/substrate-types';
import { expect, it } from 'vitest';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '../src/index.js';

function boot() {
  const datasets = new MemoryDatasetRegistry();
  const namespaces = new Map<string, NamespaceConfig>();
  for (const ns of ['held', 'kept']) {
    datasets.set(ns, new MemoryDataset({ namespace: ns }));
    const registry = new Registry();
    registry.register(ns === 'held' ? 'Open' : 'Note', {
      kind: 'type',
      fields: { name: { kind: 'scalar', type: 'string' } },
      resolver: async () => []
    });
    namespaces.set(ns, { registry });
  }
  return new Engine({
    namespaces,
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date() })
  });
}

const outsider: Identity = { id: 'o', kind: 'agent', grants: { held: ['read', 'mutate'] } };
const writer: Identity = { id: 'w', kind: 'agent', grants: { kept: ['mutate'] } };
const ctxOf = (identity: Identity | null) => ({ identity, now: new Date(), headers: {}, meta: {} });

/** The reply with the names it was asked about replaced, so replies compare. */
const blank = (reply: unknown, key: string) =>
  JSON.stringify(reply)
    .replaceAll(key, 'K')
    .replaceAll(key.split('/')[0] as string, 'NS');

it('a refused read answers alike for a real type, a missing type and a missing namespace', async () => {
  const engine = boot();
  const ask = async (key: string, operation: 'query' | 'mutate') =>
    blank(
      await engine[operation]({
        // Past the page maximum, with a nested limit past it too.
        frame: { [key]: { params: { limit: 5000 }, fields: { id: true } } },
        ctx: ctxOf(outsider),
        pageLimits: { defaultLimit: 100, maxLimit: 1000 }
      }),
      key
    );
  for (const operation of ['query', 'mutate'] as const) {
    const real = await ask('kept/Note', operation);
    expect(real).toContain('unauthorized_namespace');
    expect(await ask('kept/Nope', operation)).toBe(real);
    expect(await ask('nowhere/Note', operation)).toBe(real);
  }
});

it('an unqualified key is pointed only at a namespace the caller holds something in', async () => {
  const engine = boot();
  const hint = async (key: string, identity: Identity | null) =>
    (await engine.query({ frame: { [key]: { fields: { id: true } } }, ctx: ctxOf(identity) }))
      .errors?.[0]?.message;
  expect(await hint('Note', outsider)).not.toContain('kept');
  expect(await hint('Open', outsider)).toContain("did you mean 'held/Open'");
  expect(await hint('Note', null)).toContain("did you mean 'kept/Note'");
});

it('subscribe and stream refuse a key without read as query does', async () => {
  const engine = boot();
  for (const open of ['subscribe', 'stream'] as const) {
    for (const [identity, code] of [
      [writer, 'unauthorized_capability'],
      [outsider, 'unauthorized_namespace']
    ] as const) {
      const frames: WsResponseFrame[] = [];
      await engine[open]({
        id: 's',
        frame: { 'kept/Note': { fields: { id: true } } },
        ctx: { identity },
        onFrame: (f) => void frames.push(f)
      });
      const error = frames.find((f) => f.kind === 'error');
      expect(error?.kind === 'error' ? error.errors?.[0]?.code : undefined).toBe(code);
    }
  }
});
