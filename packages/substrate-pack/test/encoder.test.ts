import type { FieldDef, Schema } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { encodePositional, encodePositionalFromFieldDef, PackEncodeError } from '../src/encoder.js';

function schemaWith(types: Schema['types']): Schema {
  return { schemaVersion: 'test000000aa', types, mutations: {} };
}

describe('encodePositional — scalar rows', () => {
  it('emits a positional tuple for a scalar-only row', () => {
    const schema = schemaWith({
      Todo: {
        fields: {
          id: { kind: 'scalar', type: 'string' },
          title: { kind: 'scalar', type: 'string' }
        }
      }
    });
    const out = encodePositional(
      { id: '1', title: 'x' },
      { id: true, title: true },
      schema,
      'Todo',
      { currentNs: 'default' }
    );
    expect(out).toEqual(['1', 'x']);
  });

  it('preserves FieldInput iteration order, not row order', () => {
    const schema = schemaWith({
      Todo: {
        fields: {
          id: { kind: 'scalar', type: 'string' },
          title: { kind: 'scalar', type: 'string' }
        }
      }
    });
    const out = encodePositional(
      { title: 'x', id: '1' },
      { id: true, title: true },
      schema,
      'Todo',
      { currentNs: 'default' }
    );
    expect(out).toEqual(['1', 'x']);
  });

  it('emits null for missing or null scalar fields', () => {
    const schema = schemaWith({
      Todo: {
        fields: {
          id: { kind: 'scalar', type: 'number' },
          title: { kind: 'scalar', type: 'string' }
        }
      }
    });
    expect(
      encodePositional({ id: 2, title: null }, { id: true, title: true }, schema, 'Todo', {
        currentNs: 'default'
      })
    ).toEqual([2, null]);
    expect(
      encodePositional({ id: 3 }, { id: true, title: true }, schema, 'Todo', {
        currentNs: 'default'
      })
    ).toEqual([3, null]);
  });

  it('null input returns null (not a tuple)', () => {
    const schema = schemaWith({ Todo: { fields: { id: { kind: 'scalar', type: 'number' } } } });
    expect(encodePositional(null, { id: true }, schema, 'Todo', { currentNs: 'default' })).toBe(
      null
    );
  });

  it('array input emits an array of tuples', () => {
    const schema = schemaWith({
      Todo: {
        fields: {
          id: { kind: 'scalar', type: 'number' },
          title: { kind: 'scalar', type: 'string' }
        }
      }
    });
    const out = encodePositional(
      [
        { id: 1, title: 'a' },
        { id: 2, title: 'b' }
      ],
      { id: true, title: true },
      schema,
      'Todo',
      { currentNs: 'default' }
    );
    expect(out).toEqual([
      [1, 'a'],
      [2, 'b']
    ]);
  });

  it('empty array emits empty array', () => {
    const schema = schemaWith({ Todo: { fields: { id: { kind: 'scalar', type: 'number' } } } });
    expect(encodePositional([], { id: true }, schema, 'Todo', { currentNs: 'default' })).toEqual(
      []
    );
  });
});

describe('encodePositional — nested struct', () => {
  it('recurses into a struct field', () => {
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
    const out = encodePositional(
      { id: 'inv1', total: { amount: 29.99, currency: 'USD' } },
      { id: true, total: { amount: true, currency: true } },
      schema,
      'Invoice',
      { currentNs: 'default' }
    );
    expect(out).toEqual(['inv1', [29.99, 'USD']]);
  });

  it('null struct field emits null (not an empty tuple)', () => {
    const schema = schemaWith({
      Invoice: {
        fields: {
          id: { kind: 'scalar', type: 'string' },
          total: {
            kind: 'struct',
            fields: { amount: { kind: 'scalar', type: 'number' } }
          }
        }
      }
    });
    const out = encodePositional(
      { id: 'inv1', total: null },
      { id: true, total: { amount: true } },
      schema,
      'Invoice',
      { currentNs: 'default' }
    );
    expect(out).toEqual(['inv1', null]);
  });
});

describe('encodePositional — list of structs', () => {
  it('encodes a list of structs element-by-element', () => {
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
    const out = encodePositional(
      {
        id: 7,
        tags: [
          { k: 'a', v: '1' },
          { k: 'b', v: '2' }
        ]
      },
      { id: true, tags: { k: true, v: true } },
      schema,
      'Doc',
      { currentNs: 'default' }
    );
    expect(out).toEqual([
      7,
      [
        ['a', '1'],
        ['b', '2']
      ]
    ]);
  });

  it('list-of-scalar with `true` passes through as-is', () => {
    const schema = schemaWith({
      Doc: {
        fields: {
          id: { kind: 'scalar', type: 'number' },
          names: { kind: 'list', of: { kind: 'scalar', type: 'string' } }
        }
      }
    });
    const out = encodePositional(
      { id: 1, names: ['a', 'b', 'c'] },
      { id: true, names: true },
      schema,
      'Doc',
      { currentNs: 'default' }
    );
    expect(out).toEqual([1, ['a', 'b', 'c']]);
  });
});

describe('encodePositional — crossRef', () => {
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

    const out = encodePositional(
      { id: 1, price: { amount: 29.99, currency: 'USD' } },
      { id: true, price: { amount: true, currency: true } },
      productSchema,
      'Product',
      { currentNs: 'catalog', schemas: { catalog: productSchema, prices: priceSchema } }
    );
    expect(out).toEqual([1, [29.99, 'USD']]);
  });

  it('in-namespace crossRef stays on the current schema', () => {
    const schema = schemaWith({
      Parent: {
        fields: {
          id: { kind: 'scalar', type: 'number' },
          child: { kind: 'crossRef', ns: 'default', type: 'Child', onDelete: 'set_null' }
        }
      },
      Child: {
        fields: {
          name: { kind: 'scalar', type: 'string' }
        }
      }
    });
    const out = encodePositional(
      { id: 1, child: { name: 'kid' } },
      { id: true, child: { name: true } },
      schema,
      'Parent',
      { currentNs: 'default', schemas: { default: schema } }
    );
    expect(out).toEqual([1, ['kid']]);
  });

  it('throws when cross-namespace crossRef cannot find target schema', () => {
    const schema = schemaWith({
      Parent: {
        fields: {
          id: { kind: 'scalar', type: 'number' },
          other: { kind: 'crossRef', ns: 'elsewhere', type: 'Other', onDelete: 'set_null' }
        }
      }
    });
    expect(() =>
      encodePositional(
        { id: 1, other: { x: 1 } },
        { id: true, other: { x: true } },
        schema,
        'Parent',
        { currentNs: 'default', schemas: { default: schema } }
      )
    ).toThrow(PackEncodeError);
  });
});

describe('encodePositional — error paths', () => {
  it('throws when sub-fields are selected on a scalar', () => {
    const schema = schemaWith({
      Todo: { fields: { id: { kind: 'scalar', type: 'number' } } }
    });
    try {
      encodePositional(
        { id: 1 },
        // Selecting sub-fields of a scalar is a shape mismatch.
        { id: { nope: true } },
        schema,
        'Todo',
        { currentNs: 'default' }
      );
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PackEncodeError);
      if (e instanceof PackEncodeError) {
        expect(e.path).toEqual(['Todo', 'id']);
        expect(e.message).toContain('scalar');
      }
    }
  });

  it('treats inherited Object keys as undeclared, not as field defs or types', () => {
    const schema = schemaWith({
      Todo: { fields: { id: { kind: 'scalar', type: 'number' } } }
    });
    const out = encodePositional(
      { id: 1 },
      JSON.parse('{"id":true,"constructor":true,"toString":true,"__proto__":true}'),
      schema,
      'Todo',
      { currentNs: 'default' }
    );
    expect(out).toEqual([1, null, null, null]);
    expect(() =>
      encodePositional({ id: 1 }, { id: true }, schema, 'constructor', { currentNs: 'default' })
    ).toThrow(PackEncodeError);
  });

  it('throws for unknown type name in schema', () => {
    const schema = schemaWith({
      Todo: { fields: { id: { kind: 'scalar', type: 'number' } } }
    });
    expect(() =>
      encodePositional({ id: 1 }, { id: true }, schema, 'Unknown', { currentNs: 'default' })
    ).toThrow(PackEncodeError);
  });
});

describe('encodePositionalFromFieldDef', () => {
  const schema: Schema = { schemaVersion: 'defdriven000', types: {}, mutations: {} };
  const ctx = { currentNs: 'default' };

  it('encodes a struct positionally in declaration order', () => {
    const def: FieldDef = {
      kind: 'struct',
      fields: {
        id: { kind: 'scalar', type: 'string' },
        title: { kind: 'scalar', type: 'string' },
        done: { kind: 'scalar', type: 'boolean' }
      }
    };
    const out = encodePositionalFromFieldDef(
      { id: '1', title: 'x', done: false },
      def,
      schema,
      ctx
    );
    expect(out).toEqual(['1', 'x', false]);
  });

  it('encodes a list of structs', () => {
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
    const out = encodePositionalFromFieldDef(
      [
        { id: 1, label: 'a' },
        { id: 2, label: 'b' }
      ],
      def,
      schema,
      ctx
    );
    expect(out).toEqual([
      [1, 'a'],
      [2, 'b']
    ]);
  });

  it('nullable struct: null round-trips as null, not an empty tuple', () => {
    const def: FieldDef = {
      kind: 'struct',
      fields: { id: { kind: 'scalar', type: 'string' } },
      nullable: true
    };
    expect(encodePositionalFromFieldDef(null, def, schema, ctx)).toBeNull();
    // Non-null value still encodes normally.
    expect(encodePositionalFromFieldDef({ id: '1' }, def, schema, ctx)).toEqual(['1']);
  });

  it('crossRef in return shape encodes as the scalar id', () => {
    const def: FieldDef = {
      kind: 'struct',
      fields: {
        id: { kind: 'scalar', type: 'string' },
        todoId: { kind: 'crossRef', ns: 'default', type: 'Todo', onDelete: 'set_null' }
      }
    };
    const out = encodePositionalFromFieldDef({ id: 'tag1', todoId: 't1' }, def, schema, ctx);
    expect(out).toEqual(['tag1', 't1']);
  });

  it('delete return shape: { id, deleted } encodes positionally', () => {
    const def: FieldDef = {
      kind: 'struct',
      fields: {
        id: { kind: 'scalar', type: 'string' },
        deleted: { kind: 'scalar', type: 'boolean' }
      }
    };
    const out = encodePositionalFromFieldDef({ id: 't1', deleted: true }, def, schema, ctx);
    expect(out).toEqual(['t1', true]);
  });

  it('missing struct field emits null', () => {
    const def: FieldDef = {
      kind: 'struct',
      fields: {
        id: { kind: 'scalar', type: 'string' },
        title: { kind: 'scalar', type: 'string' }
      }
    };
    const out = encodePositionalFromFieldDef({ id: '1' }, def, schema, ctx);
    expect(out).toEqual(['1', null]);
  });
});
