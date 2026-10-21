/**
 * Pre-pass that resolves registered extension operators in a where-tree into
 * substrate-native predicates. Spec §5.2.
 *
 * The where-clause grammar lets substrate plugins register custom operators
 * via `registerExtensionOperator` (e.g. substrate-recall's `embeddingSimilar`).
 * Datasets can't translate those operators to native predicates directly —
 * the operator's `execute` is async, may hit external services (Ollama for
 * embeddings, etc.), and runs outside the synchronous SQL/in-memory filter
 * path. This pre-pass walks the tree, awaits each operator's `execute`, and
 * rewrites the hit into `{ id: { in: [...resolvedIds] } }`, which is
 * `{ id: { in: [] } }` (match nothing) when the operator returns no matches.
 * Datasets then translate the rewritten tree through their normal predicate
 * paths.
 *
 * LOSSLESS contract: an operator may return an ordered, scored
 * `{ hits: [{ id, score, vector? }, ...] }` envelope. The rewritten `id IN`
 * preserves hit order, and the relevance order + per-id computed projections
 * (score, optional vector) are surfaced as a side-channel `meta` via
 * `preResolveExtensionOperatorsDetailed`. Datasets use `meta` to re-impose
 * relevance order on the structurally-filtered rows and stitch the computed
 * fields (`_score`, `_vector`) onto them.
 *
 * Any other return shape is a contract violation and throws
 * {@link ExtensionOperatorResultError} naming the operator.
 */

import type { WhereClause } from '@mnmal-ai/substrate-types';
import { getExtensionOperator } from './extension-operators.js';

/**
 * Substrate context handed to extension operators at execute-time. Every
 * registered operator receives the namespace + type + result-cap from the
 * read() call so it can scope its lookup correctly. `embeddingSimilar`
 * (substrate-recall) reads namespace/type/k off this object.
 */
export interface ExtensionOpContext {
  namespace: string;
  type: string;
  k: number | undefined;
  /** Set by datasets when the frame projects `_vector`. Threaded to the operator's execute so it can ask its store for per-hit vectors. */
  returnVector?: boolean;
}

/**
 * Side-channel emitted by the lossless pre-resolve pass for each resolved
 * operator's `{ hits: [...] }`. `null` when the tree held no extension
 * operator. Datasets consume this to re-impose
 * relevance order on the structurally-filtered rows and stitch computed
 * projections (`_score`, `_vector`) onto them.
 *
 * Unspecified composition: if a single where-tree contains more than one
 * hits-shaped operator, the LAST one resolved wins the meta (the rewritten
 * `id` predicates AND together). Composing multiple relevance operators in one
 * tree has no defined ordering and should be avoided.
 */
export interface ExtensionOpResultMeta {
  /** Relevance order from the operator (hit order, best first). */
  orderedIds: string[];
  /** id → computed projection values stitched onto rows by the datasets. */
  computed: Map<string, { score: number; vector?: number[] }>;
}

/** Mutable holder threaded through the recursive walk so a hits-shaped operator anywhere in the tree can surface its meta. Last writer wins (see ExtensionOpResultMeta). */
interface MetaHolder {
  current: ExtensionOpResultMeta | null;
}

/**
 * Thrown when a registered extension operator's `execute` resolves to
 * anything other than `{ hits: [...] }`.
 */
export class ExtensionOperatorResultError extends Error {
  readonly operator: string;

  constructor(operator: string) {
    super(`extension operator '${operator}' must resolve to { hits: [{ id, score, vector? }] }`);
    this.name = 'ExtensionOperatorResultError';
    this.operator = operator;
  }
}

/**
 * Walks a where-tree, replaces every registered extension-operator entry with
 * an order-preserving `{ id: { in: [...] } }`, and returns BOTH the
 * rewritten where and a `meta` side-channel.
 *
 * Returns a new where object — the input is not mutated.
 */
export async function preResolveExtensionOperatorsDetailed(
  where: WhereClause,
  context: ExtensionOpContext
): Promise<{ where: WhereClause; meta: ExtensionOpResultMeta | null }> {
  const holder: MetaHolder = { current: null };
  const resolved = await walk(where, context, holder);
  return { where: resolved, meta: holder.current };
}

/** Recursive tree walk behind {@link preResolveExtensionOperatorsDetailed}. */
async function walk(
  where: WhereClause,
  context: ExtensionOpContext,
  holder: MetaHolder
): Promise<WhereClause> {
  if (where === null || typeof where !== 'object' || Array.isArray(where)) return where;
  const keys = Object.keys(where);
  if (keys.length === 0) return where;

  const out: Record<string, unknown> = {};
  const idClauses: WhereClause[] = [];
  for (const key of keys) {
    const value = (where as Record<string, unknown>)[key];

    if (key === 'AND' || key === 'OR') {
      if (Array.isArray(value)) {
        const resolved = await Promise.all(
          value.map((sub) => walk(sub as WhereClause, context, holder))
        );
        out[key] = resolved;
      } else {
        out[key] = value;
      }
      continue;
    }
    if (key === 'NOT') {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        out[key] = await walk(value as WhereClause, context, holder);
      } else {
        out[key] = value;
      }
      continue;
    }

    const op = getExtensionOperator(key);
    if (op === undefined) {
      out[key] = value;
      continue;
    }

    const result = await op.execute(value, context);
    if (!isHitsResult(result)) throw new ExtensionOperatorResultError(key);
    const meta = buildMeta(result.hits);
    holder.current = meta;
    // Defensive copy: the where-tree's in-array must not alias
    // meta.orderedIds — a dataset that ever sorted/deduped the operand in
    // place would silently scramble the relevance order this feature
    // exists to preserve.
    idClauses.push({ id: { in: [...meta.orderedIds] } } as WhereClause);
  }

  if (idClauses.length === 0) return out as WhereClause;
  // The caller's own `id` predicate, if any, ANDs with the resolved ones.
  if (out.id !== undefined) idClauses.unshift({ id: out.id } as WhereClause);
  if (idClauses.length === 1) return { ...out, ...idClauses[0] } as WhereClause;
  delete out.id;
  return { AND: [out as WhereClause, ...idClauses] } as WhereClause;
}

/** Narrow an operator result to the hits envelope. */
function isHitsResult(result: unknown): result is { hits: unknown[] } {
  return (
    result !== null &&
    typeof result === 'object' &&
    Array.isArray((result as { hits?: unknown }).hits)
  );
}

/**
 * Build the ordered-ids list + computed Map from a hits array. Hits with a
 * non-string id are skipped (defensive — bad input becomes "no match" rather
 * than an error). The vector key is spread conditionally so a hit without a
 * vector yields a computed entry with NO `vector` key (exactOptionalPropertyTypes).
 */
function buildMeta(hits: unknown[]): ExtensionOpResultMeta {
  const orderedIds: string[] = [];
  const computed = new Map<string, { score: number; vector?: number[] }>();
  for (const hit of hits) {
    if (hit === null || typeof hit !== 'object') continue;
    const id = (hit as { id?: unknown }).id;
    if (typeof id !== 'string') continue;
    const rawScore = (hit as { score?: unknown }).score;
    const score = typeof rawScore === 'number' ? rawScore : 0;
    const rawVector = (hit as { vector?: unknown }).vector;
    const hasVector = Array.isArray(rawVector);
    orderedIds.push(id);
    computed.set(id, {
      score,
      ...(hasVector ? { vector: rawVector as number[] } : {})
    });
  }
  return { orderedIds, computed };
}
