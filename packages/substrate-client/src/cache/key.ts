/**
 * Deterministic cache-key derivation for QualifiedFrame values. Spec §7.0
 *
 * Uses substrate-types' `canonicalize` — the same implementation the server uses
 * for schemaVersion hashing — so one patch point covers both sides. Keys are
 * sorted recursively; arrays keep their order (batched frames are ordered).
 * `undefined` values hash the same as absent, intentionally.
 */
import { canonicalize } from '@mnmal-ai/substrate-types';

export function canonicaliseFrameKey(qualifiedName: string, body: unknown): string {
  return `${qualifiedName}:${JSON.stringify(canonicalize(body))}`;
}
