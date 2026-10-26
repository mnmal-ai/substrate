/**
 * Safety rails for pg integration tests. Shared by every package whose suites
 * run destructive setup (TRUNCATE / DELETE / DDL) against whatever database
 * `POSTGRES_URL` names.
 *
 * Imported via the `@mnmal-ai/substrate-dataset-pg/testing` subpath, so every
 * package shares one tested copy rather than hand-copying it.
 *
 * Independent checks:
 *
 * 1. `assertTestDatabase` — the database NAME must end `_test` or `_dev`, so a
 *    stray `POSTGRES_URL` cannot point a destructive suite at real data.
 *
 * 2. `assertNotSuperuser` — the CREDENTIAL must not be a superuser. The name
 *    check says nothing about what the role can reach, and a superuser
 *    bypasses every grant that would otherwise contain it.
 *
 * 3. `assertCannotWriteOutsideTestDatabases` — the credential must not be able
 *    to damage any non-test database. Check 2 implies this only while
 *    production runs as a superuser; this asks postgres directly.
 */

import postgres from 'postgres';

export interface GuardOptions {
  /** Named in the failure message so a developer knows which suite refused. */
  packageName: string;
}

export interface SuperuserGuardOptions extends GuardOptions {
  /** Injectable for tests, so the suite needs no live postgres. */
  probe?: (url: string) => Promise<boolean>;
}

export function assertTestDatabase(url: string | undefined, opts: GuardOptions): void {
  if (url === undefined || url === '') return;

  let dbName: string;
  try {
    dbName = new URL(url).pathname.replace(/^\//, '');
  } catch {
    throw new Error(`POSTGRES_URL is not a valid URL: ${url}`);
  }

  if (dbName === '') {
    throw new Error(`POSTGRES_URL must include a database name: ${url}`);
  }

  if (!isTestDatabaseName(dbName)) {
    throw new Error(
      `Refusing to run ${opts.packageName} pg tests against database "${dbName}". ` +
        'These suites run destructive TRUNCATEs / DELETEs / DDL. POSTGRES_URL must ' +
        'name a database ending in `_test` or `_dev` (e.g. `substrate_test`).'
    );
  }
}

/**
 * Returns whether the superuser probe's rows say `on`. Throws on a missing
 * row rather than returning `false`: an unanswered probe is not evidence of
 * safety.
 */
export function interpretSuperuserProbe(rows: Array<{ su?: string }>): boolean {
  const su = rows[0]?.su;
  if (su === undefined) {
    throw new Error(
      'superuser probe returned no row — refusing to treat an unanswerable probe as a safe one'
    );
  }
  return su === 'on';
}

/** Default probe: ask postgres whether the connected role is a superuser. */
async function probeIsSuperuser(url: string): Promise<boolean> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql<Array<{ su: string }>>`SELECT current_setting('is_superuser') AS su`;
    return interpretSuperuserProbe(rows);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {
      // Closing is best-effort; the verdict is already in hand.
    });
  }
}

export async function assertNotSuperuser(
  url: string | undefined,
  opts: SuperuserGuardOptions
): Promise<void> {
  if (url === undefined || url === '') return;

  // A probe that cannot answer must not be read as "not a superuser" — that
  // would turn any connection blip into a silently disabled safety rail.
  const isSuperuser = await (opts.probe ?? probeIsSuperuser)(url);
  if (!isSuperuser) return;

  throw new Error(
    `Refusing to run ${opts.packageName} pg tests with a SUPERUSER credential. ` +
      'These suites are destructive, and a superuser bypasses every grant that ' +
      'would otherwise contain them — including the ones protecting production. ' +
      'Connect as a least-privilege role instead, e.g. `substrate_test`:\n' +
      "  POSTGRES_URL='postgres://substrate_test:<password>@127.0.0.1:5433/substrate_test'\n" +
      "Provision it as a superuser: CREATE ROLE substrate_test LOGIN PASSWORD '<password>'; " +
      'CREATE DATABASE substrate_test OWNER substrate_test;'
  );
}

/** A database outside the test set that the connecting credential could damage. */
export interface ReachFinding {
  database: string;
  /** What makes it damageable: owning the database itself, or a relation in it. */
  via: 'owns-database' | 'writable-relation';
  /** For `writable-relation`: a sample of `schema.table` names, at most five. */
  relations?: string[];
}

export interface ReachGuardOptions extends GuardOptions {
  /** Injectable for tests, so the suite needs no live postgres. */
  probe?: (url: string) => Promise<ReachFinding[]>;
}

function isTestDatabaseName(name: string): boolean {
  return /_test$|_dev$/i.test(name);
}

/**
 * A connection refused for one of these reasons is a definitive "cannot reach",
 * which is the answer the guard wants. Anything else is an unanswered probe and
 * must not be read as safe.
 *   42501 insufficient_privilege — CONNECT revoked
 *   28000 / 28P01 — pg_hba has no entry, or authentication failed
 *   3D000 — the database was dropped between listing and connecting
 */
const UNREACHABLE_CODES = new Set(['42501', '28000', '28P01', '3D000']);

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

async function probeReach(url: string): Promise<ReachFinding[]> {
  const findings: ReachFinding[] = [];

  const home = postgres(url, { max: 1, onnotice: () => {} });
  let others: Array<{ datname: string; owns: boolean }>;
  try {
    others = await home<Array<{ datname: string; owns: boolean }>>`
      SELECT datname, pg_has_role(current_user, datdba, 'USAGE') AS owns
      FROM pg_database WHERE datallowconn ORDER BY datname
    `;
  } finally {
    await home.end({ timeout: 5 }).catch(() => {
      // Best-effort close; the listing is already in hand or the throw says why.
    });
  }

  for (const { datname, owns } of others) {
    if (isTestDatabaseName(datname)) continue;
    if (owns) {
      findings.push({ database: datname, via: 'owns-database' });
      continue;
    }
    const sql = postgres(withDatabase(url, datname), {
      max: 1,
      connect_timeout: 5,
      onnotice: () => {}
    });
    try {
      const rows = await sql<Array<{ rel: string }>>`
        SELECT n.nspname || '.' || c.relname AS rel
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg\\_toast%'
          AND (pg_has_role(current_user, c.relowner, 'USAGE')
               OR has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE'))
        ORDER BY 1 LIMIT 5
      `;
      if (rows.length > 0) {
        findings.push({
          database: datname,
          via: 'writable-relation',
          relations: rows.map((r) => r.rel)
        });
      }
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) continue;
      throw new Error(
        `reach probe could not answer for database "${datname}" — refusing to treat an unanswerable probe as a safe one: ${String(err)}`
      );
    } finally {
      await sql.end({ timeout: 5 }).catch(() => {
        // Best-effort close.
      });
    }
  }
  return findings;
}

/**
 * Throws if the credential in `url` owns, or can write to, anything in a
 * database whose name is not a test name. No-op when `url` is unset.
 *
 * Deliberately not a CONNECT check: postgres grants CONNECT to PUBLIC, so a
 * correctly scoped test role can still connect to production.
 */
export async function assertCannotWriteOutsideTestDatabases(
  url: string | undefined,
  opts: ReachGuardOptions
): Promise<void> {
  if (url === undefined || url === '') return;
  const findings = await (opts.probe ?? probeReach)(url);
  const message = reachFailureMessage(findings, opts.packageName);
  if (message !== undefined) throw new Error(message);
}

export function reachFailureMessage(
  findings: readonly ReachFinding[],
  packageName: string
): string | undefined {
  if (findings.length === 0) return undefined;
  const lines = findings.map((f) =>
    f.via === 'owns-database'
      ? `  - ${f.database}: the role OWNS this database`
      : `  - ${f.database}: the role can write ${(f.relations ?? []).join(', ')}`
  );
  return (
    `Refusing to run ${packageName} pg tests: the POSTGRES_URL credential can damage ` +
    'databases that are not test databases. These suites are destructive, so the ' +
    'credential must be one that can only reach test data. A production credential ' +
    'looks exactly like this.\n' +
    `${lines.join('\n')}\n` +
    'Connect as a least-privilege role that owns only the test database, e.g. `substrate_test`. ' +
    "Provision it as a superuser: CREATE ROLE substrate_test LOGIN PASSWORD '<password>'; " +
    'CREATE DATABASE substrate_test OWNER substrate_test;'
  );
}

export interface AnnounceOptions {
  /** Named in the announcement so a developer knows which suite stood down. */
  packageName: string;
  /** Injectable sink; defaults to stderr. */
  warn?: (message: string) => void;
}

/**
 * Writes one stderr line when `url` is unset, saying this package's pg-gated
 * suites will skip — otherwise a skip looks the same as a pass in the gate.
 *
 * Call it from `vitest.config.ts` (evaluated once per run), not `setupFiles`
 * (once per file). It uses `process.stderr.write` because vitest swallows
 * `console.warn` when every file skips.
 */
export function announcePgGating(url: string | undefined, opts: AnnounceOptions): void {
  if (url !== undefined && url !== '') return;
  (opts.warn ?? ((m: string) => void process.stderr.write(`${m}\n`)))(
    `[pg-gated] ${opts.packageName}: POSTGRES_URL is unset — this package's pg suites will SKIP, not run. ` +
      'Set it to a database whose name ends in _test to exercise them.'
  );
}

/**
 * Prefix for every per-package test schema.
 */
const TEST_SCHEMA_PREFIX = 'substrate_test_';

/**
 * Returns the schema a package's pg-gated suites own.
 *
 * Deterministic rather than per-run, so the schema persists between runs and
 * migrations stay incremental.
 */
export function pgTestSchemaName(packageName: string): string {
  const slug = packageName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, ''); // the line above leaves at most one _ at each end
  return `${TEST_SCHEMA_PREFIX}${slug}`.slice(0, 63);
}

/**
 * Returns `url` with `search_path` pinned to this package's schema.
 *
 * A startup parameter, not `SET search_path`: with a pool, a `SET` reaches
 * only one connection. `public` stays on the path because the `vector` type
 * lives there.
 *
 * The query string is built by hand because postgres.js needs the space as
 * `%20`; `URLSearchParams` would emit `+`, which postgres rejects.
 */
export function pgTestSchemaUrl(url: string, packageName: string): string {
  const wanted = `-c search_path=${pgTestSchemaName(packageName)},public`;
  const parsed = new URL(url);
  if (parsed.searchParams.get('options') === wanted) return url;

  const params = [...parsed.searchParams.entries()].filter(([key]) => key !== 'options');
  params.push(['options', wanted]);
  parsed.search = params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return parsed.toString();
}

export interface SchemaIsolationOptions extends GuardOptions {
  /** Injectable for tests, so the suite needs no live postgres. */
  createSchema?: (url: string, schema: string) => Promise<void>;
  /** Injectable for tests. Names substrate relations still sitting in `public`. */
  findPublicLeftovers?: (url: string) => Promise<string[]>;
  /** Injectable sink; defaults to stderr. */
  warn?: (message: string) => void;
}

/**
 * Returns a warning naming substrate relations left in `public`, or undefined if
 * there are none.
 *
 * With `public` on the search_path, an unqualified name missing from the
 * package schema resolves to `public`'s copy, so leftovers there are unsafe.
 * They are named rather than dropped: this code does not own them.
 */
export function publicLeftoverWarning(
  names: readonly string[],
  packageName: string
): string | undefined {
  if (names.length === 0) return undefined;
  return (
    `[pg-gated] ${packageName}: \`public\` still holds ${names.length} substrate ` +
    `relation(s) — ${names.join(', ')}. These are leftovers from before the pg ` +
    'suites moved into per-package schemas. They are not read by ' +
    'anything now, but while they exist an unqualified name that is missing ' +
    'from the package schema can still resolve to them. Drop them once:\n' +
    '  psql "$POSTGRES_URL" -c \'DROP TABLE IF EXISTS ' +
    `${names.join(', ')} CASCADE'`
  );
}

async function findPublicLeftoversOnce(url: string): Promise<string[]> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql<Array<{ relname: string }>>`
      SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'substrate\\_%'
      ORDER BY c.relname
    `;
    return rows.map((r) => r.relname);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {
      // Best-effort close; this probe is advisory either way.
    });
  }
}

async function createSchemaOnce(url: string, schema: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {
      // Best-effort close; the schema either exists now or the throw above said why.
    });
  }
}

/**
 * Creates this package's test schema and returns the URL that reaches it, or
 * `undefined` when there is no `POSTGRES_URL`. Warns about leftovers in `public`.
 *
 * Packages run concurrently and their suites drop and re-migrate the shared
 * tables, so each needs its own schema. A schema rather than a database,
 * because the least-privilege `substrate_test` role has no CREATEDB.
 *
 * Call from `globalSetup`, so forked workers inherit the rewritten URL.
 */
export async function preparePgTestSchema(
  url: string | undefined,
  opts: SchemaIsolationOptions
): Promise<string | undefined> {
  if (url === undefined || url === '') return undefined;

  const schema = pgTestSchemaName(opts.packageName);
  await (opts.createSchema ?? createSchemaOnce)(url, schema);

  const leftovers = await (opts.findPublicLeftovers ?? findPublicLeftoversOnce)(url);
  const warning = publicLeftoverWarning(leftovers, opts.packageName);
  if (warning !== undefined) {
    (opts.warn ?? ((m: string) => void process.stderr.write(`${m}\n`)))(warning);
  }

  return pgTestSchemaUrl(url, opts.packageName);
}

/**
 * The storage layout this run's pg suites build, from `SUBSTRATE_TEST_LAYOUT`
 * (default `legacy`). Copies it into `SUBSTRATE_STORAGE_LAYOUT`, which
 * `runMigrations` reads on a fresh database, and returns the package name to
 * isolate under, so each layout gets a schema of its own.
 *
 * Call from `globalSetup`, before `preparePgTestSchema`.
 */
export function selectPgTestLayout(packageName: string): {
  layout: 'legacy' | 'partitioned';
  packageName: string;
} {
  const layout = process.env.SUBSTRATE_TEST_LAYOUT ?? 'legacy';
  if (layout !== 'legacy' && layout !== 'partitioned') {
    throw new Error(`SUBSTRATE_TEST_LAYOUT must be 'legacy' or 'partitioned', got '${layout}'`);
  }
  process.env.SUBSTRATE_STORAGE_LAYOUT = layout;
  return { layout, packageName: `${packageName}-${layout}` };
}

/**
 * A `createSchema` for `preparePgTestSchema` that drops and recreates the
 * schema, so every run builds its layout from an empty database.
 */
export async function recreatePgTestSchema(url: string, schema: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await sql.unsafe(`CREATE SCHEMA "${schema}"`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
