/**
 * Generates pg CHECK constraint statements from a `field.enum` vocabulary, so
 * a CHECK migration reads the same constant as the in-process write check.
 *
 * Shape: DROP IF EXISTS, then ADD ... NOT VALID (existing rows grandfathered),
 * an OR-NULL leg, and a (namespace, type) guard so other rows bypass.
 */

import { generatedIdentifier } from './migrate.js';

/** Escape a string for embedding as a SQL string literal. */
function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface EnumCheckInput {
  namespace: string;
  type: string;
  /** Body field carrying the vocabulary (e.g. 'status'). */
  field: string;
  /** The vocabulary — pass the same constant `field.enum` reads, not a copy. */
  vocab: ReadonlyArray<string>;
}

export interface EnumCheckStatements {
  /** `rows_<ns>_<type>_<field>_<hash>_check`; see `generatedIdentifier`. */
  constraintName: string;
  /** DROP IF EXISTS + ADD ... NOT VALID, in application order. */
  statements: ReadonlyArray<string>;
}

export function enumCheckStatements(input: EnumCheckInput): EnumCheckStatements {
  if (input.namespace.length === 0 || input.type.length === 0 || input.field.length === 0) {
    throw new Error('enumCheckStatements: namespace, type and field must be non-empty strings');
  }
  if (input.vocab.length === 0) {
    // `IN ()` is a syntax error, and an empty vocabulary is a caller bug, not
    // an empty guard — refuse rather than emit DDL the database rejects.
    throw new Error(
      `enumCheckStatements: empty vocabulary for ${input.namespace}/${input.type}.${input.field} — an enum with no values checks nothing`
    );
  }
  const constraintName = generatedIdentifier(input.namespace, input.type, input.field, 'check');
  const ns = lit(input.namespace);
  const type = lit(input.type);
  const field = lit(input.field);
  const values = input.vocab.map(lit).join(',');
  return {
    constraintName,
    statements: [
      `ALTER TABLE rows DROP CONSTRAINT IF EXISTS ${constraintName}`,
      `ALTER TABLE rows\n    ADD CONSTRAINT ${constraintName}\n      CHECK (\n        NOT (namespace = ${ns} AND type = ${type})\n        OR body->>${field} IS NULL\n        OR body->>${field} IN (${values})\n      ) NOT VALID`
    ]
  };
}
