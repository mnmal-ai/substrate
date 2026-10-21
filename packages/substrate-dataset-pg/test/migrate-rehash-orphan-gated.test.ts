/**
 * runMigrations — rehash loop must iterate the FULL migration list (BASE +
 * gated 0002) regardless of the env-var gate, so an orphan gated row whose
 * recorded checksum drifts still gets rehashed.
 *
 * Scenario: a deployment ran once with `SUBSTRATE_ENFORCE_UUID_CHECK=true`,
 * landing 0002 in `migrations`, then boots with the flag off. A
 * gate-respecting rehash would skip 0002 (absent from
 * `getMigrationList(false)`), stranding its stale checksum so a later flip
 * back to `true` trips MigrationChecksumDriftError.
 *
 * Pure unit test using the same fake `Sql` pattern as
 * `migrate-checksum-rehash.test.ts` — no POSTGRES_URL needed.
 */

import type { Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

function makeFakeSqlForRehash(appliedRows: ReadonlyArray<AppliedRow>): {
  sql: Sql;
  ranStatements: string[];
  updates: UpdateCall[];
} {
  const ranStatements: string[] = [];
  const updates: UpdateCall[] = [];
  const liveRows: AppliedRow[] = appliedRows.map((r) => ({ ...r }));

  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').trim();
    ranStatements.push(text);

    if (/^SELECT version, checksum FROM migrations/i.test(text)) {
      return Promise.resolve(liveRows.map((r) => ({ ...r })));
    }

    if (/^SELECT pg_try_advisory_lock\(/i.test(text)) {
      return Promise.resolve([{ acquired: true }]);
    }

    const updateMatch = /^UPDATE migrations SET checksum = \?\s+WHERE version = \?/i.test(text);
    if (updateMatch && values.length >= 2) {
      const newChecksum = values[0] as string;
      const version = values[1] as string;
      updates.push({ version, newChecksum });
      const row = liveRows.find((r) => r.version === version);
      if (row) row.checksum = newChecksum;
      return Promise.resolve([]);
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

describe('runMigrations — rehash loop iterates full migration list', () => {
  let prevEnforce: string | undefined;

  beforeEach(() => {
    prevEnforce = process.env.SUBSTRATE_ENFORCE_UUID_CHECK;
    delete process.env.SUBSTRATE_ENFORCE_UUID_CHECK;
  });

  afterEach(() => {
    if (prevEnforce === undefined) {
      delete process.env.SUBSTRATE_ENFORCE_UUID_CHECK;
    } else {
      process.env.SUBSTRATE_ENFORCE_UUID_CHECK = prevEnforce;
    }
  });

  it('rehashes an orphan gated 0002 row even when enforceUuidCheck=false', async () => {
    // Sanity: the gated migration is in the full list but NOT in the base list.
    const full = getMigrationList(true);
    const base = getMigrationList(false);
    const gated = full.find((m) => m.version === '0002_uuid_format_check');
    expect(gated).toBeDefined();
    expect(base.find((m) => m.version === '0002_uuid_format_check')).toBeUndefined();

    // Seed every BASE migration with current checksum + a stale 0002 row that
    // looks like it was applied during a prior gate-on boot but now has a
    // recorded checksum that doesn't match the current binary's computation.
    const staleGatedValue = 'legacy_format_checksum_for_0002';
    const appliedRows: AppliedRow[] = [
      ...MIGRATIONS.map((m) => ({ version: m.version, checksum: checksum(m) })),
      { version: gated!.version, checksum: staleGatedValue }
    ];

    const { sql, ranStatements, updates } = makeFakeSqlForRehash(appliedRows);
    const stderr = captureStderr();
    try {
      // Explicitly call with enforceUuidCheck=false — the verify loop should
      // skip 0002 (gate is off) but the rehash loop should still rewrite the
      // stale gated row.
      await expect(runMigrations(sql, { enforceUuidCheck: false })).resolves.toBeUndefined();
    } finally {
      stderr.restore();
    }

    // Exactly one UPDATE — for the orphan gated row.
    expect(updates).toHaveLength(1);
    expect(updates[0]?.version).toBe('0002_uuid_format_check');
    expect(updates[0]?.newChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(updates[0]?.newChecksum).not.toBe(staleGatedValue);
    expect(updates[0]?.newChecksum).toBe(checksum(gated!));

    // WARN log named the gated version.
    expect(stderr.joined()).toContain('0002_uuid_format_check');
    expect(stderr.joined()).toContain('rehash');

    // Verify loop did NOT re-apply 0002 (enforceUuidCheck=false leaves it out
    // of the iterated verify list, and the recorded row exists post-rehash).
    expect(ranStatements.some((s) => s.startsWith('UNSAFE:'))).toBe(false);
  });

  it('is idempotent: a current 0002 row triggers no UPDATE even with enforceUuidCheck=false', async () => {
    const full = getMigrationList(true);
    const gated = full.find((m) => m.version === '0002_uuid_format_check');
    expect(gated).toBeDefined();

    // 0002 row is already at the current checksum.
    const appliedRows: AppliedRow[] = [
      ...MIGRATIONS.map((m) => ({ version: m.version, checksum: checksum(m) })),
      { version: gated!.version, checksum: checksum(gated!) }
    ];

    const { sql, ranStatements, updates } = makeFakeSqlForRehash(appliedRows);
    const stderr = captureStderr();
    try {
      await expect(runMigrations(sql, { enforceUuidCheck: false })).resolves.toBeUndefined();
    } finally {
      stderr.restore();
    }

    // No UPDATE — every recorded checksum (gated and ungated) already matches.
    expect(updates).toHaveLength(0);
    expect(ranStatements.some((s) => /UPDATE migrations/i.test(s))).toBe(false);
  });

  it('rehashes a stale gated row + a stale base row in the same boot', async () => {
    const full = getMigrationList(true);
    const gated = full.find((m) => m.version === '0002_uuid_format_check');
    expect(gated).toBeDefined();

    const staleBase = '0001_baseline';
    const appliedRows: AppliedRow[] = [
      ...MIGRATIONS.map((m) => ({
        version: m.version,
        checksum: m.version === staleBase ? `stale_${m.version}` : checksum(m)
      })),
      { version: gated!.version, checksum: 'stale_for_gated' }
    ];

    const { sql, updates } = makeFakeSqlForRehash(appliedRows);
    const stderr = captureStderr();
    try {
      await expect(runMigrations(sql, { enforceUuidCheck: false })).resolves.toBeUndefined();
    } finally {
      stderr.restore();
    }

    expect(updates).toHaveLength(2);
    const versions = updates.map((u) => u.version).sort();
    expect(versions).toEqual([staleBase, '0002_uuid_format_check'].sort());
  });
});
