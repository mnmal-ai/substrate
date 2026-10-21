/**
 * Candidate selection for crystallisation.
 *
 * Recall does not hardcode what counts as junk — that is the consumer's
 * policy — but it does require the filter to be explicit. There is no
 * "cluster everything" default: near-duplicate fixtures form the densest
 * regions and would dominate the clusters.
 *
 * `bad_request`-coded throws map to 400 on the route and to
 * `ResolverFrameError('bad_request', …)` on the frame surface.
 */

/** One (namespace, type) pair to consider. */
export interface SelectorScope {
  namespace: string;
  type: string;
}

/**
 * Drop rows whose `body->>field` starts with `prefix`.
 */
export interface TextPrefixExclusion {
  field: string;
  prefix: string;
}

export interface CandidateSelector {
  scopes: SelectorScope[];
  excludeTextPrefixes: TextPrefixExclusion[];
  limit: number;
}

export interface Candidate {
  namespace: string;
  type: string;
  id: string;
  /** The stored vector, exactly as `embeddings` holds it. */
  vector: Float32Array;
  /** The full row body, used for labelling. */
  row: Record<string, unknown>;
}

/**
 * Ceiling on one selection, with headroom under `WasmClusterer`'s
 * `WASM_MAX_ROWS` refusal limit.
 */
export const SELECT_CANDIDATES_MAX_LIMIT = 20_000;

function bad(message: string): never {
  throw Object.assign(new Error(message), { code: 'bad_request' });
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function validateSelector(value: unknown): CandidateSelector {
  if (value === null || typeof value !== 'object') {
    bad('a selection filter is required — crystallise refuses to cluster everything by default');
  }
  const raw = value as Record<string, unknown>;

  if (!Array.isArray(raw.scopes)) {
    bad('"select.scopes" must be an array of { namespace, type }');
  }
  if (raw.scopes.length === 0) {
    bad('"select.scopes" must name at least one scope — there is no cluster-everything default');
  }
  const parsedScopes: SelectorScope[] = raw.scopes.map((entry, i) => {
    const s = entry as Record<string, unknown> | null;
    if (s === null || typeof s !== 'object') {
      bad(`"select.scopes[${i}]" must be an object`);
    }
    if (!nonEmptyString(s.namespace))
      bad(`"select.scopes[${i}].namespace" must be a non-empty string`);
    if (!nonEmptyString(s.type)) bad(`"select.scopes[${i}].type" must be a non-empty string`);
    return { namespace: s.namespace, type: s.type };
  });

  // Dedupe here, once: pg joins scopes via `unnest(...)`, so a duplicate
  // scope would emit every matching embedding twice and disagree with the
  // in-memory store's count. First-seen order is preserved.
  const seenScopes = new Set<string>();
  const scopes: SelectorScope[] = [];
  for (const s of parsedScopes) {
    const k = `${s.namespace}/${s.type}`;
    if (seenScopes.has(k)) continue;
    seenScopes.add(k);
    scopes.push(s);
  }

  let excludeTextPrefixes: TextPrefixExclusion[] = [];
  if (raw.excludeTextPrefixes !== undefined) {
    if (!Array.isArray(raw.excludeTextPrefixes)) {
      bad('"select.excludeTextPrefixes" must be an array of { field, prefix }');
    }
    excludeTextPrefixes = raw.excludeTextPrefixes.map((entry, i) => {
      const e = entry as Record<string, unknown> | null;
      if (e === null || typeof e !== 'object') {
        bad(`"select.excludeTextPrefixes[${i}]" must be an object`);
      }
      if (!nonEmptyString(e.field)) {
        bad(`"select.excludeTextPrefixes[${i}].field" must be a non-empty string`);
      }
      if (!nonEmptyString(e.prefix)) {
        bad(`"select.excludeTextPrefixes[${i}].prefix" must be a non-empty string`);
      }
      return { field: e.field, prefix: e.prefix };
    });
  }

  let limit = SELECT_CANDIDATES_MAX_LIMIT;
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit < 1) {
      bad('"select.limit" must be a positive integer');
    }
    limit = Math.min(raw.limit, SELECT_CANDIDATES_MAX_LIMIT);
  }

  return { scopes, excludeTextPrefixes, limit };
}
