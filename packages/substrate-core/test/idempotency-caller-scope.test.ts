/**
 * The §5.13 idempotency cache must be scoped to the caller. Otherwise a second
 * caller presenting the SAME idempotencyKey for the same frame would receive
 * the first caller's cached envelope BEFORE namespace gates / policy /
 * row-filter obligations were evaluated for it — a confidentiality break.
 *
 * The behavioural invariant tested here: a cache HIT short-circuits dispatch
 * (resolver not re-run). So "different caller must NOT hit the cache" is exactly
 * "the resolver re-runs for a different caller" — which re-applies that caller's
 * policy/obligations. Same caller must still dedup (idempotency preserved), and
 * a null identity (auth disabled / anonymous) collapses to one bucket.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { Identity, RequestContext, Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import {
  Engine,
  MemoryEdgesStore,
  MemoryIdempotencyStore,
  type NamespaceConfig,
  Registry,
  type Resolver
} from '../src/index.js';

function bootstrap(): { engine: Engine; getRuns: () => number } {
  const dataset = new MemoryDataset({ namespace: 'default' });
  const registry = new Registry();
  const datasets = new MemoryDatasetRegistry();
  datasets.set('default', dataset);
  const namespaces = new Map<string, NamespaceConfig>([['default', { registry }]]);
  let runs = 0;
  const resolver: Resolver = async (_ctx, args) => {
    runs += 1;
    const params = (args.params ?? {}) as { id?: string };
    if (!args.dataset) throw new Error('expected engine-injected args.dataset');
    const row: Row = { id: params.id ?? 'x', title: 'x' };
    await args.dataset.write('Todo', [row]);
    return row;
  };
  registry.register('createTodo', { kind: 'mutation', resolver });

  const engine = new Engine({
    namespaces,
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date('2026-06-28T00:00:00Z') }),
    metric: () => {},
    idempotency: { store: new MemoryIdempotencyStore() }
  });
  return { engine, getRuns: () => runs };
}

function ctxFor(identity: Identity | null): Partial<RequestContext> {
  return { identity, now: new Date('2026-06-28T00:00:00Z'), headers: {}, meta: {} };
}

// Two callers differing in principal (and thus, in any real deployment, in the
// policy/row-filter obligations applied to them).
const callerA: Identity = {
  id: 'agent-a',
  grants: { default: ['read', 'mutate'] }
};
const callerB: Identity = {
  id: 'agent-b',
  grants: { default: ['read', 'mutate'] }
};

describe('idempotency cache is caller-scoped', () => {
  it('single-frame: a different caller with the same idempotencyKey does NOT hit the cache', async () => {
    const { engine, getRuns } = bootstrap();
    const frame = { 'default/createTodo': { params: { id: 'shared' }, idempotencyKey: 'k1' } };

    const a1 = await engine.mutate({ frame, ctx: ctxFor(callerA) });
    expect(a1.errors).toBeUndefined();
    expect(getRuns()).toBe(1);

    // Same caller replays → cache hit, resolver NOT re-run (idempotency intact).
    const a2 = await engine.mutate({ frame, ctx: ctxFor(callerA) });
    expect(getRuns()).toBe(1);
    expect(a2.data['default/createTodo']).toEqual(a1.data['default/createTodo']);

    // Different caller, same key → MUST re-dispatch (no cross-caller leak).
    await engine.mutate({ frame, ctx: ctxFor(callerB) });
    expect(getRuns()).toBe(2);
  });

  it('batched array: a different caller with the same per-slot idempotencyKey does NOT hit the cache', async () => {
    const { engine, getRuns } = bootstrap();
    const frame = { 'default/createTodo': [{ params: { id: 'arr' }, idempotencyKey: 'ak1' }] };

    await engine.mutate({ frame, ctx: ctxFor(callerA) });
    expect(getRuns()).toBe(1);

    // Same caller replays → per-slot cache hit.
    await engine.mutate({ frame, ctx: ctxFor(callerA) });
    expect(getRuns()).toBe(1);

    // Different caller → re-dispatch.
    await engine.mutate({ frame, ctx: ctxFor(callerB) });
    expect(getRuns()).toBe(2);
  });

  it('null identity (auth disabled / anonymous) still dedups across calls', async () => {
    const { engine, getRuns } = bootstrap();
    const frame = { 'default/createTodo': { params: { id: 'anon' }, idempotencyKey: 'kn' } };

    await engine.mutate({ frame, ctx: ctxFor(null) });
    await engine.mutate({ frame, ctx: ctxFor(null) });
    expect(getRuns()).toBe(1);
  });
});
