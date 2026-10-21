import type { FieldDef, Schema } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { decodePositional, decodePositionalFromFieldDef, PackDecodeError } from '../src/decoder.js';

function schemaWith(types: Schema['types']): Schema {
  return { schemaVersion: 'test000000aa', types, mutations: {} };
}

describe('decodePositional — scalar rows', () => {
  it('rebuilds a named object from a positional tuple', () => {
    const schema = schemaWith({
      Todo: {
        fields: {
          id: { kind: 'scalar', type: 'string' },
          title: { kind: 'scalar', type: 'string' }
        }
      }
    });
    const out = decodePositional(['1', 'x'], { id: true, title: true }, schema, 'Todo', {
      currentNs: 'default'
    });
    expect(out).toEqual({ id: '1', title: 'x' });
  });

  it('null input returns null', () => {
    const schema = schemaWith({ Todo: { fields: { id: { kind: 'scalar', type: 'number' } } } });
    expect(decodePositional(null, { id: true }, schema, 'Todo', { currentNs: 'default' })).toBe(
      null
    );
  });

  it('decodes a list of tuples based on arity heuristic', () => {
    const schema = schemaWith({
      Todo: {
        fields: {
          id: { kind: 'scalar', type: 'number' },
          title: { kind: 'scalar', type: 'string' }
        }
      }
    });
    const out = decodePositional(
      [
        [1, 'a'],
        [2, 'b']
      ],
      { id: true, title: true },
      schema,
      'Todo',
      { currentNs: 'default' }
    );
    expect(out).toEqual([
      { id: 1, title: 'a' },
      { id: 2, title: 'b' }
    ]);
  });
});

describe('decodePositional — nested struct', () => {
  it('rebuilds a nested struct', () => {
    const schema = schemaWith({
      Invoice: {
        fields: {
          id: { kind: 'scalar', type: 'string' },
          total: {
            kind: 'struct',
            fields: {
              amount: { kind: 'scalar', type: 'number' },
              currency: { kind: 'scalar', type: 'string' }
            }
          }
        }
      }
    });
    const out = decodePositional(
      ['inv1', [29.99, 'USD']],
      { id: true, total: { amount: true, currency: true } },
      schema,
      'Invoice',
      { currentNs: 'default' }
    );
    expect(out).toEqual({ id: 'inv1', total: { amount: 29.99, currency: 'USD' } });
  });
});

describe('decodePositional — list of structs', () => {
  it('rebuilds a list-of-structs field', () => {
    const schema = schemaWith({
      Doc: {
        fields: {
          id: { kind: 'scalar', type: 'number' },
          tags: {
            kind: 'list',
            of: {
              kind: 'struct',
              fields: {
                k: { kind: 'scalar', type: 'string' },
                v: { kind: 'scalar', type: 'string' }
              }
            }
          }
        }
      }
    });
    const out = decodePositional(
      [
        7,
        [
          ['a', '1'],
          ['b', '2']
        ]
      ],
      { id: true, tags: { k: true, v: true } },
      schema,
      'Doc',
      { currentNs: 'default' }
    );
    expect(out).toEqual({
      id: 7,
      tags: [
        { k: 'a', v: '1' },
        { k: 'b', v: '2' }
      ]
    });
  });
});

describe('decodePositional — crossRef', () => {
  it('follows a cross-namespace crossRef into the target schema', () => {
    const productSchema: Schema = {
      schemaVersion: 'product00000',
      types: {
        Product: {
          fields: {
            id: { kind: 'scalar', type: 'number' },
            price: { kind: 'crossRef', ns: 'prices', type: 'Price', onDelete: 'set_null' }
          }
        }
      },
      mutations: {}
    };
    const priceSchema: Schema = {
      schemaVersion: 'price000000a',
      types: {
        Price: {
          fields: {
            amount: { kind: 'scalar', type: 'number' },
            currency: { kind: 'scalar', type: 'string' }
          }
        }
      },
      mutations: {}
    };
    const out = decodePositional(
      [1, [29.99, 'USD']],
      { id: true, price: { amount: true, currency: true } },
      productSchema,
      'Product',
      { currentNs: 'catalog', schemas: { catalog: productSchema, prices: priceSchema } }
    );
    expect(out).toEqual({ id: 1, price: { amount: 29.99, currency: 'USD' } });
  });
});

describe('decodePositional — error paths', () => {
  it('throws when a tuple is expected but a non-array is given', () => {
    const schema = schemaWith({
      Todo: { fields: { id: { kind: 'scalar', type: 'number' } } }
    });
    expect(() =>
      decodePositional('not a tuple', { id: true }, schema, 'Todo', { currentNs: 'default' })
    ).toThrow(PackDecodeError);
  });
});

describe('decodePositionalFromFieldDef', () => {
  const schema: Schema = { schemaVersion: 'defdriven000', types: {}, mutations: {} };
  const ctx = { currentNs: 'default' };

  it('rebuilds a struct from a positional tuple', () => {
    const def: FieldDef = {
      kind: 'struct',
      fields: {
        id: { kind: 'scalar', type: 'string' },
        title: { kind: 'scalar', type: 'string' },
        done: { kind: 'scalar', type: 'boolean' }
      }
    };
    const out = decodePositionalFromFieldDef(['1', 'x', false], def, schema, ctx);
    expect(out).toEqual({ id: '1', title: 'x', done: false });
  });

  it('rebuilds a list of structs', () => {
    const def: FieldDef = {
      kind: 'list',
      of: {
        kind: 'struct',
        fields: {
          id: { kind: 'scalar', type: 'number' },
          label: { kind: 'scalar', type: 'string' }
        }
      }
    };
    const out = decodePositionalFromFieldDef(
      [
        [1, 'a'],
        [2, 'b']
      ],
      def,
      schema,
      ctx
    );
    expect(out).toEqual([
      { id: 1, label: 'a' },
      { id: 2, label: 'b' }
    ]);
  });

  it('null round-trips as null for a nullable struct', () => {
    const def: FieldDef = {
      kind: 'struct',
      fields: { id: { kind: 'scalar', type: 'string' } },
      nullable: true
    };
    expect(decodePositionalFromFieldDef(null, def, schema, ctx)).toBeNull();
  });

  it('crossRef field decodes as the raw id scalar', () => {
    const def: FieldDef = {
      kind: 'struct',
      fields: {
        id: { kind: 'scalar', type: 'string' },
        todoId: { kind: 'crossRef', ns: 'default', type: 'Todo', onDelete: 'set_null' }
      }
    };
    const out = decodePositionalFromFieldDef(['tag1', 't1'], def, schema, ctx);
    expect(out).toEqual({ id: 'tag1', todoId: 't1' });
  });

  it('missing trailing cells decode as null (tolerates short tuples)', () => {
    const def: FieldDef = {
      kind: 'struct',
      fields: {
        id: { kind: 'scalar', type: 'string' },
        title: { kind: 'scalar', type: 'string' }
      }
    };
    const out = decodePositionalFromFieldDef(['1'], def, schema, ctx);
    expect(out).toEqual({ id: '1', title: null });
  });
});
