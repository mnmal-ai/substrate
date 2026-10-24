/**
 * Creates the `rows` table the recall stores join against, through the real
 * migrations, so it has the layout this run selected. Idempotent, so every
 * pg-gated suite can call it whatever order the files run in.
 */

import { runMigrations } from '@mnmal-ai/substrate-dataset-pg';
import type postgres from 'postgres';

export async function ensureRows(sql: ReturnType<typeof postgres>): Promise<void> {
  await runMigrations(sql);
}
