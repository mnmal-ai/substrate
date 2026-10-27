/** Pure preflight: turns a source inventory plus target facts into refusals, warnings and a copy plan. */

import {
  getMigrationList,
  isDerivedMigration,
  MIGRATE_STORE_MARKER_TABLE
} from '@mnmal-ai/substrate-dataset-pg';
import type { SourceInventory } from './source.js';

export interface TargetFacts {
  serverVersionNum: number;
  /** No substrate data: no tables, or `rows` empty. */
  empty: boolean;
  /** Carries the migrate-store marker, so a rerun may reuse it. */
  createdByUs: boolean;
  enforceUuidCheck: boolean;
  /** Recall's embedding dimension on the target; null when unknown or absent. */
  recallDims: number | null;
  /** Extensions installed in the target database (`pg_extension`), name to `extversion`. */
  extensions: Record<string, string>;
  /** Free bytes under SUBSTRATE_INDEX_DISK_PATH; null when not configured. */
  freeBytes: number | null;
}

export interface PreflightOptions {
  /** `--skip-table` names. */
  skipTables: readonly string[];
  /** Loaded plugins' `storeTables`, in copy order. */
  pluginTables: readonly string[];
  dryRun: boolean;
}

export interface CopyPlanTable {
  name: string;
  /** Source columns to copy, in order, generated columns excluded. */
  columns: string[];
  /** Source `pg_table_size`. */
  bytes: number;
}

export interface CopyPlan {
  /** Copy order: engine tables first, then plugin tables in declaration order. */
  tables: CopyPlanTable[];
  /** Estimated target need: twice the copied table bytes, to leave room for index builds. */
  estimatedBytes: number;
  /** Source tables waived with `--skip-table`. */
  skipped: string[];
}

export interface PreflightResult {
  refusals: string[];
  warnings: string[];
  plan: CopyPlan;
}

const ENGINE_COPIED = ['rows', 'short_ids', 'edges', 'visible_seqs'];
const NOT_COPIED = [
  'idempotency',
  'migrations',
  'migrations_audit',
  'kernel_migrations',
  MIGRATE_STORE_MARKER_TABLE
];
/** The extension a copied table depends on. shortcut: recall's only, upgrade when another plugin table needs one. */
const TABLE_EXTENSION: Record<string, string> = { embeddings: 'vector' };

const PG17 = 170000;
const PG18 = 180000;

export function preflight(
  source: SourceInventory,
  target: TargetFacts,
  opts: PreflightOptions
): PreflightResult {
  const refusals: string[] = [];
  const warnings: string[] = [];

  if (source.serverVersionNum < PG17) {
    refusals.push(
      `source is PostgreSQL ${source.serverVersionNum} (server_version_num); 170000 or later is required`
    );
  }
  if (target.serverVersionNum < PG18) {
    refusals.push(
      `target is PostgreSQL ${target.serverVersionNum} (server_version_num); 180000 or later is required`
    );
  }

  const baselines = [
    getMigrationList(true, 'legacy')[0],
    getMigrationList(true, 'partitioned')[0]
  ].map((m) => m?.version);
  const known = new Set(
    [...getMigrationList(true, 'legacy'), ...getMigrationList(true, 'partitioned')].map(
      (m) => m.version
    )
  );
  const unknownVersions = source.appliedMigrations.filter(
    (v) => !known.has(v) && !isDerivedMigration(v)
  );
  if (unknownVersions.length > 0) {
    refusals.push(
      `source ledger holds migrations this binary does not know: ${unknownVersions.join(', ')}`
    );
  }
  if (!source.appliedMigrations.some((v) => baselines.includes(v))) {
    refusals.push(
      `source ledger lacks ${baselines.join(' / ')}; found: ${source.appliedMigrations.join(', ') || 'no migrations'}`
    );
  }

  if (!target.empty && !target.createdByUs) {
    refusals.push('target already holds data and was not created by migrate-store');
  }

  const otherBaseline = baselines.find(
    (b) => b !== getMigrationList(true, source.layout)[0]?.version
  );
  if (otherBaseline !== undefined && source.appliedMigrations.includes(otherBaseline)) {
    refusals.push(`source ledger records ${otherBaseline} but rows is ${source.layout}`);
  }

  if (target.enforceUuidCheck && source.nonUuidIds.length > 0) {
    const sample = source.nonUuidIds
      .slice(0, 5)
      .map((r) => `${r.table}.${r.column}=${r.id}`)
      .join(', ');
    refusals.push(
      `source has ${source.nonUuidIds.length} non-UUID id(s) while the target enforces the UUID check (first 5 shown): ${sample}`
    );
  }

  const skip = new Set(opts.skipTables);
  const knownTables = new Set([...ENGINE_COPIED, ...NOT_COPIED, ...opts.pluginTables]);
  const unknownTables = source.tables.filter((t) => !knownTables.has(t) && !skip.has(t));
  for (const t of unknownTables) {
    refusals.push(
      `source table "${t}" is not known to migrate-store; load the plugin that owns it, or pass --skip-table ${t}`
    );
  }
  for (const t of skip) {
    if (!source.tables.includes(t)) warnings.push(`--skip-table ${t} matches no source table`);
  }

  if (
    source.vectorDims !== null &&
    target.recallDims !== null &&
    source.vectorDims !== target.recallDims
  ) {
    refusals.push(
      `recall embedding dimensions differ: source ${source.vectorDims}, target ${target.recallDims}`
    );
  }

  const present = new Set(source.tables);
  const order = [...ENGINE_COPIED, ...opts.pluginTables].filter(
    (t, i, all) => present.has(t) && all.indexOf(t) === i
  );
  const plan: CopyPlan = {
    tables: order.map((name) => ({
      name,
      columns: source.columns[name] ?? [],
      bytes: source.tableBytes[name] ?? 0
    })),
    estimatedBytes: 0,
    skipped: [...skip].filter((t) => present.has(t))
  };
  plan.estimatedBytes = 2 * plan.tables.reduce((n, t) => n + t.bytes, 0);

  for (const t of plan.tables) {
    const ext = TABLE_EXTENSION[t.name];
    // Installed, not merely available: the target role cannot run CREATE EXTENSION itself.
    if (ext !== undefined && target.extensions[ext] === undefined) {
      refusals.push(
        `table "${t.name}" needs extension "${ext}", which is not installed in the target database; run CREATE EXTENSION ${ext}; in the target database as a superuser`
      );
    }
  }

  if (target.freeBytes !== null && target.freeBytes < plan.estimatedBytes) {
    const msg = `free disk ${target.freeBytes} bytes is below the estimated need of ${plan.estimatedBytes} bytes`;
    (opts.dryRun ? warnings : refusals).push(msg);
  }

  if (source.otherSessions > 0) {
    warnings.push(
      `source has ${source.otherSessions} other active session(s) on its database; writes after the snapshot are not copied, so stop the service first`
    );
  }

  return { refusals, warnings, plan };
}
