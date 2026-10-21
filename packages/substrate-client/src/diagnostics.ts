/**
 * Envelope diagnostics surfacing — the client half of substrate's `_diagnostics`
 * contract (spec §7.0).
 *
 * `_diagnostics` reports observations about a read that SUCCEEDED, e.g. a
 * projected key the type does not declare, which comes back as `null` on every
 * row and is indistinguishable from a declared always-null field. The failure
 * is silent by construction, so substrate-types obliges a client that maps rows
 * into declared interfaces to surface it; this module logs it by default.
 *
 * Two guards keep new diagnostic keys from being dropped silently:
 * `UnhandledEnvelopeKey` fails `check-types` when substrate-types adds a key this
 * module does not handle, and `unrecognizedKeys` reports, at runtime, keys from
 * a newer substrate than this client was compiled against.
 *
 * Deliberately NOT routed through `errors`: a consumer doing
 * `if (env.errors) throw` would start failing on successful reads.
 *
 * The default sink dedupes once per distinct observation set per client, so a
 * polling hook does not flood the log during a rolling deploy. The dedupe key
 * spans every observation, not just the projection fields, so two different
 * diagnostics on one op-key are both reported.
 */

import type { PackEnvelope } from '@mnmal-ai/substrate-types';

/** The `_diagnostics` map exactly as substrate publishes it, not a local restatement. */
export type EnvelopeDiagnostics = NonNullable<PackEnvelope['_diagnostics']>;

/** One frame key's worth of that map. */
type EnvelopeDiagnosticEntry = EnvelopeDiagnostics[string];

/**
 * Every `_diagnostics` key this module knows how to report. Doubles as the
 * runtime allowlist behind `unrecognizedKeys`, so adding a key here without
 * teaching the sink to describe it would be caught by the tests rather than
 * shipped as a silent no-op.
 */
const HANDLED_ENVELOPE_KEYS = ['unknownProjectionFields', 'filterValidationSkipped'] as const;
const HANDLED = new Set<string>(HANDLED_ENVELOPE_KEYS);

/**
 * Keys substrate-types declares that this module does not handle. Normally `never`.
 *
 * A `check-types` failure here means the substrate contract widened and this
 * file has not caught up — the error names the key. Fix it by handling the key
 * in `describeEntry` and the default sink, then adding it to
 * `HANDLED_ENVELOPE_KEYS`. Do not widen the alias to make the error go away;
 * that reinstates exactly the silence this guard exists to break.
 */
type UnhandledEnvelopeKey = Exclude<
  keyof EnvelopeDiagnosticEntry,
  (typeof HANDLED_ENVELOPE_KEYS)[number]
>;
type AssertNoUnhandledEnvelopeKeys<T extends never> = T;
export type _EveryEnvelopeDiagnosticKeyIsHandled =
  AssertNoUnhandledEnvelopeKeys<UnhandledEnvelopeKey>;

/** One type's worth of non-fatal diagnostics, already attributed to its frame key. */
export interface Diagnostic {
  /** The top-level frame key this concerns, e.g. `notes/Todo`. */
  opKey: string;
  /**
   * Projection keys the type does not declare. Every one of them came back as
   * `null` on every row.
   *
   * Always present, and EMPTY when this diagnostic reports something else; kept
   * required so existing consumers keep getting an array.
   */
  unknownProjectionFields: string[];
  /**
   * Present when the where-clause reached the substrate without being
   * schema-validated, because the type is registered but absent from its
   * namespace's published schema (e.g. runtime-created types). The value is
   * substrate's explanation.
   *
   * Results are still correct — a substrate refuses a predicate it cannot
   * honour. What is lost is the indexed-field check, so an unindexed filter
   * SCANS instead of being rejected.
   */
  filterValidationSkipped?: string;
  /**
   * Diagnostic keys the substrate reported that this client version does not
   * understand — i.e. substrate-client is older than the substrate it is talking to.
   */
  unrecognizedKeys?: string[];
}

/**
 * Sink for envelope diagnostics. Called once per affected frame key, per
 * query/mutate response. Pass your own via `SubstrateClientOptions.onDiagnostics` to
 * route into a logger or metrics pipeline; throwing from it in development is
 * the third option substrate-types sanctions.
 */
export type DiagnosticsSink = (diagnostic: Diagnostic) => void;

/**
 * Reduce one envelope entry to a diagnostic, or `undefined` when it holds
 * nothing worth reporting — an entry present but empty, or one whose only
 * unknown-field list is empty. Without that, the default sink emits a warning
 * naming no observation at all.
 */
function describeEntry(opKey: string, entry: EnvelopeDiagnosticEntry): Diagnostic | undefined {
  const unknownProjectionFields = [...(entry.unknownProjectionFields ?? [])];
  const { filterValidationSkipped } = entry;
  const unrecognizedKeys = Object.keys(entry)
    .filter((k) => !HANDLED.has(k) && (entry as Record<string, unknown>)[k] !== undefined)
    .sort();

  if (
    unknownProjectionFields.length === 0 &&
    filterValidationSkipped === undefined &&
    unrecognizedKeys.length === 0
  ) {
    return undefined;
  }

  const diagnostic: Diagnostic = { opKey, unknownProjectionFields };
  if (filterValidationSkipped !== undefined) {
    diagnostic.filterValidationSkipped = filterValidationSkipped;
  }
  if (unrecognizedKeys.length > 0) diagnostic.unrecognizedKeys = unrecognizedKeys;
  return diagnostic;
}

/**
 * Extract diagnostics from a decoded envelope and hand each one to `sink`.
 * Returns the flattened list so callers can also attach it to a mapped result.
 *
 * An envelope with no `_diagnostics` returns `[]` without the sink firing.
 */
export function collectDiagnostics(
  envDiagnostics: EnvelopeDiagnostics | undefined,
  sink: DiagnosticsSink | undefined
): Diagnostic[] {
  if (envDiagnostics === undefined) return [];

  const out: Diagnostic[] = [];
  for (const [opKey, entry] of Object.entries(envDiagnostics)) {
    if (entry === null || entry === undefined) continue;
    const diagnostic = describeEntry(opKey, entry);
    if (diagnostic === undefined) continue;
    out.push(diagnostic);
    sink?.(diagnostic);
  }
  return out;
}

/**
 * Default sink: one `console.warn` per distinct observation set, naming the
 * frame key and everything observed about it, plus the reason the reader should
 * care in each case.
 *
 * ONE warning per diagnostic rather than one per observation. An entry carrying
 * both an unknown projection and a skipped filter validation describes a single
 * read, and splitting it reads as two independent defects.
 *
 * Deduping state is per-sink, so per-client: `new SubstrateClient(...)` starts
 * fresh.
 */
export function createDefaultDiagnosticsSink(): DiagnosticsSink {
  const seen = new Set<string>();
  return (diagnostic) => {
    const { opKey, filterValidationSkipped } = diagnostic;
    const fields = [...diagnostic.unknownProjectionFields].sort();
    const unrecognized = [...(diagnostic.unrecognizedKeys ?? [])].sort();

    // NUL separator: `filterValidationSkipped` is free-form prose, so any
    // printable separator could collide. Keep it an escape, not the raw byte,
    // or git treats this file as binary.
    const dedupeKey = [
      opKey,
      fields.join(','),
      filterValidationSkipped ?? '',
      unrecognized.join(',')
    ].join('\u0000');
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    const parts: string[] = [];
    if (fields.length > 0) {
      parts.push(
        `projected field(s) the type does not declare: ${fields.join(', ')}. ` +
          'The read succeeded — these are null on EVERY row, which is indistinguishable ' +
          'from a declared field that is always null. Check for a typo, or a substrate ' +
          'that has not restarted with your schema yet.'
      );
    }
    if (filterValidationSkipped !== undefined) {
      parts.push(
        `the where-clause was not schema-validated (${filterValidationSkipped}), so an ` +
          'unindexed filter SCANNED rather than being rejected. Results are still correct — ' +
          'the substrate refuses a predicate it cannot honour — but the cost is unbounded ' +
          'on a large table.'
      );
    }
    if (unrecognized.length > 0) {
      parts.push(
        `the substrate reported diagnostic(s) this client cannot read: ${unrecognized.join(', ')}. ` +
          'Upgrade @mnmal-ai/substrate-client to surface them.'
      );
    }

    console.warn(
      `[substrate-client] ${opKey}: ${parts.join(' Also, ')} ` +
        '(Pass `onDiagnostics` to SubstrateClient to route this elsewhere.)'
    );
  };
}
