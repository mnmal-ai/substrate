/**
 * Extension-operator registry tests: the `listExtensionOperators`
 * introspection surface and its sort guarantee. register/get/clear are also
 * exercised indirectly via dataset tests.
 */

import type { FilterOperatorDef } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearExtensionOperators,
  computedFieldOwner,
  getExtensionOperator,
  listExtensionOperators,
  registerExtensionOperator
} from '../src/index.js';

const noopOp: FilterOperatorDef = {
  validate: () => ({ ok: true, value: {} }),
  execute: async () => ({ hits: [] })
};

const semanticOp: FilterOperatorDef = {
  computedFields: ['_score', '_vector'],
  validate: () => ({ ok: true, value: {} }),
  execute: async () => ({ hits: [] })
};

describe('listExtensionOperators', () => {
  afterEach(() => clearExtensionOperators());

  it('returns an empty array when no operators are registered', () => {
    expect(listExtensionOperators()).toEqual([]);
  });

  it('returns registered names in lexicographic order regardless of insertion order', () => {
    registerExtensionOperator('zebraOp', noopOp);
    registerExtensionOperator('embeddingSimilar', noopOp);
    registerExtensionOperator('alpha', noopOp);
    expect(listExtensionOperators()).toEqual(['alpha', 'embeddingSimilar', 'zebraOp']);
  });

  it('does not include cleared operators', () => {
    registerExtensionOperator('a', noopOp);
    clearExtensionOperators();
    expect(listExtensionOperators()).toEqual([]);
    expect(getExtensionOperator('a')).toBeUndefined();
  });
});

describe('computedFieldOwner', () => {
  afterEach(() => clearExtensionOperators());

  it('returns undefined when no operator claims the field', () => {
    expect(computedFieldOwner('_score')).toBeUndefined();
  });

  it('returns undefined for an operator that declares no computed fields', () => {
    registerExtensionOperator('plain', noopOp);
    expect(computedFieldOwner('_score')).toBeUndefined();
  });

  it('maps each declared computed field to the owning operator', () => {
    registerExtensionOperator('embeddingSimilar', semanticOp);
    expect(computedFieldOwner('_score')).toBe('embeddingSimilar');
    expect(computedFieldOwner('_vector')).toBe('embeddingSimilar');
  });

  it('clearExtensionOperators forgets computed-field ownership', () => {
    registerExtensionOperator('embeddingSimilar', semanticOp);
    clearExtensionOperators();
    expect(computedFieldOwner('_score')).toBeUndefined();
  });

  it('refuses a second operator claiming an already-owned computed field', () => {
    // Mirrors the operator-name collision posture: throw on collision rather
    // than silently overwriting ownership of a computed projection.
    registerExtensionOperator('embeddingSimilar', semanticOp);
    const rival: FilterOperatorDef = {
      computedFields: ['_score'],
      validate: () => ({ ok: true, value: {} }),
      execute: async () => ({ hits: [] })
    };
    expect(() => registerExtensionOperator('otherSimilar', rival)).toThrow(/_score/);
    // The collision must not have mutated the existing ownership.
    expect(computedFieldOwner('_score')).toBe('embeddingSimilar');
  });
});
