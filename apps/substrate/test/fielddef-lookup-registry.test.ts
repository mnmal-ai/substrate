/**
 * The production FieldDefLookup resolves fields of types and fields proposed at
 * runtime from the live registry. Without it a `_walk` `out` over a proposed
 * crossRef throws `walk 'out' … is not a crossRef`, and a pending number field
 * sorts as text.
 */

import { Registry } from '@mnmal-ai/substrate-core';
import { describe, expect, it } from 'vitest';
import { makeFieldDefLookupFactory } from '../src/serve/wiring.js';

const noopResolver = async (): Promise<null> => null;

describe('makeFieldDefLookupFactory', () => {
  const owner = { kind: 'crossRef', ns: 'app', type: 'Person', onDelete: 'set_null' } as const;
  const rank = { kind: 'scalar', type: 'number' } as const;
  const registry = new Registry();
  registry.register('Task', { resolver: noopResolver, kind: 'type', fields: { owner, rank } });
  const nsDefs = new Map();

  it('resolves a proposed type’s fields from the registry', () => {
    const lookup = makeFieldDefLookupFactory(nsDefs, () => registry)('app');
    expect(lookup('Task', 'owner')).toEqual(owner);
    expect(lookup('Task', 'rank')).toEqual(rank);
    expect(lookup('Task', 'missing')).toBeUndefined();
    expect(lookup('Nope', 'owner')).toBeUndefined();
  });

  it('prefers the declared field over the registry’s', () => {
    const declared = { kind: 'scalar', type: 'string' } as const;
    const defs = new Map([['app', { types: { Task: { fields: { rank: declared } } } }]]);
    const lookup = makeFieldDefLookupFactory(defs as never, () => registry)('app');
    expect(lookup('Task', 'rank')).toEqual(declared);
    expect(lookup('Task', 'owner')).toEqual(owner);
  });

  it('answers undefined before the engine exists', () => {
    expect(
      makeFieldDefLookupFactory(nsDefs, () => undefined)('app')('Task', 'owner')
    ).toBeUndefined();
  });
});
