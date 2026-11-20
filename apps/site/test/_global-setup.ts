/**
 * Give this package's pg-gated example a schema of its own before any test file
 * loads, as every pg-gated package does (see `preparePgTestSchema`). A no-op
 * without POSTGRES_URL. Runs in the main process before workers fork, so the
 * rewritten URL reaches every test file.
 */
import {
  assertCannotWriteOutsideTestDatabases,
  assertTestDatabase,
  preparePgTestSchema,
  recreatePgTestSchema
} from '@mnmal-ai/substrate/testing';

export default async function setup(): Promise<void> {
  const packageName = 'apps/site';
  assertTestDatabase(process.env.POSTGRES_URL, { packageName });
  await assertCannotWriteOutsideTestDatabases(process.env.POSTGRES_URL, { packageName });
  const isolated = await preparePgTestSchema(process.env.POSTGRES_URL, {
    packageName,
    createSchema: recreatePgTestSchema
  });
  if (isolated !== undefined) process.env.POSTGRES_URL = isolated;
}
