/** The page a list read gets: a default `limit` where it names none, a refusal above the maximum. */

import type { EngineInput, FrameEntry, PackEnvelope } from '@mnmal-ai/substrate-types';
import { addError, type NamespaceConfig, type ParsedKey } from './internals.js';

/**
 * A list read on a dataset-backed type gets the default page when it names
 * no `limit`, and is refused above the maximum. Virtual types own their
 * params, so they pass through untouched.
 */
export function applyPageLimits(
  namespaces: ReadonlyMap<string, NamespaceConfig>,
  envelope: PackEnvelope,
  key: string,
  input: FrameEntry,
  parsed: ParsedKey | null,
  limits: EngineInput['pageLimits']
): FrameEntry | null {
  let entry = input;
  if (limits === undefined || parsed === null) return entry;
  const nsCfg = namespaces.get(parsed.ns);
  if (nsCfg === undefined || nsCfg.virtual === true) return entry;
  if (nsCfg.registry.get(parsed.name)?.kind !== 'type') return entry;
  // A nested `{ _walk }` selection's limit has the same max; it has no cursor in v1.
  const nested = nestedOverLimit(entry.fields, ['fields'], limits.maxLimit);
  if (nested !== null) {
    addError(
      envelope,
      [key, ...nested],
      `nested limit exceeds the maximum page of ${limits.maxLimit}`,
      'limit_exceeds_max',
      { max: limits.maxLimit }
    );
    return null;
  }
  // A nested selection without a limit gets the default page, as a row read does.
  if (entry.fields !== undefined) {
    entry = { ...entry, fields: withNestedDefaultLimits(entry.fields, limits.defaultLimit) };
  }
  const limit = entry.params?.limit;
  if (limit === undefined || limit === null) {
    return { ...entry, params: { ...entry.params, limit: limits.defaultLimit } };
  }
  // Anything a reader might take as "no limit" is refused, not passed on.
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) {
    addError(envelope, [key, 'limit'], 'limit must be a non-negative integer', 'invalid_limit');
    return null;
  }
  if (limit > limits.maxLimit) {
    addError(
      envelope,
      [key, 'limit'],
      `limit ${limit} exceeds the maximum page of ${limits.maxLimit}; ${
        entry.params?.aggregate !== undefined ? 'page with offset' : 'page with the returned cursor'
      }`,
      'limit_exceeds_max',
      { max: limits.maxLimit }
    );
    return null;
  }
  return entry;
}

/** `fields` with every nested `{ _walk }` selection lacking a `limit` given `limit`, at any depth. */
function withNestedDefaultLimits<T>(fields: T, limit: number): T {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return fields;
  return Object.fromEntries(
    Object.entries(fields).map(([name, sel]) => {
      // `_agg` specs are not selections: their `where` may hold a `_walk`.
      if (name === '_agg' || typeof sel !== 'object' || sel === null || Array.isArray(sel)) {
        return [name, sel];
      }
      const s = sel as Record<string, unknown>;
      if (!Object.hasOwn(s, '_walk')) return [name, withNestedDefaultLimits(s, limit)];
      return [
        name,
        {
          ...s,
          ...(Object.hasOwn(s, 'fields')
            ? { fields: withNestedDefaultLimits(s.fields, limit) }
            : {}),
          ...(s.limit === undefined || s.limit === null ? { limit } : {})
        }
      ];
    })
  ) as T;
}

/** Path to the first nested `{ _walk }` selection whose numeric `limit` exceeds `max`, at any depth. */
function nestedOverLimit(fields: unknown, path: string[], max: number): string[] | null {
  if (typeof fields !== 'object' || fields === null) return null;
  for (const [name, sel] of Object.entries(fields)) {
    if (name === '_agg' || typeof sel !== 'object' || sel === null) continue;
    const s = sel as Record<string, unknown>;
    const walk = Object.hasOwn(s, '_walk');
    if (walk && typeof s.limit === 'number' && s.limit > max) return [...path, name, 'limit'];
    const deeper = walk
      ? nestedOverLimit(s.fields, [...path, name, 'fields'], max)
      : nestedOverLimit(s, [...path, name], max);
    if (deeper !== null) return deeper;
  }
  return null;
}
