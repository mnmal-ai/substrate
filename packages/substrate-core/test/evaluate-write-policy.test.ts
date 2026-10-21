/**
 * `engine.evaluateWritePolicy` — the write-side twin of the read probe, for
 * kernel routes that MUTATE outside frame dispatch (substrate-recall's
 * /substrate/v1/salience/boost, the boost-on-read half of /substrate/v1/embeddings/fetch).
 *
 * The read probe cannot gate those: a namespace's posture can differ BY
 * OPERATION (writes need an identity while reads stay open). The
 * two probes differ only in the context handed to the policy: the write probe
 * carries `operation: 'mutate'` and `verb: 'update'`.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { denyVerbs, or, requireIdentity } from '@mnmal-ai/substrate-policy';
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

describe('Engine.evaluateWritePolicy', () => {
  it('asks the policy with operation=mutate, where the read probe asks query', () => {
    const seen: string[] = [];
    const policy: Policy = (ctx: RequestContext) => {
      seen.push(ctx.operation);
      return { allow: true };
    };
    const registry = new Registry();
    registry.register('Todo', { resolver, policy });
    const engine = makeEngine(registry);

    engine.evaluateReadPolicy('default', 'Todo', null);
    engine.evaluateWritePolicy('default', 'Todo', null);
    expect(seen).toEqual(['query', 'mutate']);
  });

  it('separates a reads-open / writes-identity posture', () => {
    // The read probe answers `allow` for an anonymous caller here, so gating a
    // WRITE with it would authorise nothing at all.
    const policy: Policy = (ctx: RequestContext) =>
      ctx.operation === 'query' || ctx.identity !== null
        ? { allow: true }
        : { allow: false, reason: 'writes require an authenticated identity' };
    const registry = new Registry();
    registry.register('Memory', { resolver, policy });
    const engine = makeEngine(registry);

    expect(engine.evaluateReadPolicy('default', 'Memory', null).allow).toBe(true);
    const denied = engine.evaluateWritePolicy('default', 'Memory', null);
    expect(denied.allow).toBe(false);
    expect(denied.reason).toBe('writes require an authenticated identity');
    expect(
      engine.evaluateWritePolicy('default', 'Memory', {
        id: 'agent-1',
        grants: { default: ['read', 'mutate'] }
      }).allow
    ).toBe(true);
  });

  it('fails closed on unknown namespace + unknown type, like its read twin', () => {
    const registry = new Registry();
    registry.register('Todo', { resolver });
    const engine = makeEngine(registry);

    expect(engine.evaluateWritePolicy('nope', 'Todo', null).allow).toBe(false);
    expect(engine.evaluateWritePolicy('default', 'Nope', null).allow).toBe(false);
  });

  it('allows when the entry declares no policy at all', () => {
    // Parity with the read probe: absence of a policy is not a denial. The
    // fail-closed default lives in the RECALL layer, where an unwired host
    // must not be able to write; the engine reports what the policy says.
    const registry = new Registry();
    registry.register('Todo', { resolver });
    expect(makeEngine(registry).evaluateWritePolicy('default', 'Todo', null).allow).toBe(true);
  });

  it("carries verb:'update', because the real gate reads ctx.verb and not ctx.operation", () => {
    // The usual reads-open write gate. `denyVerbs` returns allow when
    // `ctx.verb` is undefined, so a verb-less probe would let an unsigned
    // caller through. A policy keyed on `ctx.operation` cannot catch that.
    const policy: Policy = or(
      requireIdentity(),
      denyVerbs(
        ['create', 'update', 'delete'],
        'writes require an authenticated identity (reads stay open)'
      )
    );
    const registry = new Registry();
    registry.register('Note', { resolver, policy });
    const engine = makeEngine(registry);

    // Reads stay open — the posture this gate is named for.
    expect(engine.evaluateReadPolicy('default', 'Note', null).allow).toBe(true);

    // Anonymous write refused, and the reason comes from the NAMESPACE policy
    // rather than a fail-closed default.
    const denied = engine.evaluateWritePolicy('default', 'Note', null);
    expect(denied.allow).toBe(false);
    expect(denied.reason).toContain('writes require an authenticated identity');

    // Signed write allowed — the half a fail-closed default also breaks.
    expect(
      engine.evaluateWritePolicy('default', 'Note', {
        id: 'agent-1',
        grants: { default: ['read', 'mutate'] }
      }).allow
    ).toBe(true);
  });
});
