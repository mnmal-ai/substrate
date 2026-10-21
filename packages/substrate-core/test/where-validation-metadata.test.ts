/**
 * Row-metadata projection fields in where clauses.
 *
 * The engine's schema validator must accept all 6 Tier-1 row-metadata field
 * names on autoCRUD-managed types even when they are not declared in the
 * type's field map. The dataset layer (Memory + PG) handles these via
 * `METADATA_COLUMN_PROJECTIONS` / `METADATA_COLUMNS`.
 *
 * Unlike `shortId` (injected into `augmentedFields`), these are virtual filter
 * projections onto `row._metadata`, so the validator's allow-set is extended
 * instead of mutating every type schema.
 */

import type { FilterCapabilities, TypeSchema } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { FilterValidationError, validateFilter } from '../src/filter/validator.js';

// A minimal schema with NO metadata fields declared — this is the normal case:
// plugin authors declare their domain fields and let autoCRUD handle metadata.
const SCHEMA_NO_META: TypeSchema = {
  fields: {
    id: { kind: 'scalar', type: 'string', indexed: true },
    title: { kind: 'scalar', type: 'string', indexed: true }
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

describe('where-clause validator allows row-metadata projection fields', () => {
  // Timestamp fields.
  it('accepts createdAt as a where-clause date field', () => {
    expectOk(() =>
      validateFilter({
        where: { createdAt: { gte: '2026-01-01T00:00:00.000Z' } },
        typeSchema: SCHEMA_NO_META,
        capabilities: CAPS
      })
    );
  });

  it('accepts updatedAt as a where-clause date field', () => {
    expectOk(() =>
      validateFilter({
        where: { updatedAt: { between: ['2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z'] } },
        typeSchema: SCHEMA_NO_META,
        capabilities: CAPS
      })
    );
  });

  // Provenance string fields.
  it('accepts createdById as a where-clause string field', () => {
    expectOk(() =>
      validateFilter({
        where: { createdById: { eq: 'a1' } },
        typeSchema: SCHEMA_NO_META,
        capabilities: CAPS
      })
    );
  });

  it('accepts createdByKind as a where-clause string field', () => {
    expectOk(() =>
      validateFilter({
        where: { createdByKind: { eq: 'user' } },
        typeSchema: SCHEMA_NO_META,
        capabilities: CAPS
      })
    );
  });

  it('accepts updatedById as a where-clause string field', () => {
    expectOk(() =>
      validateFilter({
        where: { updatedById: { eq: 'b2' } },
        typeSchema: SCHEMA_NO_META,
        capabilities: CAPS
      })
    );
  });

  it('accepts updatedByKind as a where-clause string field', () => {
    expectOk(() =>
      validateFilter({
        where: { updatedByKind: { eq: 'agent' } },
        typeSchema: SCHEMA_NO_META,
        capabilities: CAPS
      })
    );
  });

  // Operator semantics for provenance fields.
  it('accepts createdByKind with string operators (contains, startsWith, in)', () => {
    expectOk(() =>
      validateFilter({
        where: { createdByKind: { in: ['user', 'agent'] } },
        typeSchema: SCHEMA_NO_META,
        capabilities: CAPS
      })
    );
  });

  it('rejects an invalid operator on a provenance string field', () => {
    // gt is a valid STRING_OPS entry, but this dataset's CAPS
    // doesn't declare it for scalar.string — so capability_unsupported fires.
    expectCode(
      () =>
        validateFilter({
          where: { createdByKind: { gt: 'user' } as unknown as { eq: string } },
          typeSchema: SCHEMA_NO_META,
          capabilities: CAPS
        }),
      'capability_unsupported'
    );
  });

  it('rejects a type mismatch on a provenance field operand', () => {
    expectCode(
      () =>
        validateFilter({
          where: { createdById: { eq: 42 as unknown as string } },
          typeSchema: SCHEMA_NO_META,
          capabilities: CAPS
        }),
      'type_mismatch'
    );
  });

  it('still rejects a genuinely unknown field', () => {
    expectCode(
      () =>
        validateFilter({
          where: { ghost: { eq: 'x' } },
          typeSchema: SCHEMA_NO_META,
          capabilities: CAPS
        }),
      'unknown_field'
    );
  });

  // Combined: metadata field + declared field in one where clause.
  it('accepts a where clause mixing a declared field and a metadata field', () => {
    expectOk(() =>
      validateFilter({
        where: {
          AND: [{ title: { eq: 'hello' } }, { createdByKind: { eq: 'user' } }]
        },
        typeSchema: SCHEMA_NO_META,
        capabilities: CAPS
      })
    );
  });
});

// ---------------------------------------------------------------------------
// orderBy allow-set — row-metadata projection fields
// ---------------------------------------------------------------------------
describe('orderBy validator allows row-metadata projection fields', () => {
  const METADATA_FIELD_NAMES = [
    'createdAt',
    'updatedAt',
    'createdById',
    'createdByKind',
    'updatedById',
    'updatedByKind'
  ] as const;

  for (const fieldName of METADATA_FIELD_NAMES) {
    it(`accepts ${fieldName} in orderBy on an autoCRUD type`, () => {
      expectOk(() =>
        validateFilter({
          orderBy: [{ [fieldName]: 'asc' }],
          typeSchema: SCHEMA_NO_META,
          capabilities: CAPS
        })
      );
    });

    it(`accepts ${fieldName} desc in orderBy on an autoCRUD type`, () => {
      expectOk(() =>
        validateFilter({
          orderBy: [{ [fieldName]: 'desc' }],
          typeSchema: SCHEMA_NO_META,
          capabilities: CAPS
        })
      );
    });
  }

  it('accepts a mixed orderBy with a declared field + createdAt', () => {
    expectOk(() =>
      validateFilter({
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        typeSchema: SCHEMA_NO_META,
        capabilities: CAPS
      })
    );
  });

  it('still rejects an unknown field in orderBy', () => {
    expectCode(
      () =>
        validateFilter({
          orderBy: [{ ghost: 'asc' }],
          typeSchema: SCHEMA_NO_META,
          capabilities: CAPS
        }),
      'unknown_field'
    );
  });
});

describe('an unknown metadata-looking field names the filterable columns', () => {
  const messageFor = (fn: () => void): string => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(FilterValidationError);
      expect((err as FilterValidationError).code).toBe('unknown_field');
      return (err as Error).message;
    }
    throw new Error('expected FilterValidationError');
  };

  for (const field of ['createdBy', 'updatedBy.name', '_metadata', '_metadata.author']) {
    it(`where '${field}'`, () => {
      const message = messageFor(() =>
        validateFilter({
          where: { [field]: { eq: 'x' } },
          typeSchema: SCHEMA_NO_META,
          capabilities: CAPS
        })
      );
      expect(message).toContain(`unknown field '${field}'`);
      expect(message).toContain('createdById');
      expect(message).toContain('createdBy');
    });
  }

  it('in orderBy too', () => {
    const message = messageFor(() =>
      validateFilter({
        orderBy: [{ '_metadata.author': 'asc' }],
        typeSchema: SCHEMA_NO_META,
        capabilities: CAPS
      })
    );
    expect(message).toContain('createdById');
  });

  it('leaves an ordinary unknown field’s message alone', () => {
    const message = messageFor(() =>
      validateFilter({
        where: { nope: { eq: 'x' } },
        typeSchema: SCHEMA_NO_META,
        capabilities: CAPS
      })
    );
    expect(message).toBe("unknown field 'nope'");
  });
});
