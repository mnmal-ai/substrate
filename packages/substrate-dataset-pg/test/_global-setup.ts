/**
 * Give this package's pg-gated suites a schema of their own before any test
 * file is loaded. See `preparePgTestSchema` for why a schema rather than a
 * database. Without one, suites that drop and re-migrate shared tables
 * collide when run concurrently against the same database.
 *
 * `globalSetup` runs once per vitest run in the main process, BEFORE any
 * worker is forked — so the rewritten `POSTGRES_URL` is inherited by every
 * test file. `setupFiles` is too late: it runs inside a worker that already
 * has the un-rewritten value.
 */

import postgres from 'postgres';
import { runMigrations } from '../src/migrate.js';
import {
  assertCannotWriteOutsideTestDatabases,
  assertTestDatabase,
  preparePgTestSchema
} from '../src/testing.js';

/**
 * The suite runs once per storage layout, each in a schema of its own that is
 * rebuilt every run, so a layout is always built from a fresh database.
 * `SUBSTRATE_STORAGE_LAYOUT` carries the layout to suites that drop `rows` and
 * re-migrate.
 */
export default async function setup(): Promise<void> {
  const layout = process.env.SUBSTRATE_TEST_LAYOUT ?? 'legacy';
  if (layout !== 'legacy' && layout !== 'partitioned') {
    throw new Error(`SUBSTRATE_TEST_LAYOUT must be 'legacy' or 'partitioned', got '${layout}'`);
  }
  process.env.SUBSTRATE_STORAGE_LAYOUT = layout;
  const packageName = `substrate-dataset-pg-${layout}`;

  // Before preparePgTestSchema, which writes. Here rather than in setupFiles
  // because the reach probe opens a connection per database.
  assertTestDatabase(process.env.POSTGRES_URL, { packageName });
  await assertCannotWriteOutsideTestDatabases(process.env.POSTGRES_URL, { packageName });
  const isolated = await preparePgTestSchema(process.env.POSTGRES_URL, {
    packageName,
    createSchema: recreateSchema
  });
  if (isolated === undefined) return;
  process.env.POSTGRES_URL = isolated;

  const sql = postgres(isolated, { max: 1, onnotice: () => {} });
  try {
    await runMigrations(sql, { layout });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function recreateSchema(url: string, schema: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await sql.unsafe(`CREATE SCHEMA "${schema}"`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
