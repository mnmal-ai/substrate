/**
 * Realm-safety of the extension-operator registry.
 *
 * A process can hold more than one copy of `substrate-filter` — a plugin that
 * resolves its own rather than sharing the binary's is enough. Module-scope
 * Maps would give two registries, and an operator registered through one copy
 * would be SILENTLY invisible through the other. The Maps hang off
 * `globalThis` under `Symbol.for` keys so every copy finds one store.
 *
 * ## Why the first assertion in each test is about the SECOND MODULE ITSELF
 *
 * Whether a query-specifier import yields a distinct module instance is a
 * property of the resolver, not a guarantee. If vitest deduped it, every
 * assertion below would be checking that a module shares state with itself —
 * passing whatever the storage does, and pinning the half that was never in
 * danger. So each test establishes the split before relying on it: distinct
 * function identities prove two evaluations, and two evaluations are exactly
 * what would produce two module-scope Maps.
 *
 * If this ever starts failing at the distinctness check rather than the
 * convergence check, the resolver has changed and the mechanism needs
 * replacing (a Worker, a `vm` context, two physically copied `dist` trees) —
 * not the assertion relaxing.
 */

import type { FilterOperatorDef } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import * as first from '../src/extension-operators.js';

const op: FilterOperatorDef = {
  validate: () => ({ ok: true, value: {} }),
  execute: async () => ({ hits: [] })
};

const semanticOp: FilterOperatorDef = {
  computedFields: ['_score'],
  validate: () => ({ ok: true, value: {} }),
  execute: async () => ({ hits: [] })
};

/**
 * A second evaluation of the module — the stand-in for a second npm copy.
 *
 * The specifier stays a literal because that is what the bundler's resolver
 * acts on: built from a variable it is not transformed, and the import either
 * fails or silently returns the same instance, which is the one outcome this
 * file cannot tolerate. `tsc` has no such resolver and rejects the query
 * string, hence the suppression — expect-error rather than ts-ignore so it
 * fails loudly if TS ever learns to resolve it and the workaround becomes dead
 * weight.
 */
async function loadSecondRealm(): Promise<typeof first> {
  // @ts-expect-error — query-specifier module is resolved by vite, not by tsc
  return (await import('../src/extension-operators.js?realm=2')) as typeof first;
}

describe('extension-operator registry across module realms', () => {
  afterEach(() => first.clearExtensionOperators());

  it('the query-specifier import really is a second module evaluation', async () => {
    const second = await loadSecondRealm();

    // Distinct function objects ⇒ the module body ran twice ⇒ module-scope
    // `const` would have produced two Maps. Everything below depends on this.
    expect(second).not.toBe(first);
    expect(second.registerExtensionOperator).not.toBe(first.registerExtensionOperator);
  });

  it('an operator registered in one realm is visible from the other', async () => {
    const second = await loadSecondRealm();
    expect(second.registerExtensionOperator).not.toBe(first.registerExtensionOperator);

    first.registerExtensionOperator('embeddingSimilar', op);

    expect(second.getExtensionOperator('embeddingSimilar')).toBe(op);
    expect(second.listExtensionOperators()).toEqual(['embeddingSimilar']);
  });

  it('shares computed-field ownership, so the computed-field gate cannot see half a registry', async () => {
    const second = await loadSecondRealm();
    expect(second.computedFieldOwner).not.toBe(first.computedFieldOwner);

    first.registerExtensionOperator('embeddingSimilar', semanticOp);

    // The gate refuses projecting `_score` without its owning operator in the
    // where-clause. A split registry would make the owner unknown from one
    // side, turning a deliberate refusal into a silent pass.
    expect(second.computedFieldOwner('_score')).toBe('embeddingSimilar');
    expect(second.hasComputedFields()).toBe(true);
  });

  it('duplicate registration collides across realms rather than silently forking', async () => {
    const second = await loadSecondRealm();

    first.registerExtensionOperator('embeddingSimilar', op);

    // Under two registries this second call would succeed, leaving two
    // definitions live under one name depending on which copy you asked.
    expect(() => second.registerExtensionOperator('embeddingSimilar', op)).toThrow(
      /already registered/
    );
  });

  it('clear from either realm clears the shared store', async () => {
    const second = await loadSecondRealm();

    first.registerExtensionOperator('embeddingSimilar', op);
    second.clearExtensionOperators();

    expect(first.getExtensionOperator('embeddingSimilar')).toBeUndefined();
    expect(first.listExtensionOperators()).toEqual([]);
  });

  it('backs the store on globalThis under the documented symbols', () => {
    first.registerExtensionOperator('embeddingSimilar', semanticOp);

    // Documented so an operator debugging a split can find the store from a
    // REPL without importing the module they suspect of being duplicated.
    const host = globalThis as unknown as Record<symbol, Map<string, unknown> | undefined>;
    const registry = host[Symbol.for('substrate.filter.extensionOperators.v1')];
    const owners = host[Symbol.for('substrate.filter.computedFieldOwners.v1')];

    expect(registry?.get('embeddingSimilar')).toBe(semanticOp);
    expect(owners?.get('_score')).toBe('embeddingSimilar');
  });

  it('does not collide with a differently-versioned key', () => {
    // The version suffix is what keeps a future FilterOperatorDef shape change
    // from handing a v1 record to a reader expecting v2. Two incompatible
    // copies must fall back to two registries rather than to one wrong one.
    first.registerExtensionOperator('embeddingSimilar', op);

    const host = globalThis as unknown as Record<symbol, Map<string, unknown> | undefined>;
    expect(host[Symbol.for('substrate.filter.extensionOperators.v2')]).toBeUndefined();
  });
});
