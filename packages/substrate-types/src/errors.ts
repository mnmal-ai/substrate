/**
 * Pure-data error classes shared across the engine (substrate-core), authoring
 * layer (substrate-sdk), and downstream plugins.
 *
 * Living here lets substrate-sdk throw and substrate-core catch without substrate-sdk
 * taking a runtime dep on the engine package.
 */

import type { Edge, EdgeRef } from './edge.js';

/** Refusal codes for the typed-edge-walk grammar (`SUBSTRATE_WALKS`). */
export const WALKS_DISABLED = 'walks_disabled';
export const WALKS_NEED_PARTITIONED = 'walks_need_partitioned';
export const WALKS_IN_SUBSCRIPTION = 'walks_in_subscription';
export const WALKS_IN_MUTATION = 'walks_in_mutation';
export const ROW_POLICY_BLOCKS_WALK = 'row_policy_blocks_walk';
export const WALK_BUDGET_EXCEEDED = 'walk_budget_exceeded';
export const WALKS_UNSUPPORTED_STORE = 'walks_unsupported_store';

/**
 * Throwable by a resolver to surface a structured per-frame error with a
 * caller-chosen `code` instead of the generic `resolver_error`. The engine's
 * mutate / query / subscribe / stream paths all catch this class alongside
 * `RestrictViolation` and translate it into an envelope error
 * `{ message, code, path: [key] }`.
 *
 * Use it when a resolver needs to refuse a frame with policy-style semantics
 * but the decision depends on runtime state that a `Policy` can't cleanly
 * express, or when the rejection has a distinct code the client should be
 * able to branch on.
 */
export class ResolverFrameError extends Error {
  override readonly name: string = 'ResolverFrameError';
  /** Cross-realm brand: stays true on every subclass even when `name` is
   *  overridden (e.g. MissingReferentError). isResolverFrameError checks this
   *  rather than `name`, which a subclass may re-tag. */
  readonly __substrateResolverFrameError = true;
  readonly code: string;
  /**
   * Optional structured payload carried alongside `code` + `message` for
   * programmatic discrimination (NL agents, MCP clients, test assertions).
   * Common shape: `{ field: '<rejected-field-name>' }` for field-rejection
   * codes. The engine projects this verbatim onto the envelope error's
   * `details` slot when present; absent → no `details` key in the envelope.
   */
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Thrown by a write-path resolver when a crossRef declaring `onMissing: 'reject'`
 * references a target that does not exist (or has been tombstoned). Extends
 * ResolverFrameError so the engine's existing catch branch surfaces it as a
 * clean `missing_referent` envelope error with structured `details`.
 */
export class MissingReferentError extends ResolverFrameError {
  override readonly name = 'MissingReferentError';

  constructor(field: string, target: { ns: string; type: string; id: string | number }) {
    super(
      'missing_referent',
      `crossRef '${field}' references a non-existent ${target.ns}/${target.type} (id=${target.id})`,
      { field, target }
    );
  }
}

/**
 * Thrown by a substrate when a where-clause predicate cannot be honoured —
 * an operator the compiler has no case for, or an operand whose shape the
 * operator cannot use (`in` given a string, `between` given one element).
 *
 * Not redundant with the upstream filter validator: it only runs for entries
 * with a schema to walk, so virtual, custom-resolver and dataset-less entries
 * reach the substrate unvalidated. Without this throw a substrate silently
 * drops the predicate (matching everything) or matches nothing.
 */
export class UnsupportedFilterError extends ResolverFrameError {
  override readonly name = 'UnsupportedFilterError';

  constructor(field: string, operator: string, reason: string) {
    super(
      'unsupported_filter',
      `filter on '${field}' cannot be honoured: operator '${operator}' ${reason}`,
      { field, operator }
    );
  }
}

/**
 * Thrown by `deleteRow` when a target's incoming edges include at least one
 * live edge with `policy: 'restrict'`. The engine catches and surfaces a
 * structured `restrict` envelope error rather than rolling back. Spec §6.2.
 */
export class RestrictViolation extends Error {
  override readonly name = 'RestrictViolation';
  readonly blockedBy: Edge[];

  constructor(ref: EdgeRef, blockedBy: Edge[]) {
    super(
      `restrict: cannot delete ${ref.ns}/${ref.type}/${ref.id}; ${blockedBy.length} live restrict edge(s) point at it`
    );
    this.blockedBy = blockedBy;
  }
}

/**
 * Thrown by `Dataset` implementations when a caller-supplied namespace
 * doesn't match the dataset's bound namespace. Spec §4.5. Shared here so
 * `instanceof` works across dataset impls.
 */
export class NamespaceMismatch extends Error {
  override readonly name = 'NamespaceMismatch';

  constructor(expected: string, actual: string) {
    super(`namespace mismatch: dataset is bound to '${expected}', got '${actual}'`);
  }
}

/**
 * Thrown by `Dataset.updateField` when the caller targets a reserved
 * field name (e.g. `_deletedAt`). Spec §4.5.
 */
export class ReservedField extends Error {
  override readonly name = 'ReservedField';

  constructor(field: string) {
    super(`field '${field}' is reserved and cannot be written via updateField`);
  }
}

/**
 * The `(auth)` tag `HttpBridgeClient` appends to a 401/403 cause. Single
 * source of truth for the convention: the error message wording and the
 * engine's `bridge_auth_failed` metric both key off it, and they must agree.
 */
export function isAuthCause(cause: unknown): boolean {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return detail.includes('(auth)');
}

/**
 * Thrown by `BridgeClient` implementations when the remote can't be reached,
 * or refuses the credential. Spec §5.8 ("Reads are timeout-bound. On
 * unreachable target → surface as `{ __orphan: true, reason:
 * 'bridge_unreachable' }`") + §6.5 ("Reads never fail"). Caught by the engine
 * + sweep via instanceof to translate into the sentinel envelope without
 * rolling back the surrounding tx.
 */
export class BridgeUnreachableError extends Error {
  override readonly name = 'BridgeUnreachableError';
  readonly bridgeName: string;
  readonly baseUrl: string;
  override readonly cause: unknown;

  constructor(bridgeName: string, baseUrl: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    // A 401/403 peer is reachable but refused the credential. Both throw this
    // type (§6.5: reads degrade non-fatally either way), but the message must
    // tell the operator to fix the credential, not chase an outage.
    // `HttpBridgeClient` tags these causes `(auth)`; this layer never sees the
    // status code.
    super(
      isAuthCause(detail)
        ? `bridge '${bridgeName}' (${baseUrl}) refused the request: ${detail} — the peer is reachable and answered, but rejected this credential. Check that it carries the capability this operation needs (a read-only credential cannot mutate) rather than chasing an outage.`
        : `bridge '${bridgeName}' (${baseUrl}) unreachable: ${detail}`
    );
    this.bridgeName = bridgeName;
    this.baseUrl = baseUrl;
    this.cause = cause;
  }
}

/**
 * Recognise a {@link ResolverFrameError} across module-realm boundaries.
 *
 * Plain `instanceof` is realm-fragile whenever this class exists twice in one
 * process: an error thrown by a plugin resolver is then NOT `instanceof` the
 * engine's class even though it is structurally the same type. Two copies
 * arise from version skew between host and plugin installs, or from a
 * consumer that bundles this package.
 *
 * Accepts the dedicated
 * `__substrateResolverFrameError` brand (which survives on subclasses even when
 * `name` is overridden, e.g. `MissingReferentError`) OR the legacy
 * `name === 'ResolverFrameError'` tag, in both cases gated on a string `code`.
 */
export function isResolverFrameError(err: unknown): err is ResolverFrameError {
  if (err instanceof ResolverFrameError) return true;
  if (typeof err !== 'object' || err === null) return false;
  if (typeof (err as { code?: unknown }).code !== 'string') return false;
  return (
    (err as { __substrateResolverFrameError?: unknown }).__substrateResolverFrameError === true ||
    (err as { name?: unknown }).name === 'ResolverFrameError'
  );
}

/**
 * Recognise a {@link RestrictViolation} across module-realm boundaries — same
 * realm-fragility rationale as {@link isResolverFrameError}. Brands on `name`
 * plus the discriminating `blockedBy` array.
 */
export function isRestrictViolation(err: unknown): err is RestrictViolation {
  if (err instanceof RestrictViolation) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'RestrictViolation' &&
    Array.isArray((err as { blockedBy?: unknown }).blockedBy)
  );
}
