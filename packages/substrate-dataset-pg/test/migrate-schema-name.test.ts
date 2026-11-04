/**
 * `runMigrations` refuses at once when the current schema is missing or is not
 * a plain lowercase name. A missing schema would otherwise make the migration
 * lock key NULL, and the poll for it would never succeed.
 *
 * Skipped unless POSTGRES_URL is set.
 */

import { randomBytes } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoCurrentSchemaError, runMigrations, UnsupportedSchemaNameError } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('runMigrations schema checks (pg)', () => {
  let sql: Sql;
  const created: string[] = [];

  beforeEach(() => {
    // One connection, so the SET reaches the migration runner's queries.
    sql = postgres(POSTGRES_URL as string, { max: 1, onnotice: () => {} });
  });

  afterEach(async () => {
    for (const schema of created.splice(0)) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await sql.end({ timeout: 5 });
  });

  /** Runs migrations and returns what they threw, failing if they succeeded. */
  async function refusal(): Promise<Error> {
    const err = await runMigrations(sql).then(
      () => undefined,
      (e: unknown) => e
    );
    if (!(err instanceof Error)) throw new Error('runMigrations was expected to refuse');
    expect(err.message).not.toContain(new URL(POSTGRES_URL as string).host);
    return err;
  }

  it('rejects quickly when the search_path names no existing schema', async () => {
    await sql.unsafe(`SET search_path TO substrate_absent_${randomBytes(4).toString('hex')}`);
    const started = Date.now();
    const err = await refusal();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(err).toBeInstanceOf(NoCurrentSchemaError);
  }, 10_000);

  it.each(['-', '.'])('refuses a schema name containing %s, naming it', async (sep) => {
    const schema = `substrate${sep}name_${randomBytes(4).toString('hex')}`;
    created.push(schema);
    await sql.unsafe(`CREATE SCHEMA "${schema}"`);
    await sql.unsafe(`SET search_path TO "${schema}"`);
    const err = await refusal();
    expect(err).toBeInstanceOf(UnsupportedSchemaNameError);
    expect(err.message).toContain(schema);
    // Refused before anything was created there.
    const [row] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema}`;
    expect(row?.n).toBe(0);
  });
});
