/**
 * validateFilter — json path predicates.
 */

import { fullBuiltinOperators } from '@mnmal-ai/substrate-filter';
import type { FilterCapabilities, TypeSchema, WhereClause } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { FilterValidationError, validateFilter } from '../src/filter/validator.js';

const SCHEMA: TypeSchema = {
  fields: {
    title: { kind: 'scalar', type: 'string', indexed: true },
    values: { kind: 'scalar', type: 'json', indexed: true },
    blob: { kind: 'scalar', type: 'json', indexed: false },
    address: {
      kind: 'struct',
      fields: {
        city: { kind: 'scalar', type: 'string', indexed: true },
        data: { kind: 'scalar', type: 'json', indexed: true }
      }
    }
  }
};
const CAPS: FilterCapabilities = { operators: fullBuiltinOperators(), orderBy: true, cursor: true };

const validate = (where: WhereClause, allowTableScan = false): void =>
  validateFilter({ where, typeSchema: SCHEMA, capabilities: CAPS, allowTableScan });

function refusal(fn: () => void): FilterValidationError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(FilterValidationError);
    return err as FilterValidationError;
  }
  throw new Error('expected FilterValidationError');
}

describe('validateFilter — json path: accepted', () => {
  it('index-served operators need no flag', () => {
    expect(() => validate({ values: { path: ['year'], eq: 1995 } })).not.toThrow();
    expect(() => validate({ values: { path: ['year'], in: [1995, 2001] } })).not.toThrow();
    expect(() => validate({ values: { path: ['tags'], has: 'jazz' } })).not.toThrow();
  });
  it('scanning operators pass under _allowTableScan', () => {
    for (const where of [
      { values: { path: ['year'], gt: 1990 } },
      { values: { path: ['year'], between: [1990, 2000] } },
      { values: { path: ['genre'], contains: 'jazz' } },
      { values: { path: ['year'], neq: 1995 } },
      { values: { path: ['year'], eq: null } },
      { values: { path: ['year'], in: [1995, null] } }
    ] as WhereClause[]) {
      expect(() => validate(where, true)).not.toThrow();
    }
  });
});

describe('validateFilter — json path: refused', () => {
  it('scanning operators without the flag → unindexed_field, naming the operator', () => {
    const e = refusal(() => validate({ values: { path: ['year'], gt: 1990 } }));
    expect(e.code).toBe('unindexed_field');
    expect(e.message).toContain("'gt'");
    expect(e.message).toContain("'values'");
    expect(e.path).toEqual(['where', 'values', 'gt']);
    expect(refusal(() => validate({ values: { path: ['year'], eq: null } })).code).toBe(
      'unindexed_field'
    );
  });
  it('an UNindexed json field gets no index-served operators — every op needs the flag', () => {
    const e = refusal(() => validate({ blob: { path: ['year'], eq: 1995 } }));
    expect(e.code).toBe('unindexed_field');
    expect(e.message).toContain('field.json({ indexed: true })');
    expect(() => validate({ blob: { path: ['year'], eq: 1995 } }, true)).not.toThrow();
  });
  it('no path keeps the old wording (field + kind) and adds the hint', () => {
    const e = refusal(() => validate({ values: { eq: 'x' } }));
    expect(e.code).toBe('unknown_operator');
    expect(e.message).toContain(
      "operator 'eq' is not valid for field 'values' (kind=scalar.json — opaque body"
    );
    expect(e.message).toContain('{ path: [...], <op>: ... }');
  });
  it('unknown operator beside path names operator, field and kind', () => {
    const e = refusal(() => validate({ values: { path: ['year'], bogus: 1 } }));
    expect(e.code).toBe('unknown_operator');
    expect(e.message).toContain("'bogus'");
    expect(e.message).toContain("'values'");
    expect(e.message).toContain('kind=scalar.json');
  });
  it('bad path shapes → type_mismatch at the path', () => {
    for (const where of [
      { values: { path: [], eq: 1 } },
      { values: { path: [1], eq: 1 } },
      { values: { path: ['year'] } },
      { values: { path: 'year', eq: 1 } }
    ] as WhereClause[]) {
      const e = refusal(() => validate(where));
      expect(e.code).toBe('type_mismatch');
      expect(e.path).toEqual(['where', 'values', 'path']);
    }
  });
  it('bad operands → type_mismatch / invalid_between', () => {
    expect(refusal(() => validate({ values: { path: ['y'], eq: { a: 1 } } })).code).toBe(
      'type_mismatch'
    );
    expect(
      refusal(() => validate({ values: { path: ['y'], gt: new Date() } }, true)).message
    ).toMatch(/ISO string/);
    expect(refusal(() => validate({ values: { path: ['y'], between: [1, 'b'] } }, true)).code).toBe(
      'invalid_between'
    );
  });
  it('a json field inside a struct is refused — v1 addresses top-level json fields only', () => {
    // pg's struct walk has no json-path branch and no index is derived for a
    // nested field, so accepting it would let memory answer what pg refuses.
    const e = refusal(() => validate({ address: { data: { path: ['x'], eq: 1 } } }, true));
    expect(e.code).toBe('unknown_operator');
    expect(e.message).toContain('top-level');
    expect(e.message).toContain("'data'");
  });
  it('path on a non-json field is refused by name', () => {
    const e = refusal(() => validate({ title: { path: ['x'], eq: 'a' } }));
    expect(e.code).toBe('unknown_operator');
    expect(e.message).toContain("operator 'path' is not valid for field 'title'");
  });
  it('capability gate: a dataset that declares no json ops refuses', () => {
    const caps: FilterCapabilities = {
      operators: { ...fullBuiltinOperators(), 'scalar.json': [] },
      orderBy: true,
      cursor: true
    };
    const e = refusal(() =>
      validateFilter({
        where: { values: { path: ['y'], eq: 1 } },
        typeSchema: SCHEMA,
        capabilities: caps
      })
    );
    expect(e.code).toBe('capability_unsupported');
  });
  it('orderBy on json stays refused', () => {
    expect(
      refusal(() =>
        validateFilter({ orderBy: [{ values: 'asc' }], typeSchema: SCHEMA, capabilities: CAPS })
      ).code
    ).toBe('orderby_nonscalar');
  });
});
