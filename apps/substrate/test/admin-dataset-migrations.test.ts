/**
 * Only bootstrap migrates. Every other direct-to-pg admin path checks the
 * store's applied migrations and refuses a store that is behind.
 */

import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { openPgDataset } from '../src/admin/dataset.js';

/** A fresh database: no `migrations` table. Records every statement and whether the pool closed. */
function freshStore(): { sql: Sql; statements: string[]; closed: () => boolean } {
  const statements: string[] = [];
  let closed = false;
  const sql = Object.assign(
    async (strings: TemplateStringsArray) => {
      const text = strings.join('?');
      statements.push(text);
      return text.includes('to_regclass') ? [{ present: false }] : [];
    },
    {
      end: async () => {
        closed = true;
      }
    }
  ) as unknown as Sql;
  return { sql, statements, closed: () => closed };
}

describe('openPgDataset', () => {
  it('refuses an unmigrated store without migrating it', async () => {
    const store = freshStore();
    await expect(
      openPgDataset({ SUBSTRATE_DATABASE_URL: 'postgres://h/db' }, () => store.sql)
    ).rejects.toThrow(/missing migration\(s\) 0001.*does not migrate/s);
    expect(store.statements.some((s) => /CREATE|ALTER|INSERT/i.test(s))).toBe(false);
    expect(store.closed()).toBe(true);
  });
});
