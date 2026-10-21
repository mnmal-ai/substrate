/**
 * Value-map migration utility for class-3 (vocabulary/constraint) schema
 * changes.
 *
 * A narrowing proposal strands stored rows: the enum gate only fires on
 * fields present in a write patch, so existing rows keep values the new
 * vocabulary no longer admits until a read-modify-write client echoes one
 * back. This is the migration `destructive_change_required` points callers to:
 *
 *   1. SCAN — page the type, tally stored values outside the NEW vocabulary,
 *      per source value WITH COUNTS (and the row ids that carry them).
 *   2. PLAN — the author supplies the target per stranded source value.
 *      NOT derivable: dropping 'deferred' tells you which rows are stranded,
 *      never whether they become 'open' or 'closed'. `null` is a legal entry
 *      meaning REJECT — knowingly strand, count on the record. Never the
 *      default: every offender must be mapped or the plan refuses.
 *   3. APPLY — batched updates per source value, migrate-FIRST (targets must
 *      be legal under the still-active OLD gate as well as the new
 *      vocabulary, so the migration passes either way).
 *   4. VERIFY — re-scan, expect zero offenders outside the REJECT set.
 *
 * Raw `dataset` reads/writes throughout, never the engine: the migration
 * must not trip the write-time gate it exists to precede, and its writes
 * are keyed by id so they merge onto stored rows rather than replacing
 * them. Callers run migrate-then-narrow; narrowing first opens a gap where
 * read-modify-write clients fail on rows they did not modify.
 */

import type { Dataset, Row } from '@mnmal-ai/substrate-types';

/** Author-supplied map: stranded source value → target value, or null to REJECT. */
export type ValueMap = Record<string, string | null>;

/** One distinct stored value outside the vocabulary, with its carriers. */
export interface Offender {
  value: string;
  count: number;
  ids: string[];
}

export interface MigrationScan {
  rowsScanned: number;
  offenders: Offender[];
  /** True when maxRows stopped the scan before the table was exhausted. */
  truncated: boolean;
}

export interface ScanDeps {
  dataset: Dataset;
  namespace: string;
  type: string;
  field: string;
  /** The vocabulary rows must satisfy AFTER the narrowing. */
  vocabulary: readonly string[];
  rowsPerPage?: number;
  maxRows?: number;
}

/**
 * Page the type and tally stored values outside `vocabulary`, per value with
 * counts and row ids. Null/undefined are skipped: a nullable enum
 * legitimately holds null, and the write gate skips it for the same reason.
 */
export async function scanNonconforming(deps: ScanDeps): Promise<MigrationScan> {
  const rowsPerPage = deps.rowsPerPage ?? 500;
  const maxRows = deps.maxRows ?? 50_000;
  const allowed = new Set(deps.vocabulary);
  const byValue = new Map<string, string[]>();
  let rowsScanned = 0;
  let truncated = false;
  let cursor: string | undefined;

  for (;;) {
    const page = await deps.dataset.read(deps.type, {
      orderBy: [{ id: 'asc' }],
      limit: rowsPerPage,
      ...(cursor !== undefined ? { cursor } : {})
    });
    for (const row of page.rows) {
      rowsScanned += 1;
      const value = (row as Record<string, unknown>)[deps.field];
      if (value === null || value === undefined) continue;
      const asString = typeof value === 'string' ? value : String(value);
      if (allowed.has(asString)) continue;
      const ids = byValue.get(asString) ?? [];
      ids.push(String((row as Record<string, unknown>).id));
      byValue.set(asString, ids);
      if (rowsScanned >= maxRows) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
    if (page.hasMore !== true || page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }

  const offenders: Offender[] = [...byValue.entries()]
    .map(([value, ids]) => ({ value, count: ids.length, ids }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return { rowsScanned, offenders, truncated };
}

export class MigrationError extends Error {
  readonly code:
    | 'unmapped_source_values'
    | 'target_outside_new_vocabulary'
    | 'target_violates_current_gate'
    | 'verification_failed';
  readonly details: Record<string, unknown>;

  constructor(
    code: MigrationError['code'],
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export interface MigrationPlan {
  toMigrate: Array<{ from: string; to: string; ids: string[] }>;
  stranded: Array<{ value: string; count: number }>;
}

/**
 * Resolve a scan against the author's map. Every offender must be mapped —
 * an unmapped value refuses rather than silently stranding. Targets must be
 * legal under the NEW vocabulary and must also pass the CURRENT (old) gate,
 * or the migration itself would fail the write it precedes; pass
 * `oldVocabulary: null` when the old field declares no enum.
 */
export function planMigration(
  scan: MigrationScan,
  valueMap: ValueMap,
  args: { oldVocabulary: readonly string[] | null; newVocabulary: readonly string[] }
): MigrationPlan {
  const unmapped = scan.offenders.filter((o) => !(o.value in valueMap));
  if (unmapped.length > 0) {
    throw new MigrationError(
      'unmapped_source_values',
      `Value map covers ${scan.offenders.length - unmapped.length} of ${scan.offenders.length} stranded values; ` +
        `unmapped: ${unmapped.map((o) => `'${o.value}' x${o.count}`).join(', ')}. ` +
        'Map every offender or explicitly REJECT (null) the ones you knowingly strand.',
      { unmapped: unmapped.map((o) => o.value) }
    );
  }

  const toMigrate: MigrationPlan['toMigrate'] = [];
  const stranded: MigrationPlan['stranded'] = [];
  for (const offender of scan.offenders) {
    const target = valueMap[offender.value];
    if (target === null || target === undefined) {
      stranded.push({ value: offender.value, count: offender.count });
      continue;
    }
    if (!args.newVocabulary.includes(target)) {
      throw new MigrationError(
        'target_outside_new_vocabulary',
        `Migration target '${target}' for '${offender.value}' is not in the new vocabulary ` +
          `(${args.newVocabulary.join(', ')}). The migration must land rows the narrowed gate accepts.`,
        { from: offender.value, target }
      );
    }
    if (args.oldVocabulary !== null && !args.oldVocabulary.includes(target)) {
      throw new MigrationError(
        'target_violates_current_gate',
        `Migration target '${target}' for '${offender.value}' violates the CURRENT (pre-narrowing) gate, ` +
          'so the migration write itself would be refused. Migrate-first only works when targets are ' +
          'legal under both vocabularies.',
        { from: offender.value, target }
      );
    }
    toMigrate.push({ from: offender.value, to: target, ids: offender.ids });
  }
  return { toMigrate, stranded };
}

export interface MigrationResult {
  rowsScanned: number;
  migrated: Array<{ from: string; to: string; count: number }>;
  stranded: Array<{ value: string; count: number }>;
  truncated: boolean;
  /** Ids of every row rewritten. */
  ids: string[];
}

/**
 * Scan → plan → apply → verify for one field. Throws on unmapped offenders,
 * illegal targets, or a verification re-scan that finds anything outside the
 * REJECT set. A truncated scan that verifies clean is reported, not hidden:
 * the offender may sit past the cut.
 */
export async function migrateFieldValues(
  deps: ScanDeps,
  valueMap: ValueMap,
  args: {
    oldVocabulary: readonly string[] | null;
    newVocabulary?: readonly string[];
    /**
     * Write each row's existing `_metadata` back unchanged, so the rewrite
     * does not read as an edit (no `updatedAt` bump). For normalisation; a
     * narrowing that changes meaning leaves it off.
     */
    preserveMetadata?: boolean;
  }
): Promise<MigrationResult> {
  const newVocabulary = args.newVocabulary ?? deps.vocabulary;
  const scan = await scanNonconforming({ ...deps, vocabulary: newVocabulary });
  const plan = planMigration(scan, valueMap, {
    oldVocabulary: args.oldVocabulary,
    newVocabulary
  });

  const migrated: MigrationResult['migrated'] = [];
  const written: string[] = [];
  for (const step of plan.toMigrate) {
    // One write per source value; ids key the upsert merge per row.
    const BATCH = 200;
    for (let i = 0; i < step.ids.length; i += BATCH) {
      const ids = step.ids.slice(i, i + BATCH);
      const meta = new Map<string, unknown>();
      if (args.preserveMetadata === true) {
        for (const r of (await deps.dataset.read(deps.type, { ids })).rows)
          meta.set(String(r.id), r._metadata);
      }
      await deps.dataset.write(
        deps.type,
        ids.map((id) => {
          const m = meta.get(id);
          return (
            m === undefined
              ? { id, [deps.field]: step.to }
              : { id, [deps.field]: step.to, _metadata: m }
          ) as Row;
        })
      );
    }
    migrated.push({ from: step.from, to: step.to, count: step.ids.length });
    written.push(...step.ids);
  }

  // Verify: re-scan against the new vocabulary; anything remaining must be
  // exactly the REJECT set, or the migration did not do what the map said.
  const verify = await scanNonconforming({ ...deps, vocabulary: newVocabulary });
  const rejected = new Set(plan.stranded.map((s) => s.value));
  const unexpected = verify.offenders.filter((o) => !rejected.has(o.value));
  if (unexpected.length > 0) {
    throw new MigrationError(
      'verification_failed',
      `Post-migration re-scan still finds ${unexpected.length} unmapped value(s): ` +
        `${unexpected.map((o) => `'${o.value}' x${o.count}`).join(', ')}.`,
      { unexpected: unexpected.map((o) => o.value) }
    );
  }

  return {
    rowsScanned: scan.rowsScanned,
    migrated,
    stranded: plan.stranded,
    truncated: scan.truncated || verify.truncated,
    ids: written
  };
}
