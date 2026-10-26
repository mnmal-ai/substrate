/**
 * Give this package's pg-gated suite a schema of its own, once per storage
 * layout and rebuilt every run, before any worker forks so each inherits the
 * rewritten `POSTGRES_URL`. A no-op without `POSTGRES_URL`.
 */

import { runMigrations } from '@mnmal-ai/substrate-dataset-pg';
import {
  assertCannotWriteOutsideTestDatabases,
  assertNotSuperuser,
  assertTestDatabase,
  preparePgTestSchema,
  recreatePgTestSchema,
  selectPgTestLayout
} from '@mnmal-ai/substrate-dataset-pg/testing';
import postgres from 'postgres';

export default async function setup(): Promise<void> {
  const { layout, packageName } = selectPgTestLayout('substrate-proposals');
  assertTestDatabase(process.env.POSTGRES_URL, { packageName });
  await assertNotSuperuser(process.env.POSTGRES_URL, { packageName });
  await assertCannotWriteOutsideTestDatabases(process.env.POSTGRES_URL, { packageName });
  const isolated = await preparePgTestSchema(process.env.POSTGRES_URL, {
    packageName,
    createSchema: recreatePgTestSchema
  });
  if (isolated === undefined) return;
  process.env.POSTGRES_URL = isolated;
  // Migrate once, here: the migrations build indexes CONCURRENTLY, which wait
  // on every open transaction in the database, and under a test file's 10s
  // hook timeout that wait flaked while other packages' suites ran.
  const sql = postgres(isolated, { max: 1, onnotice: () => {} });
  try {
    await runMigrations(sql, { layout });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
