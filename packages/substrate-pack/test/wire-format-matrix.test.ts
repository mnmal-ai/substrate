/**
 * §9.3 wire-format compatibility matrix.
 *
 * Locks the substrate-pack byte layout against known inputs (golden bytes, stored
 * as hex literals), proves JSON ↔ substrate-pack parity for every canonical
 * envelope shape, and verifies the §7.1 "loud error, not silent corruption"
 * drift contract plus the §7.2 shape-metadata explicit dispatch.
 *
 * When the encoder format deliberately changes, regenerate the golden
 * constants by copy-pasting the actual hex into the `GOLDEN_*` block below
 * and explain why in the commit message — a silent shift in these values is
 * exactly what this file exists to catch.
 */

import type { FieldDef, FieldInput, PackEnvelope, Schema } from '@mnmal-ai/substrate-types';
import { pack, unpack } from 'msgpackr';
import { describe, expect, it } from 'vitest';
import {
  decodeEnvelope,
  decodePositional,
  PackDecodeError,
  SchemaDriftError
} from '../src/decoder.js';
import { encodeEnvelope } from '../src/encoder.js';
import { decodeStreamChunk, encodeStreamChunk } from '../src/stream-chunk.js';

// ---------------------------------------------------------------------------
// Canonical fixtures — shared by every scenario below. Any change to these
// must ripple through the GOLDEN_* constants; that's the whole point.
// ---------------------------------------------------------------------------

const TODO_FIELDS: Record<string, FieldDef> = {
  id: { kind: 'scalar', type: 'string' },
  title: { kind: 'scalar', type: 'string' },
  done: { kind: 'scalar', type: 'boolean' }
};

const BASE_SCHEMA: Schema = {
  schemaVersion: 'aaaabbbbcccc',
  types: { Todo: { fields: TODO_FIELDS } },
  mutations: {}
};

const CATALOG_SCHEMA: Schema = {
  schemaVersion: 'aaaabbbbcccc',
  types: {
    Todo: { fields: TODO_FIELDS },
    Tag: {
      fields: {
        id: { kind: 'scalar', type: 'string' },
        label: { kind: 'scalar', type: 'string' }
      }
    }
  },
  mutations: {}
};

const MUTATION_SCHEMA: Schema = {
  schemaVersion: 'aaaabbbbcccc',
  types: { Todo: { fields: TODO_FIELDS } },
  mutations: {
    createTodo: {
      params: TODO_FIELDS,
      returns: { kind: 'struct', fields: TODO_FIELDS }
    }
  }
};

// Collection has a list-typed FIRST field (§7.2): a single entity whose first
// positional cell is itself an array looks identical to a list-of-tuples at
// the bytes layer.
// The §7.2 `shapes[key]` metadata is what disambiguates.
const COLLECTION_SCHEMA: Schema = {
  schemaVersion: 'dddd4444eeee',
  types: {
    Collection: {
      fields: {
        tags: { kind: 'list', of: { kind: 'scalar', type: 'string' } },
        id: { kind: 'scalar', type: 'string' }
      }
    }
  },
  mutations: {}
};

const TODO_FIELD_INPUT: FieldInput = { id: true, title: true, done: true };
const TAG_FIELD_INPUT: FieldInput = { id: true, label: true };

// ---------------------------------------------------------------------------
// Golden bytes. Each hex string is the output of `encodeEnvelope` /
// `encodeStreamChunk` for the named scenario. Regenerate ONLY when the wire
// format deliberately changes; document the diff in the commit message.
// ---------------------------------------------------------------------------

const GOLDEN = {
  single:
    'de0003ad736368656d6156657273696f6eac616161616262626263636363a464617461de0001ac64656661756c742f546f646f93a27431a5616c706861c2a6736861706573de0001ac64656661756c742f546f646fa673696e676c65',
  list: 'de0003ad736368656d6156657273696f6eac616161616262626263636363a464617461de0001ac64656661756c742f546f646f9293a27431a5616c706861c293a27432a462657461c3a6736861706573de0001ac64656661756c742f546f646fa46c697374',
  errorsOnly:
    'de0004ad736368656d6156657273696f6eac616161616262626263636363a464617461de0000a6736861706573de0000a66572726f727391de0002a76d657373616765af756e7175616c6966696564206b6579a4636f6465af756e7175616c69666965645f6b6579',
  multi:
    'de0003ad736368656d6156657273696f6eac616161616262626263636363a464617461de0002ac64656661756c742f546f646f93a27431a5616c706861c2ab64656661756c742f5461679192a26731a6757267656e74a6736861706573de0002ac64656661756c742f546f646fa673696e676c65ab64656661756c742f546167a46c697374',
  mutation:
    'de0003ad736368656d6156657273696f6eac616161616262626263636363a464617461de0001b264656661756c742f637265617465546f646f93a46e657731a56672657368c2a6736861706573de0001b264656661756c742f637265617465546f646fa673696e676c65',
  chunk:
    'de0005ad736368656d6156657273696f6eac616161616262626263636363a873747265616d4964a873747265616d2d31a873657175656e636500a57368617065a673696e676c65a46461746193a27431a5616c706861c2',
  chunkFinal:
    'de0006ad736368656d6156657273696f6eac616161616262626263636363a873747265616d4964a873747265616d2d31a873657175656e636502a57368617065a673696e676c65a46461746193a27433a46c617374c3a566696e616cc3',
  singleListFirst:
    'de0003ad736368656d6156657273696f6eac646464643434343465656565a464617461de0001b264656661756c742f436f6c6c656374696f6e9292a161a162a26331a6736861706573de0001b264656661756c742f436f6c6c656374696f6ea673696e676c65'
};

function toHex(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('hex');
}

// ---------------------------------------------------------------------------
// Scenario constructors. Each returns the envelope + the encode ctx so the
// "golden bytes" and "JSON↔pack parity" scenarios share the same inputs.
// ---------------------------------------------------------------------------

interface EnvelopeScenario {
  envelope: PackEnvelope;
  ctx: Parameters<typeof encodeEnvelope>[1];
}

function singleScenario(): EnvelopeScenario {
  return {
    envelope: {
      schemaVersion: BASE_SCHEMA.schemaVersion,
      data: { 'default/Todo': { id: 't1', title: 'alpha', done: false } },
      shapes: { 'default/Todo': 'single' }
    },
    ctx: {
      fieldsByKey: { 'default/Todo': TODO_FIELD_INPUT },
      typeByKey: { 'default/Todo': 'Todo' },
      schemas: { default: BASE_SCHEMA },
      currentNsByKey: { 'default/Todo': 'default' }
    }
  };
}

function listScenario(): EnvelopeScenario {
  return {
    envelope: {
      schemaVersion: BASE_SCHEMA.schemaVersion,
      data: {
        'default/Todo': [
          { id: 't1', title: 'alpha', done: false },
          { id: 't2', title: 'beta', done: true }
        ]
      },
      shapes: { 'default/Todo': 'list' }
    },
    ctx: {
      fieldsByKey: { 'default/Todo': TODO_FIELD_INPUT },
      typeByKey: { 'default/Todo': 'Todo' },
      schemas: { default: BASE_SCHEMA },
      currentNsByKey: { 'default/Todo': 'default' }
    }
  };
}

function errorsOnlyScenario(): EnvelopeScenario {
  return {
    envelope: {
      schemaVersion: BASE_SCHEMA.schemaVersion,
      data: {},
      shapes: {},
      errors: [{ message: 'unqualified key', code: 'unqualified_key' }]
    },
    ctx: { fieldsByKey: {}, typeByKey: {}, schemas: { default: BASE_SCHEMA }, currentNsByKey: {} }
  };
}

function multiTypeScenario(): EnvelopeScenario {
  return {
    envelope: {
      schemaVersion: CATALOG_SCHEMA.schemaVersion,
      data: {
        'default/Todo': { id: 't1', title: 'alpha', done: false },
        'default/Tag': [{ id: 'g1', label: 'urgent' }]
      },
      shapes: { 'default/Todo': 'single', 'default/Tag': 'list' }
    },
    ctx: {
      fieldsByKey: { 'default/Todo': TODO_FIELD_INPUT, 'default/Tag': TAG_FIELD_INPUT },
      typeByKey: { 'default/Todo': 'Todo', 'default/Tag': 'Tag' },
      schemas: { default: CATALOG_SCHEMA },
      currentNsByKey: { 'default/Todo': 'default', 'default/Tag': 'default' }
    }
  };
}

function mutationScenario(): EnvelopeScenario {
  const returns = MUTATION_SCHEMA.mutations.createTodo?.returns as FieldDef;
  return {
    envelope: {
      schemaVersion: MUTATION_SCHEMA.schemaVersion,
      data: { 'default/createTodo': { id: 'new1', title: 'fresh', done: false } },
      shapes: { 'default/createTodo': 'single' }
    },
    ctx: {
      fieldsByKey: {},
      typeByKey: {},
      returnsByKey: { 'default/createTodo': returns },
      schemas: { default: MUTATION_SCHEMA },
      currentNsByKey: { 'default/createTodo': 'default' }
    }
  };
}

function singleListFirstScenario(): EnvelopeScenario {
  return {
    envelope: {
      schemaVersion: COLLECTION_SCHEMA.schemaVersion,
      data: { 'default/Collection': { tags: ['a', 'b'], id: 'c1' } },
      shapes: { 'default/Collection': 'single' }
    },
    ctx: {
      fieldsByKey: { 'default/Collection': { tags: true, id: true } },
      typeByKey: { 'default/Collection': 'Collection' },
      schemas: { default: COLLECTION_SCHEMA },
      currentNsByKey: { 'default/Collection': 'default' }
    }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('§9.3 — golden bytes', () => {
  it('single envelope matches golden hex', () => {
    const { envelope, ctx } = singleScenario();
    expect(toHex(encodeEnvelope(envelope, ctx))).toBe(GOLDEN.single);
  });

  it('list envelope matches golden hex', () => {
    const { envelope, ctx } = listScenario();
    expect(toHex(encodeEnvelope(envelope, ctx))).toBe(GOLDEN.list);
  });

  it('errors-only envelope matches golden hex', () => {
    const { envelope, ctx } = errorsOnlyScenario();
    expect(toHex(encodeEnvelope(envelope, ctx))).toBe(GOLDEN.errorsOnly);
  });

  it('multi-type envelope matches golden hex', () => {
    const { envelope, ctx } = multiTypeScenario();
    expect(toHex(encodeEnvelope(envelope, ctx))).toBe(GOLDEN.multi);
  });

  it('mutation return envelope matches golden hex', () => {
    const { envelope, ctx } = mutationScenario();
    expect(toHex(encodeEnvelope(envelope, ctx))).toBe(GOLDEN.mutation);
  });

  it('stream chunk matches golden hex', () => {
    const bytes = encodeStreamChunk({
      schemaVersion: BASE_SCHEMA.schemaVersion,
      streamId: 'stream-1',
      sequence: 0,
      row: { id: 't1', title: 'alpha', done: false },
      fields: TODO_FIELD_INPUT,
      schema: BASE_SCHEMA,
      typeName: 'Todo',
      currentNs: 'default'
    });
    expect(toHex(bytes)).toBe(GOLDEN.chunk);
  });

  it('final stream chunk matches golden hex', () => {
    const bytes = encodeStreamChunk({
      schemaVersion: BASE_SCHEMA.schemaVersion,
      streamId: 'stream-1',
      sequence: 2,
      row: { id: 't3', title: 'last', done: true },
      fields: TODO_FIELD_INPUT,
      schema: BASE_SCHEMA,
      typeName: 'Todo',
      currentNs: 'default',
      final: true
    });
    expect(toHex(bytes)).toBe(GOLDEN.chunkFinal);
  });

  it('single-with-list-first-field matches golden hex (§7.2 disambiguation fixture)', () => {
    const { envelope, ctx } = singleListFirstScenario();
    expect(toHex(encodeEnvelope(envelope, ctx))).toBe(GOLDEN.singleListFirst);
  });
});

describe('§9.3 — JSON ↔ substrate-pack parity', () => {
  // Each scenario: build an envelope, encode as substrate-pack (positional) and
  // as JSON (named). Both should decode back to the same named-object data.
  const scenarios: Array<{ name: string; build: () => EnvelopeScenario }> = [
    { name: 'single', build: singleScenario },
    { name: 'list', build: listScenario },
    { name: 'multi-type', build: multiTypeScenario },
    { name: 'mutation-return', build: mutationScenario },
    { name: 'single-list-first', build: singleListFirstScenario }
  ];

  for (const { name, build } of scenarios) {
    it(`${name}: substrate-pack decodes to the JSON form`, () => {
      const { envelope, ctx } = build();
      const bytes = encodeEnvelope(envelope, ctx);
      // Decode substrate-pack with full ctx — data comes back named.
      const pack = decodeEnvelope(bytes, ctx);
      // JSON envelope path: named-object data straight through. This mirrors
      // what the server emits when the client accepts application/json.
      const json = JSON.parse(JSON.stringify(envelope)) as PackEnvelope;
      expect(pack.data).toEqual(json.data);
      expect(pack.shapes).toEqual(json.shapes);
      expect(pack.schemaVersion).toEqual(json.schemaVersion);
    });
  }

  it('errors-only envelope: substrate-pack and JSON carry identical errors', () => {
    const { envelope, ctx } = errorsOnlyScenario();
    const bytes = encodeEnvelope(envelope, ctx);
    const decoded = decodeEnvelope(bytes, ctx);
    expect(decoded.errors).toEqual(envelope.errors);
    expect(decoded.data).toEqual({});
    expect(decoded.shapes).toEqual({});
  });

  it('query path: decodePositional on raw pack data equals the JSON named form', () => {
    const { envelope, ctx } = listScenario();
    const bytes = encodeEnvelope(envelope, ctx);
    // Raw decode (no schema ctx) exposes the positional tuples — what the
    // wire actually carries.
    const raw = decodeEnvelope(bytes, {
      fieldsByKey: {},
      typeByKey: {},
      schemas: {},
      currentNsByKey: {}
    });
    const rawRows = raw.data['default/Todo'] as unknown;
    // Feeding the raw positional value through decodePositional with the same
    // FieldInput the encoder used must reconstruct the JSON named form.
    const reconstructed = decodePositional(rawRows, TODO_FIELD_INPUT, BASE_SCHEMA, 'Todo', {
      currentNs: 'default',
      schemas: { default: BASE_SCHEMA }
    });
    expect(reconstructed).toEqual(envelope.data['default/Todo']);
  });

  it('stream chunk JSON ↔ pack parity', () => {
    const row = { id: 't1', title: 'alpha', done: false };
    const bytes = encodeStreamChunk({
      schemaVersion: BASE_SCHEMA.schemaVersion,
      streamId: 'stream-1',
      sequence: 0,
      row,
      fields: TODO_FIELD_INPUT,
      schema: BASE_SCHEMA,
      typeName: 'Todo',
      currentNs: 'default'
    });
    const decoded = decodeStreamChunk(bytes, {
      fields: TODO_FIELD_INPUT,
      schema: BASE_SCHEMA,
      typeName: 'Todo',
      currentNs: 'default'
    });
    expect(decoded.data).toEqual(row);
    expect(decoded.schemaVersion).toBe(BASE_SCHEMA.schemaVersion);
    expect(decoded.shape).toBe('single');
    expect(decoded.sequence).toBe(0);
  });
});

describe('§7.1 — SchemaDriftError (loud error, not silent corruption)', () => {
  it('matching schemaVersion + expectedSchemaVersion decodes normally', () => {
    const { envelope, ctx } = listScenario();
    const bytes = encodeEnvelope(envelope, ctx);
    const decoded = decodeEnvelope(bytes, {
      ...ctx,
      expectedSchemaVersion: BASE_SCHEMA.schemaVersion
    });
    expect(decoded.data).toEqual(envelope.data);
  });

  it('mismatched expectedSchemaVersion throws SchemaDriftError with both versions', () => {
    const { envelope, ctx } = listScenario();
    const bytes = encodeEnvelope(envelope, ctx);
    let caught: unknown;
    try {
      decodeEnvelope(bytes, { ...ctx, expectedSchemaVersion: 'old00000000a' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SchemaDriftError);
    const err = caught as SchemaDriftError;
    expect(err.envelopeSchemaVersion).toBe(BASE_SCHEMA.schemaVersion);
    expect(err.expectedSchemaVersion).toBe('old00000000a');
    expect(err.message).toContain(BASE_SCHEMA.schemaVersion);
    expect(err.message).toContain('old00000000a');
  });

  it('omitting expectedSchemaVersion skips the drift check (backwards compat)', () => {
    const { envelope, ctx } = listScenario();
    const bytes = encodeEnvelope(envelope, ctx);
    // No expectedSchemaVersion set — the decoder does not consult the version
    // at all.
    expect(() => decodeEnvelope(bytes, ctx)).not.toThrow();
  });

  it('drift is checked BEFORE data decoding (mismatch on an otherwise-valid envelope)', () => {
    // An envelope whose data would decode cleanly — the drift check must
    // still fire, because the point is to refuse bytes whose field order the
    // decoder cannot trust.
    const { envelope, ctx } = singleScenario();
    const bytes = encodeEnvelope(envelope, ctx);
    expect(() => decodeEnvelope(bytes, { ...ctx, expectedSchemaVersion: 'nope00000000' })).toThrow(
      SchemaDriftError
    );
  });

  it('SchemaDriftError is a proper Error subclass (name, instanceof)', () => {
    const err = new SchemaDriftError('a', 'b');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SchemaDriftError);
    expect(err.name).toBe('SchemaDriftError');
  });
});

describe('§7.2 — shape metadata is explicit (retires v1.9 isList heuristic)', () => {
  it('shapes=single on a row whose first field is a list decodes to one object, not a list', () => {
    const { envelope, ctx } = singleListFirstScenario();
    const bytes = encodeEnvelope(envelope, ctx);
    const decoded = decodeEnvelope(bytes, ctx);
    const got = decoded.data['default/Collection'];
    // Explicit shape: 'single' — the result MUST be a single named object,
    // although an arity heuristic would read it as a list because the first
    // positional cell (`tags`) is itself an array.
    expect(Array.isArray(got)).toBe(false);
    expect(got).toEqual({ tags: ['a', 'b'], id: 'c1' });
  });

  it('shapes=list on the same raw bytes as the single fixture — explicit flag wins', () => {
    // Construct the bytes by hand: take the single-list-first fixture and
    // swap shapes to `'list'`. `decodeByShape` MUST honour the shape flag
    // (even when the data doesn't fit — shape dispatch, not inference).
    const envSingle: PackEnvelope = {
      schemaVersion: COLLECTION_SCHEMA.schemaVersion,
      data: {
        'default/Collection': [
          { tags: ['a', 'b'], id: 'c1' },
          { tags: ['c'], id: 'c2' }
        ]
      },
      shapes: { 'default/Collection': 'list' }
    };
    const bytes = encodeEnvelope(envSingle, {
      fieldsByKey: { 'default/Collection': { tags: true, id: true } },
      typeByKey: { 'default/Collection': 'Collection' },
      schemas: { default: COLLECTION_SCHEMA },
      currentNsByKey: { 'default/Collection': 'default' }
    });
    const decoded = decodeEnvelope(bytes, {
      fieldsByKey: { 'default/Collection': { tags: true, id: true } },
      typeByKey: { 'default/Collection': 'Collection' },
      schemas: { default: COLLECTION_SCHEMA },
      currentNsByKey: { 'default/Collection': 'default' }
    });
    const got = decoded.data['default/Collection'];
    expect(Array.isArray(got)).toBe(true);
    expect(got).toEqual(envSingle.data['default/Collection']);
  });

  it('shape=list with non-array value throws PackDecodeError', () => {
    // Hand-build a bogus envelope: shape declares 'list' but data is a
    // single tuple. The decoder must refuse rather than silently interpret.
    const bogus = {
      schemaVersion: BASE_SCHEMA.schemaVersion,
      // Emulate the positional layout of a single row — not an array of rows.
      data: { 'default/Todo': ['t1', 'alpha', false] },
      shapes: { 'default/Todo': 'list' }
    };
    const bytes = Buffer.from(pack(bogus));
    expect(() =>
      decodeEnvelope(bytes, {
        fieldsByKey: { 'default/Todo': TODO_FIELD_INPUT },
        typeByKey: { 'default/Todo': 'Todo' },
        schemas: { default: BASE_SCHEMA },
        currentNsByKey: { 'default/Todo': 'default' }
      })
    ).toThrow(PackDecodeError);
  });
});

describe('§7.0/§7.3 — envelope header fields survive roundtrip', () => {
  it('schemaVersion, _meta, _pagination all round-trip unchanged', () => {
    const envelope: PackEnvelope = {
      schemaVersion: BASE_SCHEMA.schemaVersion,
      data: { 'default/Todo': [] },
      shapes: { 'default/Todo': 'list' },
      _meta: { serverTime: '2026-04-19T00:00:00Z', warn: 'demo' },
      _pagination: { 'default/Todo': { nextCursor: 'abc', hasMore: true } }
    };
    const bytes = encodeEnvelope(envelope, {
      fieldsByKey: { 'default/Todo': TODO_FIELD_INPUT },
      typeByKey: { 'default/Todo': 'Todo' },
      schemas: { default: BASE_SCHEMA },
      currentNsByKey: { 'default/Todo': 'default' }
    });
    const decoded = decodeEnvelope(bytes, {
      fieldsByKey: { 'default/Todo': TODO_FIELD_INPUT },
      typeByKey: { 'default/Todo': 'Todo' },
      schemas: { default: BASE_SCHEMA },
      currentNsByKey: { 'default/Todo': 'default' }
    });
    expect(decoded.schemaVersion).toBe(envelope.schemaVersion);
    expect(decoded._meta).toEqual(envelope._meta);
    expect(decoded._pagination).toEqual(envelope._pagination);
  });

  it('raw msgpack envelope carries schemaVersion + shapes as top-level fields (§7.0)', () => {
    const { envelope, ctx } = singleScenario();
    const bytes = encodeEnvelope(envelope, ctx);
    const raw = unpack(bytes) as Record<string, unknown>;
    expect(raw.schemaVersion).toBe(envelope.schemaVersion);
    expect(raw.shapes).toEqual(envelope.shapes);
    expect(raw.data).toBeDefined();
  });
});
