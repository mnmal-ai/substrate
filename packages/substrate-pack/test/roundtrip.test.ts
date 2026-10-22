import type { FieldDef, FieldInput, PackEnvelope, Schema } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { decodeEnvelope } from '../src/decoder.js';
import { encodeEnvelope } from '../src/encoder.js';

interface Scenario {
  schema: Schema;
  schemas: Record<string, Schema>;
  fieldsByKey: Record<string, FieldInput>;
  typeByKey: Record<string, string>;
  currentNsByKey: Record<string, string>;
}

function buildScenario(): Scenario {
  const schema: Schema = {
    schemaVersion: 'roundtrip001',
    types: {
      Todo: {
        fields: {
          id: { kind: 'scalar', type: 'string' },
          title: { kind: 'scalar', type: 'string' },
          done: { kind: 'scalar', type: 'boolean' },
          tags: {
            kind: 'list',
            of: {
              kind: 'struct',
              fields: {
                k: { kind: 'scalar', type: 'string' },
                v: { kind: 'scalar', type: 'string' }
              }
            }
          },
          createdAt: { kind: 'scalar', type: 'date' }
        }
      }
    },
    mutations: {}
  };
  return {
    schema,
    schemas: { default: schema },
    fieldsByKey: {
      'default/Todo': {
        id: true,
        title: true,
        done: true,
        tags: { k: true, v: true },
        createdAt: true
      }
    },
    typeByKey: { 'default/Todo': 'Todo' },
    currentNsByKey: { 'default/Todo': 'default' }
  };
}

describe('envelope roundtrip', () => {
  it('roundtrips a list envelope', () => {
    const s = buildScenario();
    const env: PackEnvelope = {
      schemaVersion: s.schema.schemaVersion,
      data: {
        'default/Todo': [
          { id: '1', title: 'a', done: false, tags: [{ k: 't', v: '1' }], createdAt: null },
          { id: '2', title: 'b', done: true, tags: [], createdAt: null }
        ]
      },
      shapes: { 'default/Todo': 'list' }
    };
    const bytes = encodeEnvelope(env, {
      fieldsByKey: s.fieldsByKey,
      typeByKey: s.typeByKey,
      schemas: s.schemas,
      currentNsByKey: s.currentNsByKey
    });
    const decoded = decodeEnvelope(bytes, {
      fieldsByKey: s.fieldsByKey,
      typeByKey: s.typeByKey,
      schemas: s.schemas,
      currentNsByKey: s.currentNsByKey
    });
    expect(decoded.schemaVersion).toBe(env.schemaVersion);
    expect(decoded.shapes).toEqual(env.shapes);
    expect(decoded.data).toEqual(env.data);
  });

  it('roundtrips a single envelope', () => {
    const s = buildScenario();
    const env: PackEnvelope = {
      schemaVersion: s.schema.schemaVersion,
      data: {
        'default/Todo': {
          id: '1',
          title: 'only',
          done: false,
          tags: [],
          createdAt: null
        }
      },
      shapes: { 'default/Todo': 'single' }
    };
    const bytes = encodeEnvelope(env, {
      fieldsByKey: s.fieldsByKey,
      typeByKey: s.typeByKey,
      schemas: s.schemas,
      currentNsByKey: s.currentNsByKey
    });
    const decoded = decodeEnvelope(bytes, {
      fieldsByKey: s.fieldsByKey,
      typeByKey: s.typeByKey,
      schemas: s.schemas,
      currentNsByKey: s.currentNsByKey
    });
    expect(decoded.data).toEqual(env.data);
    expect(decoded.shapes).toEqual(env.shapes);
  });

  it('roundtrips an empty-list envelope', () => {
    const s = buildScenario();
    const env: PackEnvelope = {
      schemaVersion: s.schema.schemaVersion,
      data: { 'default/Todo': [] },
      shapes: { 'default/Todo': 'list' }
    };
    const bytes = encodeEnvelope(env, {
      fieldsByKey: s.fieldsByKey,
      typeByKey: s.typeByKey,
      schemas: s.schemas,
      currentNsByKey: s.currentNsByKey
    });
    const decoded = decodeEnvelope(bytes, {
      fieldsByKey: s.fieldsByKey,
      typeByKey: s.typeByKey,
      schemas: s.schemas,
      currentNsByKey: s.currentNsByKey
    });
    expect(decoded.data['default/Todo']).toEqual([]);
  });

  it('roundtrips a null-data envelope', () => {
    const s = buildScenario();
    const env: PackEnvelope = {
      schemaVersion: s.schema.schemaVersion,
      data: { 'default/Todo': null },
      shapes: { 'default/Todo': 'single' }
    };
    const bytes = encodeEnvelope(env, {
      fieldsByKey: s.fieldsByKey,
      typeByKey: s.typeByKey,
      schemas: s.schemas,
      currentNsByKey: s.currentNsByKey
    });
    const decoded = decodeEnvelope(bytes, {
      fieldsByKey: s.fieldsByKey,
      typeByKey: s.typeByKey,
      schemas: s.schemas,
      currentNsByKey: s.currentNsByKey
    });
    expect(decoded.data['default/Todo']).toBeNull();
  });

  it('roundtrips errors + _meta + _pagination unchanged', () => {
    const s = buildScenario();
    const env: PackEnvelope = {
      schemaVersion: s.schema.schemaVersion,
      data: { 'default/Todo': [] },
      shapes: { 'default/Todo': 'list' },
      errors: [{ message: 'something', code: 'example_code', path: ['default/Todo'] }],
      _meta: { serverTime: '2026-04-18T12:00:00Z', warn: 'demo' },
      _pagination: { 'default/Todo': { nextCursor: 'abc', hasMore: true } }
    };
    const bytes = encodeEnvelope(env, {
      fieldsByKey: s.fieldsByKey,
      typeByKey: s.typeByKey,
      schemas: s.schemas,
      currentNsByKey: s.currentNsByKey
    });
    const decoded = decodeEnvelope(bytes, {
      fieldsByKey: s.fieldsByKey,
      typeByKey: s.typeByKey,
      schemas: s.schemas,
      currentNsByKey: s.currentNsByKey
    });
    expect(decoded.errors).toEqual(env.errors);
    expect(decoded._meta).toEqual(env._meta);
    expect(decoded._pagination).toEqual(env._pagination);
  });

  // The envelope is rebuilt field by field on both sides, so a sidecar with no
  // explicit passthrough is silently dropped. `_completeness` means "complete"
  // by its absence, which turns a dropped partial bridged read into a
  // confidently wrong one for any client negotiating substrate-pack.
  it('roundtrips _completeness unchanged', () => {
    const s = buildScenario();
    const env: PackEnvelope = {
      schemaVersion: s.schema.schemaVersion,
      data: { 'default/Todo': [] },
      shapes: { 'default/Todo': 'list' },
      _completeness: {
        'default/Todo': { complete: false, unreachable: ['peripheral-a'] }
      }
    };
    const bytes = encodeEnvelope(env, {
      fieldsByKey: s.fieldsByKey,
      typeByKey: s.typeByKey,
      schemas: s.schemas,
      currentNsByKey: s.currentNsByKey
    });
    const decoded = decodeEnvelope(bytes, {
      fieldsByKey: s.fieldsByKey,
      typeByKey: s.typeByKey,
      schemas: s.schemas,
      currentNsByKey: s.currentNsByKey
    });
    expect(decoded._completeness).toEqual(env._completeness);
  });

  // `_diagnostics` names projection keys the type does not declare; over pack
  // it was dropped, so a typo came back as `null` on every row, unflagged.
  it('roundtrips _diagnostics unchanged', () => {
    const s = buildScenario();
    const env: PackEnvelope = {
      schemaVersion: s.schema.schemaVersion,
      data: { 'default/Todo': [] },
      shapes: { 'default/Todo': 'list' },
      _diagnostics: { 'default/Todo': { unknownProjectionFields: ['titel'] } }
    };
    const ctx = {
      fieldsByKey: s.fieldsByKey,
      typeByKey: s.typeByKey,
      schemas: s.schemas,
      currentNsByKey: s.currentNsByKey
    };
    const decoded = decodeEnvelope(encodeEnvelope(env, ctx), ctx);
    expect(decoded._diagnostics).toEqual(env._diagnostics);
  });

  it('leaves _completeness absent when the source envelope had none', () => {
    const s = buildScenario();
    const env: PackEnvelope = {
      schemaVersion: s.schema.schemaVersion,
      data: { 'default/Todo': [] },
      shapes: { 'default/Todo': 'list' }
    };
    const bytes = encodeEnvelope(env, {
      fieldsByKey: s.fieldsByKey,
      typeByKey: s.typeByKey,
      schemas: s.schemas,
      currentNsByKey: s.currentNsByKey
    });
    const decoded = decodeEnvelope(bytes, {
      fieldsByKey: s.fieldsByKey,
      typeByKey: s.typeByKey,
      schemas: s.schemas,
      currentNsByKey: s.currentNsByKey
    });
    expect(decoded._completeness).toBeUndefined();
  });

  it('empty data object decodes to empty object', () => {
    const s = buildScenario();
    const env: PackEnvelope = {
      schemaVersion: s.schema.schemaVersion,
      data: {},
      shapes: {}
    };
    const bytes = encodeEnvelope(env, {
      fieldsByKey: {},
      typeByKey: {},
      schemas: s.schemas,
      currentNsByKey: {}
    });
    const decoded = decodeEnvelope(bytes, {
      fieldsByKey: {},
      typeByKey: {},
      schemas: s.schemas,
      currentNsByKey: {}
    });
    expect(decoded.data).toEqual({});
    expect(decoded.shapes).toEqual({});
  });

  it('mutation data encodes positionally via returnsByKey (FieldDef-driven)', () => {
    const s = buildScenario();
    const todoFields = s.schema.types.Todo?.fields ?? {};
    const mutationSchema: Schema = {
      schemaVersion: s.schema.schemaVersion,
      types: s.schema.types,
      mutations: {
        createTodo: {
          params: todoFields,
          returns: { kind: 'struct', fields: todoFields }
        }
      }
    };
    const env: PackEnvelope = {
      schemaVersion: mutationSchema.schemaVersion,
      data: {
        'default/createTodo': { id: 'new', title: 't', done: false, tags: [], createdAt: null }
      },
      shapes: { 'default/createTodo': 'single' }
    };
    const returnsByKey = {
      'default/createTodo': mutationSchema.mutations.createTodo?.returns
    } as Record<string, FieldDef>;
    const currentNsByKey = { 'default/createTodo': 'default' };
    const bytes = encodeEnvelope(env, {
      fieldsByKey: {},
      typeByKey: {},
      schemas: { default: mutationSchema },
      currentNsByKey,
      returnsByKey
    });
    const decoded = decodeEnvelope(bytes, {
      fieldsByKey: {},
      typeByKey: {},
      schemas: { default: mutationSchema },
      currentNsByKey,
      returnsByKey
    });
    // Decoded data is named-object form again — the positional tuple is an
    // implementation detail of the wire. The roundtrip is the contract.
    expect(decoded.data['default/createTodo']).toEqual(env.data['default/createTodo']);

    // Sanity: decoding with an empty returnsByKey leaves the positional tuple
    // raw on the wire — confirming the encoder DID emit a tuple, not a named
    // object.
    const raw = decodeEnvelope(bytes, {
      fieldsByKey: {},
      typeByKey: {},
      schemas: {},
      currentNsByKey: {}
    });
    expect(Array.isArray(raw.data['default/createTodo'])).toBe(true);
  });

  it('Date scalars round-trip through msgpack', () => {
    const schema: Schema = {
      schemaVersion: 'dateroundtrip',
      types: {
        Event: {
          fields: {
            id: { kind: 'scalar', type: 'number' },
            at: { kind: 'scalar', type: 'date' }
          }
        }
      },
      mutations: {}
    };
    const when = new Date('2026-04-18T12:34:56.000Z');
    const env: PackEnvelope = {
      schemaVersion: schema.schemaVersion,
      data: { 'default/Event': { id: 1, at: when } },
      shapes: { 'default/Event': 'single' }
    };
    const ctx = {
      fieldsByKey: { 'default/Event': { id: true, at: true } as FieldInput },
      typeByKey: { 'default/Event': 'Event' },
      schemas: { default: schema },
      currentNsByKey: { 'default/Event': 'default' }
    };
    const bytes = encodeEnvelope(env, ctx);
    const decoded = decodeEnvelope(bytes, ctx);
    const got = decoded.data['default/Event'] as { id: number; at: Date };
    expect(got.id).toBe(1);
    // msgpackr emits the MessagePack timestamp extension for Date, so the
    // decoded value is a Date again with equal epoch ms.
    expect(got.at).toBeInstanceOf(Date);
    expect((got.at as Date).getTime()).toBe(when.getTime());
  });
});
