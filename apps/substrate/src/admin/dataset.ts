/**
 * Direct-to-pg dataset opener shared by every CLI path that writes `_system`
 * rows without going through the running binary, including
 * `substrate federate enroll`.
 *
 * It never migrates: only `bootstrap` and the server change the schema. A
 * store missing a migration this CLI knows is refused.
 */

import { SYSTEM_NAMESPACE } from '@mnmal-ai/substrate-compose';
import { PgDataset, pendingMigrations } from '@mnmal-ai/substrate-dataset-pg';
import type { Dataset } from '@mnmal-ai/substrate-types';
import type { Sql } from 'postgres';
import { openSql as defaultOpenSql } from '../pg-client.js';
import { redactStore } from './commands/onboard.js';
import { AdminCliError } from './errors.js';

/** The one env var the opener reads. `AdminCliEnv` structurally satisfies it. */
export interface StoreEnv {
  SUBSTRATE_DATABASE_URL?: string;
}

export interface OpenedDataset {
  dataset: Dataset;
  close: () => Promise<void>;
}

export type OpenDatasetFn = (env: StoreEnv) => Promise<OpenedDataset>;

export async function openPgDataset(
  env: StoreEnv,
  openSql: (url: string) => Sql = defaultOpenSql
): Promise<OpenedDataset> {
  const storeSpec = env.SUBSTRATE_DATABASE_URL;
  if (storeSpec === undefined || storeSpec.length === 0) {
    throw new AdminCliError('SUBSTRATE_DATABASE_URL is required (must be a postgres:// URL)');
  }
  if (!storeSpec.startsWith('postgres://') && !storeSpec.startsWith('postgresql://')) {
    throw new AdminCliError(
      `SUBSTRATE_DATABASE_URL must be a postgres:// URL (got '${redactStore(storeSpec)}'). Memory-backed stores cannot persist admin state across restarts.`
    );
  }
  const sql = openSql(storeSpec);
  let pending: string[];
  try {
    pending = await pendingMigrations(sql);
  } catch (err) {
    await closeQuietly(sql);
    throw err;
  }
  if (pending.length > 0) {
    // Close the pool before refusing so we don't leak a live pg connection.
    await closeQuietly(sql);
    throw new AdminCliError(
      `the store at SUBSTRATE_DATABASE_URL is missing migration(s) ${pending.join(', ')}. ` +
        'This command does not migrate: start the server (or run bootstrap) against it, ' +
        'or use a substrate-admin matching the server version.'
    );
  }
  const dataset = new PgDataset({ namespace: SYSTEM_NAMESPACE, sql });
  return { dataset, close: () => closeQuietly(sql) };
}

async function closeQuietly(sql: Sql): Promise<void> {
  try {
    await sql.end();
  } catch {
    // noop
  }
}
