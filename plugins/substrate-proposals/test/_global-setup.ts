/**
 * Give this package's pg-gated suite a schema of its own, once per storage
 * layout and rebuilt every run, before any worker forks so each inherits the
 * rewritten `POSTGRES_URL`. A no-op without `POSTGRES_URL`.
 */

import {
  assertCannotWriteOutsideTestDatabases,
  assertNotSuperuser,
  assertTestDatabase,
  preparePgTestSchema,
  recreatePgTestSchema,
  selectPgTestLayout
} from '@mnmal-ai/substrate-dataset-pg/testing';

export default async function setup(): Promise<void> {
  const { packageName } = selectPgTestLayout('substrate-proposals');
  assertTestDatabase(process.env.POSTGRES_URL, { packageName });
  await assertNotSuperuser(process.env.POSTGRES_URL, { packageName });
  await assertCannotWriteOutsideTestDatabases(process.env.POSTGRES_URL, { packageName });
  const isolated = await preparePgTestSchema(process.env.POSTGRES_URL, {
    packageName,
    createSchema: recreatePgTestSchema
  });
  if (isolated !== undefined) process.env.POSTGRES_URL = isolated;
}
