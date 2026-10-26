/**
 * Creates the `rows` table the recall stores join against, through the real
 * migrations, so it has the layout this run selected. Called once, from
 * `_global-setup.ts`: the migrations build indexes CONCURRENTLY, which wait on
 * every open transaction in the database, so they must not run under a hook
 * timeout while other packages' suites hold transactions.
 */

import { runMigrations } from '@mnmal-ai/substrate-dataset-pg';
import type postgres from 'postgres';

export async function ensureRows(sql: ReturnType<typeof postgres>): Promise<void> {
  await runMigrations(sql);
}
