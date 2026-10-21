/**
 * `engine.evaluateReadPolicy(ns, type, identity, probe?)` — the narrow policy probe
 * for out-of-band read surfaces. Kernel routes that return row
 * data without going through frame dispatch (substrate-recall's /substrate/v1/recall,
 * the future /substrate/v1/embeddings/fetch) call this so the SAME composed policy
 * objects that gate `engine.query` gate them too. Mirrors #runEntry's
 * pre-dispatch checks: namespace claim, tombstone, registry lookup, policy
 * evaluation with a query-shaped ctx. Fail-closed on anything unknown.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { denyAll, or, requireIdentity } from '@mnmal-ai/substrate-policy';
import type { EdgesStore, Policy, RequestContext, Resolver } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '../src/index.js';

const resolver: Resolver = async () => [];

function makeEngine(registry: Registry): Engine {
  const namespaces = new Map<string, NamespaceConfig>([['default', { registry }]]);
  const datasets = new MemoryDatasetRegistry();
  datasets.set('default', new MemoryDataset({ namespace: 'default' }));
  const edges: EdgesStore = new MemoryEdgesStore({ now: () => new Date('2026-06-06T00:00:00Z') });
  return new Engine({ namespaces, datasets, edges });
}

describe('Engine.evaluateReadPolicy', () => {
  it('allows when the entry has no policy', () => {
    const registry = new Registry();
    registry.register('Todo', { resolver });
    const engine = makeEngine(registry);

    expect(engine.evaluateReadPolicy('default', 'Todo', null).allow).toBe(true);
  });

  it('denies anonymous + allows identified under or(requireIdentity(), denyAll())', () => {
    const registry = new Registry();
    registry.register('Memory', {
      resolver,
      policy: or(requireIdentity(), denyAll('gated-read'))
    });
    const engine = makeEngine(registry);

    const denied = engine.evaluateReadPolicy('default', 'Memory', null);
    expect(denied.allow).toBe(false);
    expect(denied.reason).toBe('gated-read');

    expect(
      engine.evaluateReadPolicy('default', 'Memory', {
        id: 'agent-1',
        grants: { default: ['read'] }
      }).allow
    ).toBe(true);
  });

  it('evaluates with a query-shaped ctx: operation, entry, namespace, identity', () => {
    const seen: RequestContext[] = [];
    const capture: Policy = (ctx) => {
      seen.push(ctx);
      return { allow: true };
    };
    const registry = new Registry();
    registry.register('Todo', { resolver, policy: capture });
    const engine = makeEngine(registry);

    engine.evaluateReadPolicy('default', 'Todo', { id: 'agent-1', grants: { default: ['read'] } });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.operation).toBe('query');
    expect(seen[0]?.entry).toBe('Todo');
    expect(seen[0]?.namespace).toBe('default');
    expect(seen[0]?.identity).toEqual({ id: 'agent-1', grants: { default: ['read'] } });
  });

  it('fails closed on unknown namespace and unknown type', () => {
    const registry = new Registry();
    registry.register('Todo', { resolver });
    const engine = makeEngine(registry);

    expect(engine.evaluateReadPolicy('nope', 'Todo', null).allow).toBe(false);
    expect(engine.evaluateReadPolicy('default', 'Nope', null).allow).toBe(false);
  });

  it('fails closed on a tombstoned namespace', () => {
    const registry = new Registry();
    registry.register('Todo', { resolver });
    const engine = makeEngine(registry);

    engine.tombstoneNamespace('default');
    expect(engine.evaluateReadPolicy('default', 'Todo', null).allow).toBe(false);
  });

  it("denies when the identity's grant does not cover the ns", () => {
    const registry = new Registry();
    registry.register('Todo', { resolver });
    const engine = makeEngine(registry);

    const scoped = { id: 'agent-1', grants: { other: ['read'] } };
    expect(engine.evaluateReadPolicy('default', 'Todo', scoped).allow).toBe(false);

    const wildcard = { id: 'agent-1', grants: { '*': ['read'] } };
    expect(engine.evaluateReadPolicy('default', 'Todo', wildcard).allow).toBe(true);
  });

  it("decides with the caller's headers, clientIp and authEnabled when given them", () => {
    const blockIp: Policy = (ctx) =>
      ctx.clientIp === '10.0.0.9' ? { allow: false, reason: 'blocked ip' } : { allow: true };
    const tenantOnly: Policy = (ctx) =>
      ctx.headers['x-tenant'] === 'a' ? { allow: true } : { allow: false, reason: 'tenant a only' };
    const seen: RequestContext[] = [];
    const capture: Policy = (ctx) => {
      seen.push(ctx);
      return { allow: true };
    };
    const registry = new Registry();
    registry.register('Note', { resolver, policy: blockIp });
    registry.register('Doc', { resolver, policy: tenantOnly });
    registry.register('Todo', { resolver, policy: capture });
    const engine = makeEngine(registry);

    expect(engine.evaluateReadPolicy('default', 'Note', null, { clientIp: '10.0.0.9' }).allow).toBe(
      false
    );
    expect(engine.evaluateReadPolicy('default', 'Note', null, { clientIp: '10.0.0.8' }).allow).toBe(
      true
    );
    expect(
      engine.evaluateReadPolicy('default', 'Doc', null, { headers: { 'x-tenant': 'a' } }).allow
    ).toBe(true);
    expect(engine.evaluateReadPolicy('default', 'Doc', null, { headers: {} }).allow).toBe(false);
    expect(
      engine.evaluateWritePolicy('default', 'Note', null, { clientIp: '10.0.0.9' }).allow
    ).toBe(false);

    const meta = { tag: 1 };
    engine.evaluateReadPolicy('default', 'Todo', null, { authEnabled: true, meta });
    expect(seen[0]?.authEnabled).toBe(true);
    expect(seen[0]?.meta).toBe(meta);
    expect(seen[0]?.operation).toBe('query');
  });
});
