/**
 * `_system/SigningKey` — public read primitive for JWT verification material.
 *
 * Returns only `(publicKey, algorithm)` for a kid. Public because a plugin
 * running its own JWT verifier has no verified identity yet when it asks; the
 * full `_system/Key` row stays admin-gated.
 *
 * Backed by the same primed `KeyRegistry` the substrate's auth verifier
 * consults, so lookups are synchronous in-memory and naturally honour the
 * registry's revocation filter — a kid whose `revokedAt` is in the past
 * resolves to "not found", same as the verifier sees.
 *
 * Call shape: `engine.query({ '_system/SigningKey': { params: { where: { id: { eq: kid } } }, fields: ... } })`.
 *
 * Contract: ONLY `where.id.eq = <non-empty string>` is supported. Any other
 * shape — compound predicates (AND/OR/NOT), extra top-level keys, or a missing
 * or non-eq `id` predicate — returns an empty list and emits an
 * `engine_signing_key_unsupported_where` metric so operators can detect
 * misuse. This is a keyed lookup primitive, not a list/scan.
 */

import type { Resolver, Row } from '@mnmal-ai/substrate-types';
import type { KeyRegistry } from './registry.js';

export type SigningKeyMetric = (name: string, attrs?: object) => void;

/**
 * Extract the `kid` string from a `where` clause that has exactly the shape
 * `{ id: { eq: <non-empty string> } }`. Any other shape is rejected:
 *
 * - Compound predicates (AND / OR / NOT discriminators) are unsupported and
 *   emit `engine_signing_key_unsupported_where` with `reason: 'compound'`.
 * - Extra top-level keys alongside `id` are unsupported and emit the metric
 *   with `reason: 'extra_fields'`. Callers who add defence-in-depth filters
 *   (e.g. `revokedAt: { eq: null }`) believe they are filtering, but this
 *   resolver cannot honour them — surfacing the mismatch explicitly is safer
 *   than silently ignoring it.
 * - Everything else (wrong operator, wrong type, missing where) returns null
 *   without a metric because those are expected call shapes (e.g. "no filter
 *   supplied").
 */
function extractKid(where: unknown, metric?: SigningKeyMetric): string | null {
  if (where === undefined || where === null) return null;
  if (typeof where !== 'object') return null;

  // Reject discriminated-union shapes (compound predicates not supported).
  if ('AND' in where || 'OR' in where || 'NOT' in where) {
    metric?.('engine_signing_key_unsupported_where', { reason: 'compound' });
    return null;
  }

  // Only the `id` key is supported at the top level. Reject any extra keys so
  // callers learn immediately that additional predicates are not evaluated.
  const keys = Object.keys(where);
  if (keys.length !== 1 || keys[0] !== 'id') {
    metric?.('engine_signing_key_unsupported_where', {
      reason: 'extra_fields',
      keys
    });
    return null;
  }

  const id = (where as { id?: unknown }).id;
  if (id === null || typeof id !== 'object') return null;
  const eq = (id as { eq?: unknown }).eq;
  return typeof eq === 'string' && eq.length > 0 ? eq : null;
}

export interface CreateSigningKeyResolverOptions {
  /** Optional metric sink for unsupported where-clause shapes. */
  onMetric?: SigningKeyMetric;
}

export function createSigningKeyResolver(
  registry: KeyRegistry,
  opts?: CreateSigningKeyResolverOptions
): Resolver {
  const metric = opts?.onMetric;
  return async (_ctx, args): Promise<Row[]> => {
    const kid = extractKid(args.params?.where, metric);
    if (kid === null) return [];
    const record = registry.lookup(kid);
    if (record === null) return [];
    return [
      {
        id: record.kid,
        publicKey: record.publicKey,
        algorithm: record.algorithm
      }
    ];
  };
}
