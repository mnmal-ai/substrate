import type { FieldDef } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { mutationReturns } from '../src/mutation-returns.js';

const s = (type: 'string' | 'number'): FieldDef => ({ kind: 'scalar', type });
const row: FieldDef = {
  kind: 'struct',
  fields: {
    id: s('string'),
    shortId: s('number'),
    title: s('string'),
    owner: { kind: 'struct', fields: { name: s('string'), age: s('number') } }
  }
};
const keys = (def: FieldDef): unknown =>
  def.kind === 'struct'
    ? Object.fromEntries(Object.entries(def.fields).map(([k, v]) => [k, keys(v)]))
    : def.kind === 'list'
      ? [keys(def.of)]
      : def.kind;

describe('mutationReturns', () => {
  it('a row write with no fields narrows to { id, shortId }', () => {
    expect(keys(mutationReturns({ returns: row, writesRows: true }, undefined))).toEqual({
      id: 'scalar',
      shortId: 'scalar'
    });
  });

  it('any other mutation with no fields keeps its whole returns', () => {
    expect(mutationReturns({ returns: row }, undefined)).toBe(row);
  });

  it('fields: true keeps the whole returns, even for a row write', () => {
    expect(mutationReturns({ returns: row, writesRows: true }, true)).toBe(row);
  });

  it('a nested selection narrows the nested struct, in declared order', () => {
    expect(keys(mutationReturns({ returns: row }, { owner: { age: true }, id: true }))).toEqual({
      id: 'scalar',
      owner: { age: 'scalar' }
    });
  });

  it('a list narrows its element; an undeclared field is dropped', () => {
    const list: FieldDef = { kind: 'list', of: row };
    expect(keys(mutationReturns({ returns: list }, { title: true, nope: true }))).toEqual([
      { title: 'scalar' }
    ]);
  });
});
