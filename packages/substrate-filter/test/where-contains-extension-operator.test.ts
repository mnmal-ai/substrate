/**
 * Unit coverage for whereContainsExtensionOperator. The subscribe
 * path relies on this recursive walk to refuse semantic filters at
 * registration; the cases below pin every structural shape it must see through
 * (root, AND/OR/NOT combinators, struct-field sub-clauses, arrays) plus the
 * critical no-false-positive case: a leaf predicate object whose keys are
 * structural operators, not registered extension operators.
 */

import type { FilterOperatorDef } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearExtensionOperators,
  registerExtensionOperator,
  whereContainsExtensionOperator,
  whereContainsOperator
} from '../src/index.js';

const stubOp: FilterOperatorDef = {
  validate: () => ({ ok: true, value: {} }),
  execute: async () => ({ hits: [] })
};

describe('whereContainsExtensionOperator', () => {
  afterEach(() => clearExtensionOperators());

  it('returns false for non-object inputs', () => {
    expect(whereContainsExtensionOperator(undefined)).toBe(false);
    expect(whereContainsExtensionOperator(null)).toBe(false);
    expect(whereContainsExtensionOperator('x')).toBe(false);
    expect(whereContainsExtensionOperator(42)).toBe(false);
  });

  it('detects a registered operator at the root', () => {
    registerExtensionOperator('embeddingSimilar', stubOp);
    expect(whereContainsExtensionOperator({ embeddingSimilar: { to: 'x' } })).toBe(true);
  });

  it('detects a registered operator nested under AND', () => {
    registerExtensionOperator('embeddingSimilar', stubOp);
    expect(
      whereContainsExtensionOperator({
        AND: [{ name: { eq: 'a' } }, { embeddingSimilar: { to: 'x' } }]
      })
    ).toBe(true);
  });

  it('detects a registered operator nested under OR', () => {
    registerExtensionOperator('embeddingSimilar', stubOp);
    expect(whereContainsExtensionOperator({ OR: [{ embeddingSimilar: { to: 'x' } }] })).toBe(true);
  });

  it('detects a registered operator nested under NOT', () => {
    registerExtensionOperator('embeddingSimilar', stubOp);
    expect(whereContainsExtensionOperator({ NOT: { embeddingSimilar: { to: 'x' } } })).toBe(true);
  });

  it('detects a registered operator inside a struct-field sub-clause', () => {
    registerExtensionOperator('embeddingSimilar', stubOp);
    expect(whereContainsExtensionOperator({ meta: { embeddingSimilar: { to: 'x' } } })).toBe(true);
  });

  it('detects a registered operator inside an array element', () => {
    registerExtensionOperator('embeddingSimilar', stubOp);
    expect(whereContainsExtensionOperator([{ embeddingSimilar: { to: 'x' } }])).toBe(true);
  });

  it('returns false for a purely structural where with no registered operators', () => {
    registerExtensionOperator('embeddingSimilar', stubOp);
    // Pre-validation shape: validateFilter would reject AND+sibling-key as invalid_logical, but this helper runs before validation and must not crash on it.
    expect(
      whereContainsExtensionOperator({
        AND: [{ name: { eq: 'x' } }, { NOT: { score: { gte: 5 } } }],
        meta: { tag: { contains: 'foo' } }
      })
    ).toBe(false);
  });

  it('does not false-positive on leaf predicate operator keys', () => {
    // No operator registered — eq/gte/contains are structural, not extension.
    expect(whereContainsExtensionOperator({ name: { eq: 'x' }, score: { gte: 5 } })).toBe(false);
  });
});

describe('whereContainsOperator (named-operator variant)', () => {
  // Unlike whereContainsExtensionOperator (true for ANY registered operator),
  // this variant matches a SPECIFIC operator name — the computed-field gate
  // needs the operator that OWNS the projected field, not just any semantic op.

  it('returns false for non-object inputs', () => {
    expect(whereContainsOperator(undefined, 'embeddingSimilar')).toBe(false);
    expect(whereContainsOperator(null, 'embeddingSimilar')).toBe(false);
    expect(whereContainsOperator(42, 'embeddingSimilar')).toBe(false);
  });

  it('matches the named operator at the root', () => {
    expect(whereContainsOperator({ embeddingSimilar: { to: 'x' } }, 'embeddingSimilar')).toBe(true);
  });

  it('does not match a DIFFERENT operator name', () => {
    expect(whereContainsOperator({ embeddingSimilar: { to: 'x' } }, 'otherSimilar')).toBe(false);
  });

  it('matches the named operator nested under AND / OR / NOT', () => {
    expect(whereContainsOperator({ AND: [{ id: { eq: 'a' } }, { foo: { to: 'x' } }] }, 'foo')).toBe(
      true
    );
    expect(whereContainsOperator({ OR: [{ foo: { to: 'x' } }] }, 'foo')).toBe(true);
    expect(whereContainsOperator({ NOT: { foo: { to: 'x' } } }, 'foo')).toBe(true);
  });

  it('matches the named operator inside a struct-field sub-clause and arrays', () => {
    expect(whereContainsOperator({ meta: { foo: { to: 'x' } } }, 'foo')).toBe(true);
    expect(whereContainsOperator([{ foo: { to: 'x' } }], 'foo')).toBe(true);
  });

  it('returns false when the named operator is absent from a purely structural where', () => {
    expect(
      whereContainsOperator({ name: { eq: 'x' }, score: { gte: 5 } }, 'embeddingSimilar')
    ).toBe(false);
  });
});
