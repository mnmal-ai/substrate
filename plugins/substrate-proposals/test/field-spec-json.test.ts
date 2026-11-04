import { field } from '@mnmal-ai/substrate-sdk';
import { describe, expect, it } from 'vitest';
import { type FieldSpecJson, parseFieldSpec, stringifyFieldDef } from '../src/field-spec-json.js';

describe('FieldSpecJson round-trip', () => {
  it('scalar string round-trips', () => {
    const json: FieldSpecJson = { kind: 'scalar', type: 'string', indexed: true };
    const def = parseFieldSpec(json);
    expect(def).toEqual({ kind: 'scalar', type: 'string', indexed: true });
    expect(stringifyFieldDef(def)).toEqual(json);
  });

  it('crossRef round-trips with defaults applied', () => {
    const json: FieldSpecJson = {
      kind: 'crossRef',
      ns: 'home',
      type: 'Closet',
      onDelete: 'set_null'
    };
    const def = parseFieldSpec(json);
    expect(def).toEqual({
      kind: 'crossRef',
      ns: 'home',
      type: 'Closet',
      onDelete: 'set_null',
      indexed: true
    });
  });

  it('nested list(struct(scalar, crossRef)) round-trips', () => {
    const json: FieldSpecJson = {
      kind: 'list',
      of: {
        kind: 'struct',
        fields: {
          text: { kind: 'scalar', type: 'string', indexed: true },
          cited: { kind: 'crossRef', ns: 'claude', type: 'Decision', onDelete: 'set_null' }
        }
      }
    };
    const def = parseFieldSpec(json);
    expect(def.kind).toBe('list');
    expect(stringifyFieldDef(def)).toEqual(json);
  });

  it('scalar json round-trips with indexed:false default preserved', () => {
    const json: FieldSpecJson = { kind: 'scalar', type: 'json', indexed: false };
    const def = parseFieldSpec(json);
    expect(def).toEqual({ kind: 'scalar', type: 'json', indexed: false });
    expect(stringifyFieldDef(def)).toEqual(json);
  });

  it('scalar enum round-trips', () => {
    const json: FieldSpecJson = {
      kind: 'scalar',
      type: 'string',
      indexed: true,
      enum: ['low', 'medium', 'high']
    };
    const def = parseFieldSpec(json);
    expect(def).toMatchObject({ kind: 'scalar', type: 'string', enum: ['low', 'medium', 'high'] });
    expect(stringifyFieldDef(def)).toEqual(json);
  });

  it('rejects unknown scalar type', () => {
    const bad = { kind: 'scalar', type: 'datetime' } as unknown as FieldSpecJson;
    expect(() => parseFieldSpec(bad)).toThrow(/unsupported scalar type/i);
  });

  it('rejects unknown kind', () => {
    const bad = { kind: 'enum', values: ['a', 'b'] } as unknown as FieldSpecJson;
    expect(() => parseFieldSpec(bad)).toThrow(/unknown field spec kind/i);
  });

  it('rejects crossRef spec with onMissing (not supported via propose_field)', () => {
    const bad = {
      kind: 'crossRef',
      ns: 'home',
      type: 'Closet',
      onMissing: 'reject'
    } as unknown as FieldSpecJson;
    expect(() => parseFieldSpec(bad)).toThrow(/onMissing/);
    expect(() => parseFieldSpec(bad)).toThrow(/propose_field/);
  });

  it('crossRef without onMissing still parses fine (no regression)', () => {
    const json: FieldSpecJson = {
      kind: 'crossRef',
      ns: 'home',
      type: 'Closet',
      onDelete: 'set_null'
    };
    expect(() => parseFieldSpec(json)).not.toThrow();
    expect(parseFieldSpec(json)).toEqual({
      kind: 'crossRef',
      ns: 'home',
      type: 'Closet',
      onDelete: 'set_null',
      indexed: true
    });
  });
});

describe('indexed defaults', () => {
  it('a proposed scalar leaves indexed unset like field.string(); a crossRef stays true', () => {
    expect(parseFieldSpec({ kind: 'scalar', type: 'string' })).toEqual(field.string());
    const stored = JSON.parse(
      JSON.stringify(stringifyFieldDef(parseFieldSpec({ kind: 'scalar', type: 'string' })))
    );
    expect(stored).toEqual({ kind: 'scalar', type: 'string' });
    expect('indexed' in parseFieldSpec(stored)).toBe(false);
    expect(parseFieldSpec({ kind: 'crossRef', ns: 'a', type: 'B' })).toMatchObject({
      indexed: true
    });
  });
});

describe('vocabulary specs', () => {
  const spec: FieldSpecJson = {
    kind: 'scalar',
    type: 'string',
    enum: ['open', 'active'],
    aliases: { accepted: 'active' },
    strict: false,
    implies: { accepted: {} }
  };

  it('round-trips aliases, strict and implies', () => {
    expect(stringifyFieldDef(parseFieldSpec(spec))).toEqual(spec);
  });

  it('refuses an alias pointing outside the vocabulary', () => {
    expect(() => parseFieldSpec({ ...spec, aliases: { accepted: 'nope' } })).toThrow(
      /not in the vocabulary/
    );
  });

  it('refuses vocabulary options without an enum', () => {
    expect(() => parseFieldSpec({ kind: 'scalar', type: 'string', aliases: { a: 'b' } })).toThrow(
      /enum/
    );
  });
});
