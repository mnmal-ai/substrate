/**
 * `substrate-admin migrate-store`: copies a store into a fresh, empty,
 * partitioned PostgreSQL 18 store. Preflight, prepare and copy, index builds,
 * verification, report. Connection strings come from named environment
 * variables only, and nothing this command prints carries one.
 */

import { statfs } from 'node:fs/promises';
import { MIGRATE_STORE_MARKER_TABLE, type PgDataset } from '@mnmal-ai/substrate-dataset-pg';
import postgres, { type Sql } from 'postgres';
import { pgNoticeOptions } from '../../pg-client.js';
import { type KernelHostDeps, loadPluginsFromDir } from '../../plugin-dir-loader.js';
import { type BootedStore, bootStore } from '../../serve/boot-store.js';
import { BINARY_CONTRACT_VERSION, parseEnv, refuseContractViolation } from '../../serve/config.js';
import { resolvePluginDir } from '../../serve/plugins.js';
import { buildDeferredIndexes } from '../../serve/wiring.js';
import { validateArgv } from '../argv.js';
import type { AdminCliEnv } from '../env.js';
import { AdminCliError } from '../errors.js';
import { type CopyResult, copyStore } from '../migrate-store/copy.js';
import { type CopyPlan, preflight, type TargetFacts } from '../migrate-store/preflight.js';
import { inspectSource, type SourceType } from '../migrate-store/source.js';
import { readCopyState, type VerifyResult, verifyStore } from '../migrate-store/verify.js';
import { argvError } from '../usage.js';

export const DEFAULT_FROM_ENV = 'SUBSTRATE_MIGRATE_FROM_URL';
export const DEFAULT_TO_ENV = 'SUBSTRATE_MIGRATE_TO_URL';

export interface MigrateStoreArgs {
  fromEnv: string;
  toEnv: string;
  fromSchema: string | null;
  toSchema: string | null;
  batchRows: number;
  skipTables: string[];
  dryRun: boolean;
  verifyOnly: boolean;
  json: boolean;
  skipIndexBuild: boolean;
  fullChecksum: boolean;
}

export interface MigrateStoreDeps {
  /** Progress lines, for stderr. */
  progress(line: string): void;
  /** pg NOTICE lines from the command's own pools, for stderr. */
  notice?: (line: string) => void;
  /** Test hook: runs on the target between the copy (and index builds) and verification. */
  beforeVerify?: (target: Sql) => Promise<void>;
}

export interface MigrateStoreReport {
  mode: 'dry-run' | 'migrate' | 'verify-only';
  ok: boolean;
  exitCode: 0 | 2 | 3;
  refusals: string[];
  warnings: string[];
  /** The source's types (dry run). */
  types?: SourceType[];
  plan?: { tables: { name: string; bytes: number }[]; estimatedBytes: number; skipped: string[] };
  tables: CopyResult['tables'];
  phases: Record<string, number>;
  totalMs: number;
  keptSeeds: string[];
  defaulted: string[];
  /** Pending-index warnings let through because of `--skip-index-build`. */
  pendingIndexes: string[];
  mismatches: VerifyResult['mismatches'];
  /** The env change that moves `serve` onto the target; null until it verified. */
  switchOver: string | null;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const IDENT = /^[a-z_][a-z0-9_$]*$/;
const SAFE_VALUE = (flag: string) =>
  `migrate-store: ${flag} takes a plain name (a value that does not fit is not echoed)`;

/** Parses the argv tail after `migrate-store`. Usage errors exit 2. */
export function parseMigrateStoreArgs(tail: readonly string[]): MigrateStoreArgs {
  validateArgv('migrate-store', tail);
  const seen = new Map<string, string>();
  const args: MigrateStoreArgs = {
    fromEnv: DEFAULT_FROM_ENV,
    toEnv: DEFAULT_TO_ENV,
    fromSchema: null,
    toSchema: null,
    batchRows: 10_000,
    skipTables: [],
    dryRun: false,
    verifyOnly: false,
    json: false,
    skipIndexBuild: false,
    fullChecksum: false
  };
  const fail = (msg: string) => argvError('migrate-store', msg, 2);
  for (let i = 0; i < tail.length; i++) {
    const tok = tail[i] as string;
    switch (tok) {
      case '--dry-run':
        args.dryRun = true;
        continue;
      case '--verify-only':
        args.verifyOnly = true;
        continue;
      case '--json':
        args.json = true;
        continue;
      case '--skip-index-build':
        args.skipIndexBuild = true;
        continue;
      case '--full-checksum':
        args.fullChecksum = true;
        continue;
    }
    const value = tail[i + 1];
    if (value === undefined || value.startsWith('--'))
      throw fail(`migrate-store: ${tok} needs a value`);
    i += 1;
    if (tok !== '--skip-table') {
      if (seen.has(tok)) throw fail(`migrate-store: ${tok} given more than once`);
      seen.set(tok, value);
    }
    switch (tok) {
      case '--from-env':
      case '--to-env':
        if (!ENV_NAME.test(value)) {
          throw fail(
            `migrate-store: ${tok} takes the NAME of an environment variable that holds the connection string, never the string itself`
          );
        }
        args[tok === '--from-env' ? 'fromEnv' : 'toEnv'] = value;
        break;
      case '--from-schema':
      case '--to-schema':
        if (!IDENT.test(value)) throw fail(SAFE_VALUE(tok));
        args[tok === '--from-schema' ? 'fromSchema' : 'toSchema'] = value;
        break;
      case '--skip-table':
        if (!IDENT.test(value)) throw fail(SAFE_VALUE(tok));
        args.skipTables.push(value);
        break;
      case '--batch-rows': {
        const n = Number(value);
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1) {
          throw fail('migrate-store: --batch-rows takes a positive integer');
        }
        args.batchRows = n;
        break;
      }
    }
  }
  if (args.dryRun && args.verifyOnly) {
    throw fail('migrate-store: --dry-run and --verify-only are mutually exclusive');
  }
  return args;
}

/** Replaces every URL, and each given secret, in `s`. */
export function redactor(secrets: readonly string[]): (s: string) => string {
  const literals = [...new Set(secrets.filter((x) => x.length >= 3))].sort(
    (a, b) => b.length - a.length
  );
  return (s) => {
    let r = s.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"`]+/gi, '<redacted url>');
    for (const l of literals) r = r.split(l).join('<redacted>');
    return r;
  };
}

/** The connection string, its password both as written and decoded, for `redactor`. */
export function secretsOf(url: string | undefined): string[] {
  if (url === undefined || url.length === 0) return [];
  const out = [url];
  let pw = '';
  try {
    pw = new URL(url).password;
  } catch {
    // Not a URL: the whole string is already listed.
  }
  if (pw.length === 0) return out;
  out.push(pw);
  try {
    out.push(decodeURIComponent(pw));
  } catch {
    // A malformed escape: the raw password is listed.
  }
  return out;
}

/** `url` with `search_path` pinned to `schema`, as a startup option so every pooled connection has it. */
function withSchema(url: string, schema: string | null): string {
  if (schema === null) return url;
  const u = new URL(url);
  const prior = u.searchParams.get('options');
  const params = [...u.searchParams.entries()].filter(([k]) => k !== 'options');
  // A later -c wins, so the operator's other options stay.
  params.push(['options', `${prior !== null ? `${prior} ` : ''}-c search_path=${schema},public`]);
  // By hand: postgres.js needs the space as %20, and URLSearchParams writes +.
  u.search = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return u.toString();
}

const DISK_PATH_UNSET =
  'SUBSTRATE_INDEX_DISK_PATH is unset, so the target cannot check free disk before index builds and its storage check fails verification: set it to the target database volume mount, or to off when the database has no local volume';
const PENDING_INDEX =
  /^index \S+ on \S+ is pending( \(.*\))?: filters it would serve scan until it is valid$/;

export async function runMigrateStore(
  args: MigrateStoreArgs,
  env: AdminCliEnv,
  deps: MigrateStoreDeps
): Promise<MigrateStoreReport> {
  const started = performance.now();
  const vars = env as Record<string, string | undefined>;
  const urlOf = (name: string, side: string) => {
    const v = vars[name]?.trim();
    if (v === undefined || v.length === 0) {
      throw new AdminCliError(
        `migrate-store: ${name} (the ${side} connection string) is not set`,
        2
      );
    }
    if (!/^postgres(ql)?:\/\//.test(v)) {
      throw new AdminCliError(
        `migrate-store: ${name} does not hold a postgres:// connection string`,
        2
      );
    }
    return v;
  };
  const fromUrl = withSchema(urlOf(args.fromEnv, 'source'), args.fromSchema);
  const toUrl = withSchema(urlOf(args.toEnv, 'target'), args.toSchema);
  if (fromUrl === toUrl) {
    throw new AdminCliError('migrate-store: the source and the target are the same store', 2);
  }

  const report: MigrateStoreReport = {
    mode: args.dryRun ? 'dry-run' : args.verifyOnly ? 'verify-only' : 'migrate',
    ok: false,
    exitCode: 2,
    refusals: [],
    warnings: [],
    tables: [],
    phases: {},
    totalMs: 0,
    keptSeeds: [],
    defaulted: [],
    pendingIndexes: [],
    mismatches: [],
    switchOver: null
  };
  const finish = (exitCode: 0 | 2 | 3) => {
    report.exitCode = exitCode;
    report.ok = exitCode === 0;
    report.totalMs = Math.round(performance.now() - started);
    return report;
  };
  const phase = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    deps.progress(`migrate-store: ${name}`);
    const t = performance.now();
    try {
      return await fn();
    } finally {
      report.phases[name] = Math.round(performance.now() - t);
    }
  };

  const diskPath = vars.SUBSTRATE_INDEX_DISK_PATH?.trim();
  if (diskPath === undefined || diskPath.length === 0) {
    (args.dryRun ? report.warnings : report.refusals).push(DISK_PATH_UNSET);
  }
  if (report.refusals.length > 0) return finish(2);

  // The target's serve env: everything the operator set, the store swapped for the target.
  const targetEnv: Record<string, string | undefined> = { ...vars, SUBSTRATE_DATABASE_URL: toUrl };
  const pluginDir = resolvePluginDir(targetEnv);
  const boot = () =>
    bootStore({
      config: parseEnv(targetEnv),
      pluginDir,
      layout: 'partitioned',
      allowMigrating: true,
      // A prepare boot starts no advisor and no plugin backfill, so nothing writes beside the copy.
      background: false
    });
  const notices = pgNoticeOptions(deps.notice ?? ((line) => deps.progress(line.trimEnd())));
  const openFacts = () => postgres(toUrl, { ...notices, max: 1 });
  const endFacts = (facts: Sql) => facts.end({ timeout: 5 }).catch(() => undefined);

  // One connection, so the quiescence count knows what is ours; read-only for the session as a backstop.
  const src = postgres(fromUrl, {
    ...notices,
    max: 1,
    connection: { default_transaction_read_only: true }
  });
  let target: BootedStore | undefined;
  try {
    let keptSeeds: CopyResult['keptSeeds'];
    let defaulted: CopyResult['defaulted'];
    let tables: string[];
    if (args.verifyOnly) {
      const facts = openFacts();
      try {
        await assertSchema(src, args.fromSchema, 'source');
        await assertSchema(facts, args.toSchema, 'target');
        await assertDistinct(src, facts);
        // Before the boot, which would otherwise prepare (write) a target that holds no copy.
        await assertCopyDone(facts);
      } finally {
        await endFacts(facts);
      }
      target = await phase('prepare', boot);
      const state = await readCopyState(target);
      ({ keptSeeds, defaulted, tables } = state);
    } else {
      const pre = await phase('preflight', async () => {
        const facts = openFacts();
        try {
          const own = await ownSession(facts);
          await assertSchema(src, args.fromSchema, 'source');
          await assertSchema(facts, args.toSchema, 'target');
          await assertDistinct(src, facts);
          const source = await inspectSource(src);
          source.otherSessions -= await sessionsOn(src, own);
          const target = await targetFacts(facts, env, diskPath);
          const pluginTables = await storeTables(pluginDir);
          return {
            source,
            ...preflight(source, target, {
              skipTables: args.skipTables,
              pluginTables,
              dryRun: args.dryRun
            })
          };
        } finally {
          await endFacts(facts);
        }
      });
      report.refusals.push(...pre.refusals);
      report.warnings.push(...pre.warnings);
      report.plan = planOf(pre.plan);
      if (report.refusals.length > 0) return finish(2);
      if (args.dryRun) {
        report.types = pre.source.types;
        return finish(0);
      }

      const copied = await phase('prepare-and-copy', () =>
        copyStore(src, boot, pre.plan, {
          batchRows: args.batchRows,
          onProgress: (e) =>
            deps.progress(`  ${e.table}: ${e.rows} rows, ${e.bytes} bytes${e.done ? ', done' : ''}`)
        })
      );
      target = copied.target;
      report.tables = copied.tables;
      ({ keptSeeds, defaulted } = copied);
      tables = pre.plan.tables.map((t) => t.name);
    }

    // In --verify-only too, so a rerun finishes a run whose index builds failed: the reconcile
    // drops each INVALID leftover of an engine index and builds it again.
    const booted = target;
    const indexFailures = args.skipIndexBuild
      ? []
      : await phase('indexes', () => buildDeferredIndexes(booted.engine, booted.datasets));

    report.keptSeeds = keptSeeds.map((k) => `${k.namespace}/${k.type}/${k.id}`);
    report.defaulted = defaulted.map((d) => `${d.namespace}/${d.type}`);
    const tsql = booted.sql as Sql;
    await deps.beforeVerify?.(tsql);
    const verified = await phase('verify', () =>
      verifyStore(src, tsql, {
        keptSeeds,
        defaulted,
        tables,
        fullChecksum: args.fullChecksum,
        sampleRows: 1000,
        partitionBudget: 500,
        storageReport: async (r) => {
          const { warnings } = await (booted.dataset as PgDataset).storageReport(r);
          // A failed build pass and an INVALID index fail verification, each named.
          const failed = [...indexFailures, ...(await invalidIndexes(tsql))];
          if (!args.skipIndexBuild) return { warnings: [...warnings, ...failed] };
          // Deferred on purpose: only the exact pending-index warning is let through, and reported.
          report.pendingIndexes = warnings.filter((w) => PENDING_INDEX.test(w));
          return { warnings: [...warnings.filter((w) => !PENDING_INDEX.test(w)), ...failed] };
        }
      })
    );
    report.mismatches = verified.mismatches;
    if (!verified.ok) return finish(3);
    report.switchOver =
      `stop serve, set SUBSTRATE_DATABASE_URL to the value of ${args.toEnv}` +
      `${args.toSchema !== null ? ` with search_path ${args.toSchema},public (options=-c search_path=${args.toSchema},public)` : ''}` +
      ', then start serve. The source is untouched: pointing back at it is the rollback.';
    return finish(0);
  } finally {
    await target?.close().catch(() => undefined);
    await src.end({ timeout: 5 }).catch(() => undefined);
  }
}

function planOf(plan: CopyPlan): NonNullable<MigrateStoreReport['plan']> {
  return {
    tables: plan.tables.map((t) => ({ name: t.name, bytes: t.bytes })),
    estimatedBytes: plan.estimatedBytes,
    skipped: plan.skipped
  };
}

/** The target schema's INVALID indexes, which a failed CREATE INDEX CONCURRENTLY leaves behind. */
async function invalidIndexes(sql: Sql): Promise<string[]> {
  const rows = await sql<{ name: string; tbl: string }[]>`
    SELECT c.relname AS name, t.relname AS tbl
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class t ON t.oid = i.indrelid
    WHERE c.relnamespace = current_schema()::regnamespace AND NOT i.indisvalid
    ORDER BY c.relname`;
  return rows.map(
    (r) =>
      `index ${r.name} on ${r.tbl} is INVALID: rerun with --verify-only (without --skip-index-build), which rebuilds it`
  );
}

/** Refuses a named schema the connection did not land in: an unknown name on search_path falls through to public. */
async function assertSchema(sql: Sql, schema: string | null, side: string): Promise<void> {
  const [r] = await sql<{ s: string | null }[]>`SELECT current_schema() AS s`;
  if (schema !== null && r?.s !== schema) {
    throw new AdminCliError(`migrate-store: the ${side} has no schema ${schema}`, 2);
  }
}

const storeId = async (sql: Sql) => {
  const [r] = await sql<{ id: string }[]>`
    SELECT concat_ws('/', (SELECT system_identifier FROM pg_control_system())::text,
                     current_database(), current_schema()) AS id`;
  return r?.id;
};

/** Refuses a source and target that are one store: same cluster, database and schema. */
async function assertDistinct(src: Sql, tgt: Sql): Promise<void> {
  if ((await storeId(src)) === (await storeId(tgt))) {
    throw new AdminCliError('migrate-store: the source and the target are the same store', 2);
  }
}

/** Refuses `--verify-only` on a target with no finished migrate-store copy. */
async function assertCopyDone(sql: Sql): Promise<void> {
  const [r] = await sql<{ marker: string | null }[]>`
    SELECT to_regclass(quote_ident(current_schema()) || '.' || quote_ident(${MIGRATE_STORE_MARKER_TABLE}))::text AS marker`;
  const done =
    r?.marker != null &&
    (await sql`SELECT 1 FROM ${sql(r.marker)} WHERE step = 'copy:done'`).length > 0;
  if (!done) {
    throw new AdminCliError(
      'migrate-store: the target holds no finished migrate-store copy to verify (no in-progress marker with a completed copy)',
      2
    );
  }
}

interface Session {
  pid: number;
  /** backend_start as epoch text, which no session TimeZone changes. */
  start: string;
}

async function ownSession(sql: Sql): Promise<Session> {
  const [r] = await sql<Session[]>`
    SELECT pid, extract(epoch FROM backend_start)::text AS start
    FROM pg_stat_activity WHERE pid = pg_backend_pid()`;
  return r as Session;
}

/** 1 when `s` is a backend on `sql`'s database, else 0: our own target connection when both share one. */
async function sessionsOn(sql: Sql, s: Session): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND pid = ${s.pid}
      AND extract(epoch FROM backend_start)::text = ${s.start}`;
  return r?.n ?? 0;
}

async function targetFacts(
  sql: Sql,
  env: AdminCliEnv,
  diskPath: string | undefined
): Promise<TargetFacts> {
  // Qualified with the target's schema, so a same-named table in public (also on search_path) never answers.
  const [r] = await sql<
    { v: number; schema: string; rows: boolean; marker: boolean; embeddings: boolean }[]
  >`
    SELECT current_setting('server_version_num')::int AS v, current_schema() AS schema,
           to_regclass(quote_ident(current_schema()) || '.rows') IS NOT NULL AS rows,
           to_regclass(quote_ident(current_schema()) || '.' || quote_ident(${MIGRATE_STORE_MARKER_TABLE})) IS NOT NULL AS marker,
           to_regclass(quote_ident(current_schema()) || '.embeddings') IS NOT NULL AS embeddings`;
  const facts = r as {
    v: number;
    schema: string;
    rows: boolean;
    marker: boolean;
    embeddings: boolean;
  };
  const empty =
    !facts.rows || (await sql`SELECT 1 FROM ${sql(facts.schema)}.rows LIMIT 1`).length === 0;
  // shortcut: the dimension is known only once a run created the table; on a fresh target a mismatch fails the copy instead.
  const [dims] = facts.embeddings
    ? await sql<{ d: number }[]>`
        SELECT atttypmod AS d FROM pg_attribute
        WHERE attrelid = to_regclass(quote_ident(${facts.schema}) || '.embeddings')
          AND attname = 'embedding' AND NOT attisdropped`
    : [];
  const extensions = await sql<{ name: string; version: string }[]>`
    SELECT extname AS name, extversion AS version FROM pg_extension`;
  let freeBytes: number | null = null;
  if (diskPath !== undefined && diskPath.length > 0 && diskPath !== 'off') {
    const s = await statfs(diskPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
      throw new AdminCliError(
        `migrate-store: SUBSTRATE_INDEX_DISK_PATH names a path that does not exist; set it to the target database volume mount, or to off`,
        2
      );
    });
    freeBytes = s.bavail * s.bsize;
  }
  return {
    serverVersionNum: facts.v,
    empty,
    createdByUs: facts.marker,
    enforceUuidCheck:
      (env as Record<string, string | undefined>).SUBSTRATE_ENFORCE_UUID_CHECK === 'true',
    recallDims: dims !== undefined && dims.d > 0 ? dims.d : null,
    extensions: Object.fromEntries(extensions.map((e) => [e.name, e.version])),
    freeBytes
  };
}

/** The loaded kernel plugins' `storeTables`, loaded as serve loads them but never composed. */
async function storeTables(pluginDir: string | null): Promise<string[]> {
  if (pluginDir === null) return [];
  const { kernel } = await loadPluginsFromDir({
    pluginDir,
    // Nothing runs: the plugins are built to read their declarations, never composed.
    // shortcut: a plugin whose factory dereferences a host dep at build time throws a TypeError here (exit 1);
    // pass real deps if one does.
    kernelHostDeps: {} as KernelHostDeps,
    contractCheck: { hostVersion: BINARY_CONTRACT_VERSION, onViolation: refuseContractViolation }
  });
  return kernel.flatMap((p) => p.storeTables ?? []);
}

export function formatMigrateStoreOutput(r: MigrateStoreReport, json: boolean): string {
  if (json) return `${JSON.stringify(r)}\n`;
  const lines: string[] = [];
  const verdict =
    r.exitCode === 0
      ? r.mode === 'dry-run'
        ? 'dry run: nothing written'
        : 'copied and verified'
      : r.exitCode === 3
        ? 'VERIFICATION FAILED: the target keeps its in-progress marker, so serve will not boot it'
        : 'REFUSED: nothing was written to the target';
  lines.push(`migrate-store (${r.mode}): ${verdict}`);
  for (const x of r.refusals) lines.push(`  refused: ${x}`);
  for (const x of r.warnings) lines.push(`  warning: ${x}`);
  if (r.types !== undefined) {
    lines.push('source types (live / deleted / bytes):');
    for (const t of r.types) {
      lines.push(`  ${t.namespace}/${t.type}: ${t.live} / ${t.deleted} / ${t.bytes}`);
    }
  }
  if (r.plan !== undefined) {
    lines.push(`plan (estimated target need ${r.plan.estimatedBytes} bytes):`);
    for (const t of r.plan.tables) lines.push(`  ${t.name}: ${t.bytes} bytes`);
    if (r.plan.skipped.length > 0) lines.push(`  skipped: ${r.plan.skipped.join(', ')}`);
  }
  if (r.tables.length > 0) {
    lines.push('copied (rows / bytes / ms):');
    for (const t of r.tables) lines.push(`  ${t.name}: ${t.rows} / ${t.bytes} / ${t.ms}`);
  }
  if (r.keptSeeds.length > 0) lines.push(`kept seeds: ${r.keptSeeds.join(', ')}`);
  if (r.defaulted.length > 0) lines.push(`in the DEFAULT partition: ${r.defaulted.join(', ')}`);
  if (r.pendingIndexes.length > 0) {
    lines.push(
      `${r.pendingIndexes.length} index build(s) left pending for serve (--skip-index-build; --json lists them all):`
    );
    for (const w of r.pendingIndexes.slice(0, 10)) lines.push(`  ${w}`);
  }
  for (const m of r.mismatches) {
    const at = m.namespace !== undefined ? ` ${m.namespace}/${m.type}` : '';
    lines.push(`  mismatch [${m.check}]${at}: ${m.detail}`);
  }
  const phases = Object.entries(r.phases).map(([k, v]) => `${k} ${v}`);
  lines.push(`ms: ${[...phases, `total ${r.totalMs}`].join(', ')}`);
  if (r.switchOver !== null) lines.push(`switch over: ${r.switchOver}`);
  return `${lines.join('\n')}\n`;
}

/**
 * The CLI door: parse, run, print, exit code. Every string bound for stdout or
 * stderr passes one redactor, so no connection string reaches either.
 */
export async function migrateStoreCommand(
  tail: readonly string[],
  env: AdminCliEnv,
  out: (s: string) => void,
  errOut: (s: string) => void,
  hooks: Pick<MigrateStoreDeps, 'beforeVerify'> = {}
): Promise<number> {
  const vars = env as Record<string, string | undefined>;
  const names = new Set([DEFAULT_FROM_ENV, DEFAULT_TO_ENV, 'SUBSTRATE_DATABASE_URL']);
  for (let i = 0; i < tail.length - 1; i++) {
    if (tail[i] === '--from-env' || tail[i] === '--to-env') names.add(tail[i + 1] as string);
  }
  const redact = redactor([...names].flatMap((n) => secretsOf(vars[n])));
  const err = (s: string) => errOut(redact(s));
  // During the run, what the boot writes to process.stdout (which the report owns) goes to stderr,
  // and everything reaching stderr passes the redactor. The originals are captured first, so
  // `errOut` writing through process.stderr reaches the real stream rather than looping.
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const realStderr = stderrWrite.bind(process.stderr);
  process.stdout.write = shim((s) => err(s));
  process.stderr.write = shim((s) => realStderr(redact(s)));
  let report: MigrateStoreReport;
  let json = false;
  try {
    const args = parseMigrateStoreArgs(tail);
    json = args.json;
    report = await runMigrateStore(args, env, {
      progress: (line) => err(`${line}\n`),
      ...hooks
    });
  } catch (e) {
    err(`${e instanceof Error ? e.message : String(e)}\n`);
    return e instanceof AdminCliError ? e.exitCode : 1;
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
  out(redact(formatMigrateStoreOutput(report, json)));
  return report.exitCode;
}

type WriteCallback = (err?: Error | null) => void;

/** A `stream.write` stand-in that hands decoded text to `sink`, honouring `encoding` and `callback`. */
function shim(sink: (s: string) => void): typeof process.stdout.write {
  return ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | WriteCallback,
    callback?: WriteCallback
  ) => {
    const cb = typeof encoding === 'function' ? encoding : callback;
    const enc = typeof encoding === 'string' ? encoding : undefined;
    sink(
      typeof chunk === 'string'
        ? enc === undefined || enc === 'utf8' || enc === 'utf-8'
          ? chunk
          : Buffer.from(chunk, enc).toString('utf8')
        : Buffer.from(chunk).toString('utf8')
    );
    if (cb !== undefined) process.nextTick(cb, null);
    return true;
  }) as typeof process.stdout.write;
}
