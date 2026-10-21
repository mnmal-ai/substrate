/**
 * runMigrations clean boot: when every migration is already applied with its
 * current checksum, no UNSAFE statement and no rehash UPDATE runs.
 *
 * Drift-rewrite semantics live in `migrate-checksum-rehash.test.ts`.
 */

import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';
import { checksum, MIGRATIONS } from '../src/migrate.js';

/**
 * Fake `Sql` whose `migrations` SELECT returns `appliedRows`. Records
 * every statement run in `ranStatements`, prefixing `unsafe()` text with
 * `UNSAFE: `.
 */
function makeFakeSqlWithApplied(
  appliedRows: ReadonlyArray<{ version: string; checksum: string }>
): { sql: Sql; ranStatements: string[] } {
  const ranStatements: string[] = [];
  const tag = ((strings: TemplateStringsArray, ..._values: unknown[]) => {
    const text = strings.join('?').trim();
    ranStatements.push(text);
    if (/^SELECT version, checksum FROM migrations/i.test(text)) {
      return Promise.resolve(appliedRows.map((r) => ({ ...r })));
    }
    if (/^SELECT pg_try_advisory_lock\(/i.test(text)) {
      return Promise.resolve([{ acquired: true }]);
    }
    return Promise.resolve([]);
  }) as unknown as Sql;
  // biome-ignore lint/suspicious/noExplicitAny: stubbing the postgres-js shape
  (tag as any).unsafe = (text: string) => {
    ranStatements.push(`UNSAFE: ${text}`);
    return Promise.resolve([]);
  };
  // The migration lock is held on a reserved connection; the stub is its own.
  // biome-ignore lint/suspicious/noExplicitAny: stubbing the postgres-js shape
  (tag as any).reserve = async () => Object.assign(tag, { release: () => {} });
  // biome-ignore lint/suspicious/noExplicitAny: stubbing the postgres-js shape
  (tag as any).begin = async (cb: (tx: Sql) => Promise<unknown>) => {
    await cb(tag);
  };
  return { sql: tag, ranStatements };
}

describe('runMigrations — clean boot (no POSTGRES_URL needed)', () => {
  it('does not throw and runs no migrations when every recorded checksum matches current', async () => {
    // Seed the correct current checksum for EVERY migration, computed with
    // the runner's own helper so the test follows its hashing scheme.
    const appliedRows = MIGRATIONS.map((m) => ({
      version: m.version,
      checksum: checksum(m)
    }));
    const { sql, ranStatements } = makeFakeSqlWithApplied(appliedRows);
    await expect(runMigrations(sql)).resolves.toBeUndefined();
    // No `UNSAFE: ...` should have run — every migration was already
    // applied and the runner skipped them all.
    expect(ranStatements.some((s) => s.startsWith('UNSAFE:'))).toBe(false);
    // No UPDATE either — clean boot means nothing to rehash.
    expect(ranStatements.some((s) => /UPDATE migrations/i.test(s))).toBe(false);
  });
});
