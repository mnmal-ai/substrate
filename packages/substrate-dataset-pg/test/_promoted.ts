/**
 * Promoted columns for the tests that exercise column routing. The engine
 * creates none, so a test adds its own the way a declaring plugin's
 * migration would.
 */

import type { Sql } from 'postgres';
import type { PromotedBodyColumnMap } from '../src/pg-sql.js';

export const TEST_PROMOTED: PromotedBodyColumnMap = {
  archived: { column: 'archived', kind: 'boolean' },
  project: { column: 'project', kind: 'text' },
  status: { column: 'status', kind: 'text' },
  priority: { column: 'priority', kind: 'text' }
};

export async function addTestPromotedColumns(sql: Sql): Promise<void> {
  await sql`ALTER TABLE rows
    ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS project text,
    ADD COLUMN IF NOT EXISTS status text,
    ADD COLUMN IF NOT EXISTS priority text`;
}

export async function dropTestPromotedColumns(sql: Sql): Promise<void> {
  await sql`ALTER TABLE rows
    DROP COLUMN IF EXISTS archived,
    DROP COLUMN IF EXISTS project,
    DROP COLUMN IF EXISTS status,
    DROP COLUMN IF EXISTS priority`;
}
