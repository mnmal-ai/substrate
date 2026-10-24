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
  preparePgTestSchema,
  recreatePgTestSchema,
  selectPgTestLayout
} from '../src/testing.js';

/**
 * The suite runs once per storage layout, each in a schema of its own that is
 * rebuilt every run, so a layout is always built from a fresh database.
 */
export default async function setup(): Promise<void> {
  const { layout, packageName } = selectPgTestLayout('substrate-dataset-pg');

  // Before preparePgTestSchema, which writes. Here rather than in setupFiles
  // because the reach probe opens a connection per database.
  assertTestDatabase(process.env.POSTGRES_URL, { packageName });
  await assertCannotWriteOutsideTestDatabases(process.env.POSTGRES_URL, { packageName });
  const isolated = await preparePgTestSchema(process.env.POSTGRES_URL, {
    packageName,
    createSchema: recreatePgTestSchema
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
