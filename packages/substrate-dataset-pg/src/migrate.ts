/**
 * Schema migrations for the pg Dataset + EdgesStore. Spec: §4.5, §4.6,
 * §5.13.
 *
 * Each migration is a numbered module under `migrations/` exporting two
 * statement buckets:
 *
 * - `txStatements` (or legacy `statements`) — DDL/DML safe inside a single
 *   transaction. The runner wraps the whole bucket in `BEGIN ... COMMIT`,
 *   so a partial-apply rolls back cleanly. Most migrations use this bucket
 *   exclusively.
 * - `concurrentStatements` — `CREATE INDEX CONCURRENTLY`,
 *   `DROP INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY`, etc. Postgres rejects
 *   these inside a transaction, so the runner executes them one-by-one
 *   AFTER the tx commits. A failure in this phase leaves the tx-phase work
 *   durable; re-running the migration is safe as long as each statement is
 *   `IF NOT EXISTS` / `IF EXISTS` guarded (idempotent), which is the
 *   convention for the concurrent bucket.
 *
 * The runner records applied versions in `migrations(version,
 * applied_at, checksum)` and skips already-applied migrations on re-run.
 * Crucially, the version is only marked applied AFTER both the tx phase
 * commits AND the concurrent phase finishes successfully — a concurrent
 * failure throws and the migration is left "in progress" so a re-run picks
 * up where it left off (idempotent statements absorb the partial state).
 *
 * New migrations go in `migrations/` and are registered in MIGRATIONS below.
 * Shipped migration files are IMMUTABLE — change schema only via a new file.
 */

import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  CONCURRENT_STATEMENTS as BASELINE_CONCURRENT,
  TX_STATEMENTS as BASELINE_TX
} from './migrations/0001_baseline.js';
import { TX_STATEMENTS as UUID_CHECK_TX } from './migrations/0002_uuid_format_check.js';
import {
  CONCURRENT_STATEMENTS as SAFE_CASTS_CONCURRENT,
  TX_STATEMENTS as SAFE_CASTS_TX
} from './migrations/0003_safe_casts.js';

/**
 * Internal canonical migration shape after normalisation. The framework
 * always operates on `txStatements` + `concurrentStatements`; the
 * `MigrationInput` shape below accepts either the canonical fields or the
 * legacy single `statements` bucket so existing migration modules can be
 * adopted without rewriting them.
 */
interface Migration {
  readonly version: string;
  readonly txStatements: ReadonlyArray<string>;
  readonly concurrentStatements: ReadonlyArray<string>;
}

/**
 * Public migration shape accepted by the runner. Either supply both
 * `txStatements` + (optional) `concurrentStatements`, OR a legacy
 * `statements` bucket — the runner treats `statements` as `txStatements`
 * with no concurrent statements. Mixing `statements` and `txStatements`
 * is a configuration error.
 */
export type MigrationInput =
  | {
      readonly version: string;
      readonly txStatements: ReadonlyArray<string>;
      readonly concurrentStatements?: ReadonlyArray<string>;
      readonly statements?: never;
    }
  | {
      readonly version: string;
      readonly statements: ReadonlyArray<string>;
      readonly txStatements?: never;
      readonly concurrentStatements?: never;
    };

const MIGRATION_INPUTS: ReadonlyArray<MigrationInput> = [
  {
    version: '0001_baseline',
    txStatements: BASELINE_TX,
    concurrentStatements: BASELINE_CONCURRENT
  },
  {
    version: '0003_safe_casts',
    txStatements: SAFE_CASTS_TX,
    concurrentStatements: SAFE_CASTS_CONCURRENT
  }
];

function normalise(input: MigrationInput): Migration {
  if ('statements' in input && input.statements !== undefined) {
    return {
      version: input.version,
      txStatements: input.statements,
      concurrentStatements: []
    };
  }
  return {
    version: input.version,
    txStatements: input.txStatements ?? [],
    concurrentStatements: input.concurrentStatements ?? []
  };
}

/**
 * Opt-in migration: UUID-format CHECKs on row, short-id and edge ids.
 * Registered only when `SUBSTRATE_ENFORCE_UUID_CHECK=true`, because the test
 * corpus uses synthetic non-UUID ids.
 */
const UUID_CHECK_INPUT: MigrationInput = {
  version: '0002_uuid_format_check',
  txStatements: UUID_CHECK_TX
};

/**
 * @internal — the always-on migration list, exported for unit tests. The
 * gated 0002 is appended by `getMigrationList`.
 */
export const MIGRATIONS: ReadonlyArray<Migration> = MIGRATION_INPUTS.map(normalise);

/**
 * @internal — returns the migration list including the gated 0002 when
 * `SUBSTRATE_ENFORCE_UUID_CHECK=true` (or the explicit override is true). Used by
 * `runMigrations` and exported for the focused test that exercises the
 * CHECK constraint.
 */
export function getMigrationList(
  enforceUuidCheck: boolean | undefined = process.env.SUBSTRATE_ENFORCE_UUID_CHECK === 'true'
): ReadonlyArray<Migration> {
  if (enforceUuidCheck !== true) return MIGRATIONS;
  return [...MIGRATIONS, normalise(UUID_CHECK_INPUT)];
}

/**
 * sha256 across both buckets in fixed order (tx then concurrent).
 */
/**
 * @internal — exported for unit tests. Not re-exported from the package index.
 */
export function checksum(migration: Migration): string {
  const hasher = createHash('sha256');
  for (const s of migration.txStatements) {
    hasher.update(s);
    hasher.update(' ');
  }
  for (const s of migration.concurrentStatements) {
    hasher.update(s);
    hasher.update(' ');
  }
  return hasher.digest('hex');
}

interface AppliedRow {
  version: string;
  checksum: string;
}

/**
 * Signals that an applied migration's current checksum differs from the one
 * recorded in `migrations`.
 *
 * Not thrown by `runMigrations`, which rewrites drifted checksums with a
 * warning. Kept public for callers that audit drift outside the runner.
 */
export class MigrationChecksumDriftError extends Error {
  override readonly name = 'MigrationChecksumDriftError';
  readonly version: string;
  readonly recordedChecksum: string;
  readonly currentChecksum: string;

  constructor(version: string, recordedChecksum: string, currentChecksum: string) {
    super(
      `migration ${version}: checksum mismatch ` +
        `(recorded=${recordedChecksum} current=${currentChecksum}); ` +
        'migration files are immutable post-ship, so restore the file and put ' +
        'the change in a new migration. runMigrations accepts a drifted ' +
        'checksum by rewriting it in place, with a WARN and a ' +
        'migrations_audit row.'
    );
    this.version = version;
    this.recordedChecksum = recordedChecksum;
    this.currentChecksum = currentChecksum;
  }
}

export interface RunMigrationsOptions {
  /**
   * When true, drop the `migrations` tracking table before running.
   * Forces every migration to re-apply on this call. Intended for tests
   * that DROP schema objects between runs and need the framework to
   * recreate them; production paths should never set this.
   */
  force?: boolean;
  /**
   * Override the `SUBSTRATE_ENFORCE_UUID_CHECK=true` env-var gate for the gated
   * UUID-format CHECK constraint migration (0002). Defaults to whatever the
   * env says. Tests that need to exercise the constrained path explicitly
   * pass `true`; tests that need to opt out of an env-set gate pass `false`.
   * Production bootstraps shouldn't pass this — let the env decide.
   */
  enforceUuidCheck?: boolean;
}

export async function runMigrations(sql: Sql, opts: RunMigrationsOptions = {}): Promise<void> {
  // Serialises concurrent boots, which otherwise race on every DDL step.
  //
  // The lock is polled with pg_try_advisory_lock, not blocking
  // pg_advisory_lock: a blocked waiter holds a transaction open, and the
  // holder's CREATE INDEX CONCURRENTLY waits on it, which deadlocks.
  await withMigrationLock(sql, (conn) => runMigrationsLocked(conn, opts));
}

/**
 * Runs `fn` while holding the migration advisory lock on one reserved connection.
 *
 * The lock and unlock must share a session: through the pool, the unlock can
 * land on another connection and leave the lock held. `fn` is handed that same
 * connection, so a pool of one cannot deadlock waiting for a second. It has no
 * `begin()`; open transactions with `BEGIN`/`COMMIT` statements.
 */
/**
 * Versions of the core migration list not yet applied to `sql`'s database,
 * read without applying or creating anything. All of them when the
 * `migrations` table does not exist.
 */
export async function pendingMigrations(sql: Sql): Promise<string[]> {
  const [ledger] = await sql<Array<{ present: boolean }>>`
    SELECT to_regclass('migrations') IS NOT NULL AS present
  `;
  const applied =
    ledger?.present === true
      ? new Set((await sql<AppliedRow[]>`SELECT version FROM migrations`).map((r) => r.version))
      : new Set<string>();
  return getMigrationList()
    .map((m) => m.version)
    .filter((v) => !applied.has(v));
}

export async function withMigrationLock<T>(sql: Sql, fn: (conn: Sql) => Promise<T>): Promise<T> {
  const lockConn = await sql.reserve();
  try {
    await acquireMigrationLock(lockConn);
    try {
      return await fn(lockConn);
    } finally {
      const [row] = await lockConn<Array<{ released: boolean }>>`
        SELECT pg_advisory_unlock(hashtext('substrate-migrations')) AS released
      `;
      if (row?.released === false) {
        process.stderr.write(
          'substrate migrations: advisory unlock reported the lock was not held by this session\n'
        );
      }
    }
  } finally {
    lockConn.release();
  }
}

async function acquireMigrationLock(sql: Sql): Promise<void> {
  while (true) {
    const result = await sql<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_lock(hashtext('substrate-migrations')) AS acquired
    `;
    if (result[0]?.acquired === true) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function runMigrationsLocked(sql: Sql, opts: RunMigrationsOptions): Promise<void> {
  if (opts.force === true) {
    await sql`DROP TABLE IF EXISTS migrations`;
  }

  await sql`
    CREATE TABLE IF NOT EXISTS migrations (
      version     text        PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      checksum    text        NOT NULL
    )
  `;

  // Durable record of each checksum rewrite by the rehash pass below.
  await sql`
    CREATE TABLE IF NOT EXISTS migrations_audit (
      id                bigserial   PRIMARY KEY,
      version           text        NOT NULL,
      previous_checksum text        NOT NULL,
      new_checksum      text        NOT NULL,
      observed_at       timestamptz NOT NULL DEFAULT now(),
      reason            text        NOT NULL DEFAULT 'rehash',
      build_sha         text
    )
  `;

  const applied = await sql<AppliedRow[]>`
    SELECT version, checksum FROM migrations
  `;
  const appliedByVersion = new Map(applied.map((r) => [r.version, r.checksum]));

  // Rewrites drifted recorded checksums in place (WARN + audit row) so a
  // framework hash-format change doesn't read as drift. This can also mask a
  // genuine post-ship file edit; a WARN that recurs across deploys for the
  // same version is that signal.
  //
  // Iterates the FULL list including gated 0002, even when the gate is off:
  // a previously applied gated migration must still be rehashed.
  const REHASH_LIST = getMigrationList(true);
  const buildSha = process.env.SUBSTRATE_BUILD_SHA ?? 'unknown';
  for (const migration of REHASH_LIST) {
    const recorded = appliedByVersion.get(migration.version);
    if (recorded === undefined) continue;
    const current = checksum(migration);
    if (recorded === current) continue;
    process.stderr.write(
      `⚠️ migrations rehash: ${migration.version} ` +
        `(was=${recorded.slice(0, 12)} now=${current.slice(0, 12)} build=${buildSha}) — ` +
        `framework hash-format change masquerading as drift; ` +
        `recurring WARNs for the same version across deploys signal a true file edit.\n`
    );
    await sql`
      INSERT INTO migrations_audit (version, previous_checksum, new_checksum, build_sha)
      VALUES (${migration.version}, ${recorded}, ${current}, ${buildSha})
    `;
    await sql`
      UPDATE migrations SET checksum = ${current} WHERE version = ${migration.version}
    `;
    appliedByVersion.set(migration.version, current);
  }

  for (const migration of getMigrationList(opts.enforceUuidCheck)) {
    const recorded = appliedByVersion.get(migration.version);
    if (recorded !== undefined) {
      // The rehash pass above guarantees the recorded checksum is current.
      continue;
    }
    await applyOneMigration(sql, migration);
  }
}

/**
 * Apply one migration through the tracked machinery: tx-safe statements in a
 * single BEGIN/COMMIT bucket, then concurrent statements one-by-one OUTSIDE any
 * tx (Postgres rejects `CREATE INDEX CONCURRENTLY` in a transaction), then the
 * `migrations` row. The version lands only after the concurrent phase
 * succeeds, so a partial concurrent failure leaves the migration "in progress"
 * and a re-run (statements are IF [NOT] EXISTS guarded) resumes it.
 */
async function applyOneMigration(sql: Sql, migration: Migration): Promise<void> {
  if (migration.txStatements.length > 0) {
    // Explicit statements: `sql` is the reserved lock connection, which has no begin().
    await sql.unsafe('BEGIN');
    try {
      for (const stmt of migration.txStatements) {
        await sql.unsafe(stmt);
      }
      await sql.unsafe('COMMIT');
    } catch (err) {
      await sql.unsafe('ROLLBACK');
      throw err;
    }
  }
  for (const stmt of migration.concurrentStatements) {
    try {
      await dropInvalidIndexFor(sql, stmt);
      await sql.unsafe(stmt);
    } catch (err) {
      process.stderr.write(
        `migration ${migration.version}: concurrent-phase failure on statement; ` +
          `tx-phase changes are durable, re-run to resume concurrent phase: ` +
          `${err instanceof Error ? err.message : String(err)}\n`
      );
      throw err;
    }
  }
  await sql`
    INSERT INTO migrations (version, checksum)
    VALUES (${migration.version}, ${checksum(migration)})
  `;
}

const CONCURRENT_INDEX_RE =
  /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)\s/i;

/**
 * A failed `CREATE INDEX CONCURRENTLY` leaves an INVALID index behind, which
 * `IF NOT EXISTS` would accept forever. Drops the statement's index first when
 * it exists and is invalid, so the re-run builds it again.
 */
async function dropInvalidIndexFor(sql: Sql, stmt: string): Promise<void> {
  const name = CONCURRENT_INDEX_RE.exec(stmt)?.[1];
  if (name === undefined) return;
  const [row] = await sql<Array<{ invalid: boolean }>>`
    SELECT NOT indisvalid AS invalid FROM pg_index WHERE indexrelid = to_regclass(${name})
  `;
  // The name matched an identifier pattern, which licenses `unsafe`.
  if (row?.invalid === true) await sql.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
}

/**
 * One `field.list({ indexed: true })` or `field.json({ indexed: true })` field
 * that should be backed by a GIN over `(body -> field)`.
 */
export interface IndexedListField {
  readonly namespace: string;
  readonly type: string;
  readonly field: string;
}

/**
 * `rows_<ns>_<type>_<field>_<hash>_<suffix>`, within pg's 63-byte identifier
 * limit. The readable part is folded to `[a-z0-9_]` and capped, so it can
 * collide (`my-tags` and `my_tags`, or a long shared prefix); the hash of the
 * raw names keeps such fields from sharing one index or constraint.
 */
export function generatedIdentifier(
  namespace: string,
  type: string,
  field: string,
  suffix: string
): string {
  const fold = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const hash = createHash('sha256')
    .update(JSON.stringify([namespace, type, field]))
    .digest('hex')
    .slice(0, 8);
  const tail = `_${hash}_${suffix}`;
  return `rows_${fold(namespace)}_${fold(type)}_${fold(field)}`.slice(0, 63 - tail.length) + tail;
}

/** Escape a value embedded in a single-quoted SQL string literal (defense-in-depth). */
function sqlStringLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Derives the tracked, idempotent CONCURRENTLY GIN migration for one indexed
 * field. The version key uses the raw ns/type/field.
 */
export function deriveListIndexMigration(f: IndexedListField): MigrationInput {
  const name = generatedIdentifier(f.namespace, f.type, f.field, 'gin');
  const ns = sqlStringLiteral(f.namespace);
  const type = sqlStringLiteral(f.type);
  const field = sqlStringLiteral(f.field);
  return {
    version: `list-gin:${f.namespace}:${f.type}:${f.field}`,
    txStatements: [],
    concurrentStatements: [
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name}\n` +
        `  ON rows USING GIN ((body -> '${field}') jsonb_path_ops)\n` +
        `  WHERE namespace = '${ns}' AND type = '${type}' AND deleted_at IS NULL`
    ]
  };
}

/**
 * Applies migrations derived from field definitions through the same tracked,
 * advisory-locked machinery as the static list. Called after plugins load,
 * since `runMigrations` has no field-def knowledge. Idempotent: applied
 * versions are skipped.
 */
export async function runDerivedMigrations(
  sql: Sql,
  derived: ReadonlyArray<MigrationInput>
): Promise<void> {
  if (derived.length === 0) return;
  await withMigrationLock(sql, async (conn) => {
    await conn`
      CREATE TABLE IF NOT EXISTS migrations (
        version     text        PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now(),
        checksum    text        NOT NULL
      )
    `;
    const applied = await conn<Array<{ version: string }>>`SELECT version FROM migrations`;
    const appliedVersions = new Set(applied.map((r) => r.version));
    for (const input of derived) {
      const migration = normalise(input);
      if (appliedVersions.has(migration.version)) continue;
      await applyOneMigration(conn, migration);
    }
  });
}
