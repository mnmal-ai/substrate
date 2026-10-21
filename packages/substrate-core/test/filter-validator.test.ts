/**
 * FilterValidator unit tests. Spec §5.2.
 */

import type { FilterCapabilities, TypeSchema } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { FilterValidationError, validateFilter } from '../src/filter/validator.js';

const SCHEMA: TypeSchema = {
  fields: {
    id: { kind: 'scalar', type: 'string', indexed: true },
    title: { kind: 'scalar', type: 'string', indexed: true },
    done: { kind: 'scalar', type: 'boolean', indexed: true },
    priority: { kind: 'scalar', type: 'number' }, // unindexed on purpose
    createdAt: { kind: 'scalar', type: 'date', indexed: true },
    ownerId: { kind: 'crossRef', ns: 'default', type: 'User', onDelete: 'set_null' },
    details: { kind: 'scalar', type: 'json', indexed: false },
    address: {
      kind: 'struct',
      fields: {
        city: { kind: 'scalar', type: 'string', indexed: true },
        zip: { kind: 'scalar', type: 'string' }
      }
    },
    // List fields (`has` element membership).
    tags: { kind: 'list', of: { kind: 'scalar', type: 'string' }, indexed: true },
    scores: { kind: 'list', of: { kind: 'scalar', type: 'number' }, indexed: true },
    labels: { kind: 'list', of: { kind: 'scalar', type: 'string' } }, // unindexed on purpose
    notes: {
      kind: 'list',
      of: { kind: 'struct', fields: { x: { kind: 'scalar', type: 'string' } } },
      indexed: true
    }
  }
};

const CAPS: FilterCapabilities = {
  operators: {
    'scalar.number': ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'nin'],
    'scalar.string': [
      'eq',
      'neq',
      'gt',
      'gte',
      'lt',
      'lte',
      'between',
      'contains',
      'startsWith',
      'endsWith',
      'in',
      'nin'
    ],
    'scalar.boolean': ['eq'],
    'scalar.date': ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'nin'],
    'scalar.json': [],
    crossRef: ['eq'],
    list: ['has']
  },
  orderBy: true,
  cursor: true
};

function expectOk(fn: () => void): void {
  expect(fn).not.toThrow();
}

function expectCode(fn: () => void, code: string): void {
  try {
    fn();
    throw new Error('expected FilterValidationError');
  } catch (err) {
    expect(err).toBeInstanceOf(FilterValidationError);
    expect((err as FilterValidationError).code).toBe(code);
  }
}

describe('validateFilter — where clause', () => {
  it('treats Object.prototype names as unknown fields, not as field defs', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expectCode(
        () =>
          validateFilter({
            where: JSON.parse(`{"${name}": {"eq": 1}}`),
            typeSchema: SCHEMA,
            capabilities: CAPS
          }),
        'unknown_field'
      );
      expectCode(
        () =>
          validateFilter({
            where: { address: JSON.parse(`{"${name}": {"eq": 1}}`) },
            typeSchema: SCHEMA,
            capabilities: CAPS
          }),
        'unknown_field'
      );
      expectCode(
        () =>
          validateFilter({
            orderBy: [JSON.parse(`{"${name}": "asc"}`)],
            typeSchema: SCHEMA,
            capabilities: CAPS
          }),
        'unknown_field'
      );
    }
  });

  it('accepts a known scalar field + valid operator + matching value', () => {
    expectOk(() =>
      validateFilter({
        where: { title: { eq: 'x' } },
        typeSchema: SCHEMA,
        capabilities: CAPS
      })
    );
  });

  it('rejects unknown fields', () => {
    expectCode(
      () =>
        validateFilter({
          where: { ghost: { eq: 1 } },
          typeSchema: SCHEMA,
          capabilities: CAPS
        }),
      'unknown_field'
    );
  });

  it('rejects an operator invalid for the field kind', () => {
    expectCode(
      () =>
        validateFilter({
          where: { done: { contains: 'x' } },
          typeSchema: SCHEMA,
          capabilities: CAPS
        }),
      'unknown_operator'
    );
  });

  it('rejects a type mismatch on the operand', () => {
    expectCode(
      () =>
        validateFilter({
          where: { title: { eq: 42 } },
          typeSchema: SCHEMA,
          capabilities: CAPS
        }),
      'type_mismatch'
    );
  });

  it('rejects between with a non-2-tuple', () => {
    expectCode(
      () =>
        validateFilter({
          where: { priority: { between: [1] as unknown as [number, number] } },
          allowTableScan: true,
          typeSchema: SCHEMA,
          capabilities: CAPS
        }),
      'invalid_between'
    );
  });

  it('rejects filters on unindexed fields by default', () => {
    expectCode(
      () =>
        validateFilter({
          where: { priority: { eq: 5 } },
          typeSchema: SCHEMA,
          capabilities: CAPS
        }),
      'unindexed_field'
    );
  });

  it('allows filters on unindexed fields when _allowTableScan is set', () => {
    expectOk(() =>
      validateFilter({
        where: { priority: { eq: 5 } },
        allowTableScan: true,
        typeSchema: SCHEMA,
        capabilities: CAPS
      })
    );
  });

  it('rejects an operator the dataset does not declare', () => {
    const limited: FilterCapabilities = {
      operators: {
        ...CAPS.operators,
        'scalar.string': ['eq'] // dataset only supports eq on strings
      },
      orderBy: true,
      cursor: true
    };
    expectCode(
      () =>
        validateFilter({
          where: { title: { contains: 'x' } },
          typeSchema: SCHEMA,
          capabilities: limited
        }),
      'capability_unsupported'
    );
  });

  it('validates AND / OR / NOT children recursively', () => {
    expectOk(() =>
      validateFilter({
        where: {
          AND: [
            { done: { eq: false } },
            { OR: [{ title: { contains: 'x' } }, { title: { eq: 'y' } }] },
            { NOT: { title: { eq: 'exclude' } } }
          ]
        },
        typeSchema: SCHEMA,
        capabilities: CAPS
      })
    );
  });

  it('rejects mixing field keys with logical combinators at the same level', () => {
    expectCode(
      () =>
        validateFilter({
          where: {
            AND: [{ title: { eq: 'a' } }],
            done: { eq: true }
          },
          typeSchema: SCHEMA,
          capabilities: CAPS
        }),
      'invalid_logical'
    );
  });

  it('recurses into struct fields', () => {
    expectOk(() =>
      validateFilter({
        where: { address: { city: { eq: 'NYC' } } },
        typeSchema: SCHEMA,
        capabilities: CAPS
      })
    );
    expectCode(
      () =>
        validateFilter({
          where: { address: { zip: { eq: '12345' } } },
          typeSchema: SCHEMA,
          capabilities: CAPS
        }),
      'unindexed_field'
    );
  });

  it('accepts crossRef.eq with an id value', () => {
    expectOk(() =>
      validateFilter({
        where: { ownerId: { eq: 'user-1' } },
        typeSchema: SCHEMA,
        capabilities: CAPS
      })
    );
  });

  it('rejects crossRef with an operator no crossRef supports', () => {
    // Range and pattern operators stay out of CROSSREF_OPS — lexicographic
    // ordering of opaque ids is meaningless.
    expectCode(
      () =>
        validateFilter({
          where: { ownerId: { contains: 'user' } },
          typeSchema: SCHEMA,
          capabilities: CAPS
        }),
      'unknown_operator'
    );
  });

  it('crossRef in/nin pass the operator allowlist but still honour dataset capability', () => {
    // CROSSREF_OPS admits `in`, but CAPS here declares crossRef: ['eq'], so the
    // rejection comes from the capability check rather than the allowlist —
    // the operator is meaningful, this dataset just cannot serve it.
    expectCode(
      () =>
        validateFilter({
          where: { ownerId: { in: ['user-1'] } },
          typeSchema: SCHEMA,
          capabilities: CAPS
        }),
      'capability_unsupported'
    );
    expectOk(() =>
      validateFilter({
        where: { ownerId: { in: ['user-1'] } },
        typeSchema: SCHEMA,
        capabilities: {
          ...CAPS,
          operators: { ...CAPS.operators, crossRef: ['eq', 'in', 'nin'] }
        }
      })
    );
  });

  it('eq null / neq null are permitted', () => {
    expectOk(() =>
      validateFilter({
        where: { title: { eq: null } },
        typeSchema: SCHEMA,
        capabilities: CAPS
      })
    );
  });
});

describe('validateFilter — in/nin with nullable fields', () => {
  const NULLABLE_SCHEMA: TypeSchema = {
    fields: {
      id: { kind: 'scalar', type: 'string', indexed: true },
      project: { kind: 'scalar', type: 'string', indexed: true, nullable: true }
    }
  };

  it('in: null element on a nullable string field is accepted', () => {
    expectOk(() =>
      validateFilter({
        where: { project: { in: ['substrate-v2', null] } },
        typeSchema: NULLABLE_SCHEMA,
        capabilities: CAPS
      })
    );
  });

  it('in: null element on a non-nullable string field still throws type_mismatch', () => {
    expectCode(
      () =>
        validateFilter({
          where: { id: { in: ['abc', null] } },
          typeSchema: NULLABLE_SCHEMA,
          capabilities: CAPS
        }),
      'type_mismatch'
    );
  });

  it('nin: null element on a nullable string field is accepted', () => {
    expectOk(() =>
      validateFilter({
        where: { project: { nin: ['substrate-v2', null] } },
        typeSchema: NULLABLE_SCHEMA,
        capabilities: CAPS
      })
    );
  });

  it('nin: null element on a non-nullable string field still throws type_mismatch', () => {
    expectCode(
      () =>
        validateFilter({
          where: { id: { nin: ['abc', null] } },
          typeSchema: NULLABLE_SCHEMA,
          capabilities: CAPS
        }),
      'type_mismatch'
    );
  });
});

describe('validateFilter — orderBy', () => {
  it('accepts orderBy on a scalar field', () => {
    expectOk(() =>
      validateFilter({
        orderBy: [{ title: 'asc' }, { id: 'desc' }],
        typeSchema: SCHEMA,
        capabilities: CAPS
      })
    );
  });

  it('rejects orderBy on an unknown field', () => {
    expectCode(
      () =>
        validateFilter({
          orderBy: [{ ghost: 'asc' }],
          typeSchema: SCHEMA,
          capabilities: CAPS
        }),
      'unknown_field'
    );
  });

  it('rejects orderBy on a crossRef field', () => {
    expectCode(
      () =>
        validateFilter({
          orderBy: [{ ownerId: 'asc' }],
          typeSchema: SCHEMA,
          capabilities: CAPS
        }),
      'orderby_nonscalar'
    );
  });

  it('rejects orderBy on a struct field', () => {
    expectCode(
      () =>
        validateFilter({
          orderBy: [{ address: 'asc' }],
          typeSchema: SCHEMA,
          capabilities: CAPS
        }),
      'orderby_nonscalar'
    );
  });

  it('rejects when the dataset does not support orderBy', () => {
    const noOrderBy: FilterCapabilities = { ...CAPS, orderBy: false };
    expectCode(
      () =>
        validateFilter({
          orderBy: [{ title: 'asc' }],
          typeSchema: SCHEMA,
          capabilities: noOrderBy
        }),
      'capability_unsupported'
    );
  });

  it('rejects invalid direction value', () => {
    expectCode(
      () =>
        validateFilter({
          orderBy: [{ title: 'upward' as unknown as 'asc' }],
          typeSchema: SCHEMA,
          capabilities: CAPS
        }),
      'type_mismatch'
    );
  });

  it('rejects a non-array orderBy with a structured error (not a TypeError crash)', () => {
    // Regression: the per-entry shape sent directly (object, not array) must be
    // rejected here, not crash the resolver with `orderBy.forEach is not a
    // function` and surface as an opaque 500.
    expectCode(
      () =>
        validateFilter({
          orderBy: { field: '_metadata.createdAt', direction: 'desc' } as unknown as never,
          typeSchema: SCHEMA,
          capabilities: CAPS
        }),
      'type_mismatch'
    );
    expectCode(
      () =>
        validateFilter({
          orderBy: 'title' as unknown as never,
          typeSchema: SCHEMA,
          capabilities: CAPS
        }),
      'type_mismatch'
    );
    expectCode(
      () =>
        validateFilter({
          orderBy: null as unknown as never,
          typeSchema: SCHEMA,
          capabilities: CAPS
        }),
      'type_mismatch'
    );
  });
});

describe('validateFilter — scalar.json (opaque body)', () => {
  it('rejects any operator on a json field', () => {
    expectCode(
      () =>
        validateFilter({
          where: { details: { eq: 'x' } },
          typeSchema: SCHEMA,
          capabilities: CAPS
        }),
      'unknown_operator'
    );
    expectCode(
      () =>
        validateFilter({
          where: { details: { contains: 'x' } },
          typeSchema: SCHEMA,
          capabilities: CAPS
        }),
      'unknown_operator'
    );
  });

  it('rejects orderBy on a json field (non-scalar for ordering purposes)', () => {
    expectCode(
      () =>
        validateFilter({
          orderBy: [{ details: 'asc' }],
          typeSchema: SCHEMA,
          capabilities: CAPS
        }),
      'orderby_nonscalar'
    );
  });
});

describe('validateFilter — string range operators (ask 3)', () => {
  // Range operators (gt/gte/lt/lte/between) must be valid for scalar.string
  // fields when the dataset declares them in capabilities. evaluateWhere
  // compares by UTF-16 code unit; pg compares by column collation. Byte-stable
  // for ASCII-shaped keys (ISO dates, ULIDs) — the intended use cases.
  const CAPS_WITH_STRING_RANGE: FilterCapabilities = {
    operators: {
      ...CAPS.operators,
      'scalar.string': [
        'eq',
        'neq',
        'gt',
        'gte',
        'lt',
        'lte',
        'between',
        'contains',
        'startsWith',
        'endsWith',
        'in',
        'nin'
      ]
    },
    orderBy: true,
    cursor: true
  };

  it('accepts range operators on string fields (lexicographic contract)', () => {
    // gt/gte/lt/lte/between are valid for scalar.string — evaluateWhere compares
    // by UTF-16 code unit; pg compares by column collation. Byte-stable for
    // ASCII-shaped keys (ISO dates, ULIDs, zero-padded sequences) — the intended
    // use cases.
    for (const where of [
      { title: { gt: 'm' } },
      { title: { gte: 'm' } },
      { title: { lt: 'm' } },
      { title: { lte: 'm' } },
      { title: { between: ['a', 'm'] } }
    ]) {
      expectOk(() =>
        validateFilter({
          where,
          typeSchema: SCHEMA,
          capabilities: CAPS_WITH_STRING_RANGE
        })
      );
    }
  });

  it('gt on a scalar.json field still rejects with unknown_operator', () => {
    expectCode(
      () =>
        validateFilter({
          where: { details: { gt: 'x' } },
          typeSchema: SCHEMA,
          capabilities: CAPS_WITH_STRING_RANGE
        }),
      'unknown_operator'
    );
  });

  it('gt on a crossRef field still rejects with unknown_operator', () => {
    expectCode(
      () =>
        validateFilter({
          where: { ownerId: { gt: 'user-1' } },
          typeSchema: SCHEMA,
          capabilities: CAPS_WITH_STRING_RANGE
        }),
      'unknown_operator'
    );
  });
});

describe('validateFilter — virtual `id` field', () => {
  // AutoCRUD-managed types don't declare `id` as a body field — it's the row
  // PK, projected separately. The validator treats it as a virtual field so
  // `where: { id }` works uniformly rather than failing with `unknown_field`.
  const SCHEMA_WITHOUT_ID: TypeSchema = {
    fields: {
      title: { kind: 'scalar', type: 'string', indexed: true }
    }
  };

  it('accepts where: { id: { eq } } when type does not declare id', () => {
    expectOk(() =>
      validateFilter({
        where: { id: { eq: 'foo' } },
        typeSchema: SCHEMA_WITHOUT_ID,
        capabilities: CAPS
      })
    );
  });

  it('accepts where: { id: { in: [...] } }', () => {
    expectOk(() =>
      validateFilter({
        where: { id: { in: ['a', 'b', 'c'] } },
        typeSchema: SCHEMA_WITHOUT_ID,
        capabilities: CAPS
      })
    );
  });

  it('accepts where: { id: { startsWith } } as a string scalar', () => {
    expectOk(() =>
      validateFilter({
        where: { id: { startsWith: 'todo-' } },
        typeSchema: SCHEMA_WITHOUT_ID,
        capabilities: CAPS
      })
    );
  });

  it('rejects string range ops on id when dataset does not declare them (capability_unsupported)', () => {
    // STRING_OPS includes gt/gte/lt/lte/between. A dataset that
    // doesn't declare them in its scalar.string capabilities list gets
    // capability_unsupported (not unknown_operator — it's a valid operator,
    // just unsupported by this dataset).
    const CAPS_NO_STRING_RANGE: FilterCapabilities = {
      operators: {
        ...CAPS.operators,
        'scalar.string': ['eq', 'neq', 'contains', 'startsWith', 'endsWith', 'in', 'nin']
      },
      orderBy: true,
      cursor: true
    };
    expectCode(
      () =>
        validateFilter({
          where: { id: { gt: 'a' } },
          typeSchema: SCHEMA_WITHOUT_ID,
          capabilities: CAPS_NO_STRING_RANGE
        }),
      'capability_unsupported'
    );
  });

  it('accepts orderBy [{ id: asc }] on a type without declared id', () => {
    expectOk(() =>
      validateFilter({
        orderBy: [{ id: 'asc' }],
        typeSchema: SCHEMA_WITHOUT_ID,
        capabilities: CAPS
      })
    );
  });
});

describe('validateFilter — list fields (has)', () => {
  it('accepts `has` on an indexed string list with a string operand', () => {
    expectOk(() =>
      validateFilter({ where: { tags: { has: 'urgent' } }, typeSchema: SCHEMA, capabilities: CAPS })
    );
  });

  it('accepts `has` on an indexed number list with a number operand', () => {
    expectOk(() =>
      validateFilter({ where: { scores: { has: 10 } }, typeSchema: SCHEMA, capabilities: CAPS })
    );
  });

  it('rejects `has` with an operand of the wrong element type', () => {
    expectCode(
      () =>
        validateFilter({
          where: { scores: { has: 'ten' } },
          typeSchema: SCHEMA,
          capabilities: CAPS
        }),
      'type_mismatch'
    );
  });

  it('rejects a non-`has` operator on a list field', () => {
    expectCode(
      () =>
        validateFilter({
          where: { tags: { eq: 'urgent' } },
          typeSchema: SCHEMA,
          capabilities: CAPS
        }),
      'unknown_operator'
    );
  });

  it('rejects `has` on an unindexed list without _allowTableScan', () => {
    expectCode(
      () =>
        validateFilter({ where: { labels: { has: 'x' } }, typeSchema: SCHEMA, capabilities: CAPS }),
      'unindexed_field'
    );
  });

  it('allows `has` on an unindexed list with _allowTableScan', () => {
    expectOk(() =>
      validateFilter({
        where: { labels: { has: 'x' } },
        allowTableScan: true,
        typeSchema: SCHEMA,
        capabilities: CAPS
      })
    );
  });

  it('rejects `has` on a list of structs (no primitive element)', () => {
    expectCode(
      () =>
        validateFilter({
          where: { notes: { has: 'x' } },
          typeSchema: SCHEMA,
          capabilities: CAPS
        }),
      'unknown_operator'
    );
  });

  it('rejects `has` when the dataset does not declare list support', () => {
    const noListCaps: FilterCapabilities = {
      ...CAPS,
      operators: { ...CAPS.operators, list: [] }
    };
    expectCode(
      () =>
        validateFilter({
          where: { tags: { has: 'x' } },
          typeSchema: SCHEMA,
          capabilities: noListCaps
        }),
      'capability_unsupported'
    );
  });
});
