/**
 * Catalog lookups stay scoped when a same-named object exists elsewhere.
 *
 * On a clean schema a scoped and an unscoped lookup return identical results,
 * so this suite plants DECOYS carrying the exact names the real assertions
 * match on, deliberately mis-scoped:
 *
 *   - a CHECK constraint with a rows constraint name, on a different
 *     table (constraint names are unique per RELATION, so this is legal)
 *   - an index with a rows index name, in a different schema (index
 *     names are unique per SCHEMA, so this is legal too)
 *
 * and then asserts the scoped queries still see a healthy database. An
 * unscoped lookup reports drift here; a scoped one does not.
 */

import postgres, { type Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

/**
 * Names the real assertions in this suite match on. Both must be objects the
 * migration actually creates in this path: an index built CONCURRENTLY (e.g.
 * `rows_body_gin`) is absent here, leaving only the decoy.
 */
const REAL_CONSTRAINT = 'rows_created_by_kind_check';
const REAL_INDEX = 'rows_ns_type_created_at_idx';

describe.skipIf(!POSTGRES_URL)('catalog lookups are scoped, proven by decoys', () => {
  let sql: Sql;
  /**
   * The schema this suite's own migrations land in. Read from the connection
   * rather than written as `'public'`: each package's pg suites run in a schema
   * of their own.
   */
  let ownSchema: string;

  beforeEach(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    const [where] = await sql<{ s: string }[]>`SELECT current_schema()::text AS s`;
    ownSchema = where?.s as string;
    await sql`DROP TABLE IF EXISTS rows CASCADE`;
    await sql`DROP TABLE IF EXISTS migrations`;
    await sql`DROP SCHEMA IF EXISTS decoy CASCADE`;
    await sql`DROP TABLE IF EXISTS decoy_relation CASCADE`;
    await runMigrations(sql);

    // Decoy 1 — same CONSTRAINT name, different relation.
    await sql`CREATE TABLE decoy_relation (created_by_kind text)`;
    await sql.unsafe(
      `ALTER TABLE decoy_relation ADD CONSTRAINT ${REAL_CONSTRAINT} CHECK (created_by_kind IN ('nope'))`
    );

    // Decoy 2 — same INDEX name, different schema.
    await sql`CREATE SCHEMA decoy`;
    await sql`CREATE TABLE decoy.rows (body jsonb)`;
    await sql.unsafe(`CREATE INDEX ${REAL_INDEX} ON decoy.rows USING gin (body)`);
  });

  afterEach(async () => {
    await sql`DROP SCHEMA IF EXISTS decoy CASCADE`;
    await sql`DROP TABLE IF EXISTS decoy_relation CASCADE`;
    await sql.end();
  });

  it('the decoys really are visible to an unscoped lookup — otherwise this file proves nothing', async () => {
    // Guards the guard: if the decoys failed to plant, every assertion below
    // would pass trivially.
    //
    // Asserts presence, not a row count: other schemas in the shared database
    // may hold the same name, and that is not this file's concern.
    const constraintTables = await sql<{ rel: string }[]>`
      SELECT c.conrelid::regclass::text AS rel
      FROM pg_constraint c WHERE c.conname = ${REAL_CONSTRAINT}
    `;
    const indexSchemas = await sql<{ schemaname: string }[]>`
      SELECT schemaname FROM pg_indexes WHERE indexname = ${REAL_INDEX}
    `;
    // The constraint decoy shares the SCHEMA and differs by table; the index
    // decoy shares the NAME and differs by schema. Each assertion names the
    // axis its decoy actually varies.
    expect(
      constraintTables.map((r) => r.rel),
      'decoy constraint did not plant'
    ).toEqual(expect.arrayContaining(['rows', 'decoy_relation']));
    expect(
      indexSchemas.map((r) => r.schemaname),
      'decoy index did not plant'
    ).toEqual(expect.arrayContaining([ownSchema, 'decoy']));
  });

  it('a relation-scoped constraint lookup ignores the same name on another table', async () => {
    const rows = await sql<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'rows'::regclass
        AND contype = 'c'
        AND conname = ${REAL_CONSTRAINT}
    `;
    expect(rows.map((r) => r.conname)).toEqual([REAL_CONSTRAINT]);
  });

  it('a schema-scoped index lookup ignores the same name in another schema', async () => {
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'rows'
        AND indexname = ${REAL_INDEX}
    `;
    expect(rows.map((r) => r.indexname)).toEqual([REAL_INDEX]);
  });

  /**
   * The `tablename`-only form looks scoped and is not: a second schema holding
   * a table of the SAME name matches too, which is exactly what decoy 2
   * constructs.
   */
  it('tablename alone is NOT sufficient — the reason lookups qualify by schema', async () => {
    const byTable = await sql<{ schemaname: string }[]>`
      SELECT schemaname FROM pg_indexes
      WHERE tablename = 'rows' AND indexname = ${REAL_INDEX}
    `;
    const bySchema = await sql<{ schemaname: string }[]>`
      SELECT schemaname FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'rows' AND indexname = ${REAL_INDEX}
    `;
    // Asserts which schemas each form returns, not a count: tablename-only
    // reaches ACROSS schemas, schemaname does not.
    expect(
      byTable.map((r) => r.schemaname),
      'tablename-only should match the decoy too'
    ).toEqual(expect.arrayContaining([ownSchema, 'decoy']));
    expect(
      bySchema.map((r) => r.schemaname),
      'schemaname is what discriminates'
    ).toEqual([ownSchema]);
  });

  /**
   * The decoy constraint is deliberately a CHECK that would reject the values
   * rows accepts. So if a lookup ever resolved to it and something acted
   * on the definition it read, the wrongness is observable rather than
   * cosmetic — the assertion below reads the real constraint's definition and
   * would see the decoy's `'nope'` instead.
   */
  it('reads the real constraint definition, not the decoy that would reject valid values', async () => {
    const rows = await sql<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'rows'::regclass AND conname = ${REAL_CONSTRAINT}
    `;
    expect(rows[0]?.def).toContain('agent');
    expect(rows[0]?.def).not.toContain('nope');
  });
});
