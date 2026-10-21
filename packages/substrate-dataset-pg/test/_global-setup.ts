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

import {
  assertCannotWriteOutsideTestDatabases,
  assertTestDatabase,
  preparePgTestSchema
} from '../src/testing.js';

export default async function setup(): Promise<void> {
  // Before preparePgTestSchema, which writes. Here rather than in setupFiles
  // because the reach probe opens a connection per database.
  assertTestDatabase(process.env.POSTGRES_URL, { packageName: 'substrate-dataset-pg' });
  await assertCannotWriteOutsideTestDatabases(process.env.POSTGRES_URL, {
    packageName: 'substrate-dataset-pg'
  });
  const isolated = await preparePgTestSchema(process.env.POSTGRES_URL, {
    packageName: 'substrate-dataset-pg'
  });
  if (isolated !== undefined) process.env.POSTGRES_URL = isolated;
}
