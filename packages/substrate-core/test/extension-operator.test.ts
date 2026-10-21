/**
 * Extension operator registry tests.
 *
 * Tests that `registerExtensionOperator` / `clearExtensionOperators` /
 * `getExtensionOperator` allow substrate plugins (e.g. substrate-recall's
 * `embeddingSimilar`) to contribute custom where-clause operators that pass
 * the filter validator and execute through the predicate evaluator.
 */

import type { FilterCapabilities, FilterOperatorDef, TypeSchema } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import { FilterValidationError, validateFilter } from '../src/filter/validator.js';
import {
  clearExtensionOperators,
  getExtensionOperator,
  registerExtensionOperator
} from '../src/index.js';

const SCHEMA: TypeSchema = {
  fields: {
    id: { kind: 'scalar', type: 'string', indexed: true },
    embedding: { kind: 'scalar', type: 'json', indexed: false }
  }
};

const CAPS: FilterCapabilities = {
  operators: {
    'scalar.number': ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'nin'],
    'scalar.string': ['eq', 'neq', 'contains', 'startsWith', 'endsWith', 'in', 'nin'],
    'scalar.boolean': ['eq'],
    'scalar.date': ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'nin'],
    'scalar.json': [],
    crossRef: ['eq'],
    list: ['has']
  },
  orderBy: true,
  cursor: true
};

const echoOp: FilterOperatorDef = {
  validate: (value) => ({ ok: true, value }),
  execute: async (value) => ({ ok: true, value })
};

afterEach(() => {
  clearExtensionOperators();
});

describe('extension operators — registry', () => {
  it('getExtensionOperator returns undefined when not registered', () => {
    expect(getExtensionOperator('echo')).toBeUndefined();
  });

  it('getExtensionOperator returns the registered def after registration', () => {
    registerExtensionOperator('echo', echoOp);
    expect(getExtensionOperator('echo')).toBe(echoOp);
  });

  it('refuses double-registration with actionable error', () => {
    registerExtensionOperator('echo', echoOp);
    expect(() => registerExtensionOperator('echo', echoOp)).toThrow(/already registered/);
  });

  it('clearExtensionOperators removes all registrations', () => {
    registerExtensionOperator('echo', echoOp);
    clearExtensionOperators();
    expect(getExtensionOperator('echo')).toBeUndefined();
  });
});

describe('extension operators — validator integration', () => {
  it('rejects an extension operator key when not registered', () => {
    // 'echo' is not a built-in operator for string fields, and not registered.
    // The validator must reject it as unknown_operator.
    try {
      validateFilter({
        where: { id: { echo: 'v' } },
        typeSchema: SCHEMA,
        capabilities: CAPS
      });
      throw new Error('expected FilterValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(FilterValidationError);
      expect((err as FilterValidationError).code).toBe('unknown_operator');
    }
  });

  it('accepts a registered extension operator on a string field', () => {
    registerExtensionOperator('echo', echoOp);
    // After registration the validator should not throw.
    expect(() =>
      validateFilter({
        where: { id: { echo: 'v' } },
        typeSchema: SCHEMA,
        capabilities: CAPS
      })
    ).not.toThrow();
  });

  it('calls op.validate and rejects when validate returns ok:false', () => {
    const rejectingOp: FilterOperatorDef = {
      validate: (value) =>
        Array.isArray(value) ? { ok: true, value } : { ok: false, reason: 'must be an array' },
      execute: async (_value) => ({ ok: true, value: undefined })
    };
    registerExtensionOperator('mustBeArray', rejectingOp);
    try {
      validateFilter({
        where: { id: { mustBeArray: 'not-an-array' } },
        typeSchema: SCHEMA,
        capabilities: CAPS
      });
      throw new Error('expected FilterValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(FilterValidationError);
      expect((err as FilterValidationError).code).toBe('type_mismatch');
    }
  });
});

describe('extension operators — top-level (where-clause root)', () => {
  // Vector-similarity is naturally a row-level operator: it doesn't compare
  // against any particular field, it ranks rows by their full embedding
  // vector. The natural surface is `where: { embeddingSimilar: {...} }` at
  // the top level of where, alongside other field clauses.

  const similarOp: FilterOperatorDef = {
    validate: (value) => {
      if (typeof value !== 'object' || value === null) {
        return { ok: false, reason: 'must be an object' };
      }
      const v = value as { to?: unknown };
      if (typeof v.to !== 'string' || v.to.length === 0) {
        return { ok: false, reason: 'to must be a non-empty string' };
      }
      return { ok: true, value: { to: v.to } };
    },
    execute: async (_value) => ({ hits: [] })
  };

  it('accepts a registered extension operator at the where-clause root', () => {
    registerExtensionOperator('embeddingSimilar', similarOp);
    expect(() =>
      validateFilter({
        where: { embeddingSimilar: { to: 'jazz piano' } },
        typeSchema: SCHEMA,
        capabilities: CAPS
      })
    ).not.toThrow();
  });

  it('accepts a top-level extension operator intermixed with field clauses', () => {
    registerExtensionOperator('embeddingSimilar', similarOp);
    expect(() =>
      validateFilter({
        where: { embeddingSimilar: { to: 'ambient' }, id: { eq: 'r1' } },
        typeSchema: SCHEMA,
        capabilities: CAPS
      })
    ).not.toThrow();
  });

  it('still rejects unknown top-level keys (not a registered operator)', () => {
    try {
      validateFilter({
        where: { madeUpKey: 'whatever' },
        typeSchema: SCHEMA,
        capabilities: CAPS
      });
      throw new Error('expected FilterValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(FilterValidationError);
      expect((err as FilterValidationError).code).toBe('unknown_field');
    }
  });

  it('calls top-level op.validate and reports type_mismatch on bad value', () => {
    registerExtensionOperator('embeddingSimilar', similarOp);
    try {
      validateFilter({
        where: { embeddingSimilar: { to: '' } },
        typeSchema: SCHEMA,
        capabilities: CAPS
      });
      throw new Error('expected FilterValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(FilterValidationError);
      expect((err as FilterValidationError).code).toBe('type_mismatch');
    }
  });

  it('accepts a top-level extension operator inside an AND combinator', () => {
    registerExtensionOperator('embeddingSimilar', similarOp);
    expect(() =>
      validateFilter({
        where: { AND: [{ embeddingSimilar: { to: 'x' } }, { id: { eq: 'r1' } }] },
        typeSchema: SCHEMA,
        capabilities: CAPS
      })
    ).not.toThrow();
  });
});
