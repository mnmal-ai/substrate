/**
 * runMigrations — one-shot rehash for checksum-format upgrades.
 *
 * Pure unit tests with a fake `Sql` (same pattern as
 * migrate-checksum-drift.test.ts) so the suite runs without POSTGRES_URL.
 * Verifies:
 *   - Stale recorded checksum is rewritten in-place (UPDATE fires) + boot
 *     proceeds past the verify loop without throwing.
 *   - WARN log is emitted with both old + new checksums for operator audit.
 *   - Already-current rows trigger no UPDATE (idempotency on re-runs).
 *   - Rows whose version isn't in MIGRATIONS (operator deleted the file or
 *     migrations carries leftover rows) are silently skipped — no
 *     UPDATE, no throw.
 *
 * A checksum-format change (same SQL, different hash) must not strand
 * existing deployments, so recorded checksums are rewritten on boot.
 */

import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';
import { checksum, getMigrationList, MIGRATIONS } from '../src/migrate.js';

interface AppliedRow {
  version: string;
  checksum: string;
}

interface UpdateCall {
  version: string;
  newChecksum: string;
}

/**
 * Fake `Sql` whose `migrations` SELECT returns `appliedRows`, and which
 * captures each `UPDATE migrations SET checksum` as
 * `(version, newChecksum)` from the template-tag `values` array.
 */
function makeFakeSqlForRehash(appliedRows: ReadonlyArray<AppliedRow>): {
  sql: Sql;
  ranStatements: string[];
  updates: UpdateCall[];
} {
  const ranStatements: string[] = [];
  const updates: UpdateCall[] = [];
  // Mutable copy so the runner's verify loop sees the rehashed value if
  // the rehash UPDATE fired. Production pg fetches a fresh row; the fake
  // emulates by mutating the in-memory copy on UPDATE.
  const liveRows: AppliedRow[] = appliedRows.map((r) => ({ ...r }));

  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').trim();
    if (/current_setting\('server_version_num'\)/.test(text)) {
      return Promise.resolve([{ num: 180000 }]);
    }
    ranStatements.push(text);

    if (/^SELECT version, checksum FROM migrations/i.test(text)) {
      return Promise.resolve(liveRows.map((r) => ({ ...r })));
    }

    if (/^SELECT pg_try_advisory_lock\(/i.test(text)) {
      return Promise.resolve([{ acquired: true }]);
    }

    // UPDATE migrations SET checksum = $newChecksum WHERE version = $version
    // postgres.js places the values in the `values` array in order of `${...}`
    // appearance: [newChecksum, version].
    const updateMatch = /^UPDATE migrations SET checksum = \?\s+WHERE version = \?/i.test(text);
    if (updateMatch && values.length >= 2) {
      const newChecksum = values[0] as string;
      const version = values[1] as string;
      updates.push({ version, newChecksum });
      // Mutate liveRows so subsequent SELECTs (none in this codepath) would
      // see the rewritten value.
      const row = liveRows.find((r) => r.version === version);
      if (row) row.checksum = newChecksum;
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as Sql;
  // biome-ignore lint/suspicious/noExplicitAny: stubbing the postgres-js shape
  (tag as any).unsafe = (text: string) => {
    // The migration lock is polled and released through unsafe, as the tag ran it before.
    if (/pg_(try_)?advisory_(un)?lock\(/.test(text)) {
      ranStatements.push(text.trim());
      return Promise.resolve(/pg_try_advisory_lock\(/.test(text) ? [{ acquired: true }] : []);
    }
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
  return { sql: tag, ranStatements, updates };
}

function captureStderr(): {
  restore: () => void;
  joined: () => string;
} {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  // biome-ignore lint/suspicious/noExplicitAny: capturing stderr writes
  process.stderr.write = ((chunk: any) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    restore: (): void => {
      process.stderr.write = orig;
    },
    joined: (): string => chunks.join('')
  };
}

describe('runMigrations — one-shot checksum rehash', () => {
  it('rewrites a stale recorded checksum in-place + boot succeeds', async () => {
    // Seed every migration with the CURRENT checksum, then make one stale.
    // The rehash must rewrite it before the verify loop sees it.
    const staleVersion = '0001_baseline';
    const staleValue = 'legacy_format_checksum_94ae4a84';
    const appliedRows = MIGRATIONS.map((m) => ({
      version: m.version,
      checksum: m.version === staleVersion ? staleValue : checksum(m)
    }));

    const { sql, ranStatements, updates } = makeFakeSqlForRehash(appliedRows);
    const stderr = captureStderr();
    try {
      await expect(runMigrations(sql)).resolves.toBeUndefined();
    } finally {
      stderr.restore();
    }

    // Exactly one UPDATE for the stale row.
    expect(updates).toHaveLength(1);
    expect(updates[0]?.version).toBe(staleVersion);
    expect(updates[0]?.newChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(updates[0]?.newChecksum).not.toBe(staleValue);

    // No migration was actually re-applied (no UNSAFE statements ran) —
    // post-rehash, the verify loop sees matching checksums and skips
    // every migration cleanly.
    expect(ranStatements.some((s) => s.startsWith('UNSAFE:'))).toBe(false);
  });

  it('emits a WARN-level stderr log per rewrite naming version + both checksums', async () => {
    const staleVersion = '0001_baseline';
    const staleValue = 'legacy_format_checksum_94ae4a84';
    const appliedRows = MIGRATIONS.map((m) => ({
      version: m.version,
      checksum: m.version === staleVersion ? staleValue : checksum(m)
    }));

    const { sql } = makeFakeSqlForRehash(appliedRows);
    const stderr = captureStderr();
    try {
      await runMigrations(sql);
    } finally {
      stderr.restore();
    }

    const log = stderr.joined();
    // Names migration version
    expect(log).toContain(staleVersion);
    // Mentions the old checksum (truncated to 12 chars per existing log style)
    expect(log).toContain(staleValue.slice(0, 12));
    // Carries an actionability hint operators can grep for
    expect(log).toContain('rehash');
  });

  it('is idempotent: already-current rows trigger no UPDATE', async () => {
    // Every recorded checksum already matches the current MIGRATIONS list.
    const appliedRows = MIGRATIONS.map((m) => ({
      version: m.version,
      checksum: checksum(m)
    }));

    const { sql, ranStatements, updates } = makeFakeSqlForRehash(appliedRows);
    const stderr = captureStderr();
    try {
      await expect(runMigrations(sql)).resolves.toBeUndefined();
    } finally {
      stderr.restore();
    }

    // Zero UPDATEs.
    expect(updates).toHaveLength(0);
    // No UPDATE-shape statements ran at all.
    expect(ranStatements.some((s) => /UPDATE migrations/i.test(s))).toBe(false);
  });

  it('silently skips rows whose version is not in MIGRATIONS — no UPDATE, no throw', async () => {
    // migrations carries an extra row from a deleted/renamed migration
    // file. The rehash must NOT touch it; the verify loop also doesn't iterate
    // it (it iterates MIGRATIONS, not the applied set). Boot proceeds.
    const appliedRows = [
      ...MIGRATIONS.map((m) => ({ version: m.version, checksum: checksum(m) })),
      { version: '9999_orphaned_migration', checksum: 'orphaned_checksum_value' }
    ];

    const { sql, updates } = makeFakeSqlForRehash(appliedRows);
    const stderr = captureStderr();
    try {
      await expect(runMigrations(sql)).resolves.toBeUndefined();
    } finally {
      stderr.restore();
    }

    // The orphaned row was NOT rewritten.
    expect(updates.find((u) => u.version === '9999_orphaned_migration')).toBeUndefined();
    // No UPDATE fired at all (every known row is already current).
    expect(updates).toHaveLength(0);
  });

  it('rewrites multiple stale rows in one boot', async () => {
    // Two stale rows — rehash should fix both before the verify loop runs.
    // The full list (with the gated 0002) supplies the second migration.
    const stale1 = '0001_baseline';
    const stale2 = '0002_uuid_format_check';
    const appliedRows = getMigrationList(true).map((m) => ({
      version: m.version,
      checksum:
        m.version === stale1 || m.version === stale2 ? `stale_for_${m.version}` : checksum(m)
    }));

    const { sql, ranStatements, updates } = makeFakeSqlForRehash(appliedRows);
    const stderr = captureStderr();
    try {
      await expect(runMigrations(sql)).resolves.toBeUndefined();
    } finally {
      stderr.restore();
    }

    expect(updates).toHaveLength(2);
    const versions = updates.map((u) => u.version).sort();
    expect(versions).toEqual([stale1, stale2].sort());
    expect(ranStatements.some((s) => s.startsWith('UNSAFE:'))).toBe(false);
  });
});
