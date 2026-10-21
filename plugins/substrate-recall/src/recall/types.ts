/**
 * Shared recall surface types.
 *
 * Policy probes, input/output shapes, salience config and dependency bags.
 * Declarations, plus `DEFAULT_SALIENCE_CONFIG` and `bindPolicy`.
 */

import type { Embedder } from '@mnmal-ai/substrate-embedder';
import type { Identity, PolicyDecision, PolicyProbeContext } from '@mnmal-ai/substrate-types';
import type { EmbedStats } from '../embed-stats.js';
import type { EmbeddingsStore, KnnRowFilter, SalienceTarget } from '../embeddings-store.js';
import type { ExpansionNeighbour, ExpansionSourceRow } from '../expansion-resolver.js';
import type { LexicalStore } from '../lexical-store.js';
import type { CallerContext } from '../row-visibility.js';
import type { SpreadSourceRow } from '../spread-resolver.js';

/**
 * Read-policy probe for the recall surfaces. Hosts wire this to
 * `engine.evaluateReadPolicy` so recall honours the same policies that gate
 * `engine.query`. Absent → open.
 *
 * The decision is taken per (namespace, type) with no query args, so a policy
 * that allows reads only for some `where` scopes is evaluated with none. Its
 * `row-filter` obligations are then evaluated per row, against the full
 * stored body, with the caller's request context (`row-visibility.ts`).
 */
export type ReadPolicyCheck = (
  ns: string,
  type: string,
  identity: Identity | null,
  probe?: PolicyProbeContext
) => PolicyDecision;

/**
 * Write-policy probe for the surfaces that mutate. Hosts wire this to
 * `engine.evaluateWritePolicy`.
 *
 * Separate from `ReadPolicyCheck` because a namespace can gate writes while
 * leaving reads open. Absent → the write does not happen (fails closed,
 * unlike `ReadPolicyCheck`).
 */
export type WritePolicyCheck = (
  ns: string,
  type: string,
  identity: Identity | null,
  probe?: PolicyProbeContext
) => PolicyDecision;

/**
 * Bind the caller into a check, giving the 2-arg check the cores take. The
 * caller's headers, `clientIp`, `meta` and `authEnabled` reach the policy, so a
 * type-level decision matches dispatch.
 */
export function bindPolicy(
  check: ReadPolicyCheck | WritePolicyCheck,
  caller: CallerContext
): (ns: string, type: string) => PolicyDecision;
export function bindPolicy(
  check: ReadPolicyCheck | WritePolicyCheck | undefined,
  caller: CallerContext
): ((ns: string, type: string) => PolicyDecision) | undefined;
export function bindPolicy(
  check: ReadPolicyCheck | WritePolicyCheck | undefined,
  caller: CallerContext
): ((ns: string, type: string) => PolicyDecision) | undefined {
  if (check === undefined) return undefined;
  return (ns, type) => check(ns, type, caller.identity, caller);
}

export interface RecallInput {
  query: string;
  k?: number;
  /**
   * Set `false` to turn the lexical arm off for this request. The arm is on
   * whenever a `lexicalStore` is wired and the type declares `lexical.source`;
   * this can only turn it off, never on.
   */
  lexical?: boolean;
  /** Return per-arm ranks and the pre-fusion dense score on each row. */
  explain?: boolean;
  namespace?: string;
  type?: string;
  /**
   * Cosine floor (0..1) on the dense arm, and on lexical-only rows unless
   * `lexicalThreshold` is set. Lexical-only rows are scored against their
   * stored vectors; one with no stored vector is dropped. Applies only when
   * the dense arm runs. Default 0.
   */
  threshold?: number;
  /**
   * Cosine floor for lexical-only hits, scored against their stored vectors.
   * Default: `threshold`. `0` leaves them unfloored, keeping rows that have no
   * stored vector.
   */
  lexicalThreshold?: number;
  /**
   * When `true` AND the plugin-level kill-switch is on, walks opt-in
   * crossRefs from the knn top-K, fetches neighbour embeddings, computes
   * fresh cosine vs the query vector, merges into the candidate pool, and
   * re-ranks. Expanded rows are annotated with `_expandedFrom`. Default
   * `false`.
   */
  expand?: boolean;
  /**
   * When `false`, the recall runs normally (KNN + blend + scored envelope)
   * but skips the fire-and-forget salience boost on the returned rows — for
   * consumers that reinforce explicitly on use instead of on retrieval
   * (`POST /substrate/v1/salience/boost`). Default `true`.
   */
  boost?: boolean;
  /**
   * When `true`, each returned row carries its stored embedding vector
   * (`RecallRow.vector`), saving a `/substrate/v1/embeddings/fetch` round-trip.
   * Vectors ride the row's existing read-policy gate. Default `false`.
   */
  returnVector?: boolean;
  /**
   * Row-field filter, field -> `{ eq }` or `{ in }`, every field must match.
   * Applied inside every candidate source (dense kNN, lexical search,
   * expansion), so k fills with matching rows. `eq: null` matches a missing
   * or null field. A malformed filter is refused with `bad_request`.
   */
  where?: KnnRowFilter;
}

export interface RecallRow {
  /**
   * Per-arm ranks, present only under `explain: true`. `null` for an arm that
   * did not return this row — distinct from a rank, which is 1-based.
   */
  _arms?: { dense: number | null; lexical: number | null };
  /**
   * Pre-fusion dense score, present only under `explain: true`.
   *
   * `null` for a row the dense arm never ranked. Not `0`: that is a real
   * cosine, and a consumer comparing against a floor would wrongly admit a
   * lexical-only row.
   */
  _denseScore?: number | null;
  row: Record<string, unknown>;
  /**
   * Actual (namespace, type) of this row. Equals the query's ns/type for
   * direct knn hits; for rows pulled in via cross-type expansion it is the
   * neighbour's real ns/type.
   */
  namespace: string;
  type: string;
  score: number;
  /**
   * Per-row salience signal feeding into ranking. `0` for never-recalled
   * rows.
   */
  _salience: number;
  /**
   * Score after `salience_weight` blend. Equals `score` when weight=0
   * (default). When weight>0: `score * (1 + weight * log(1 + salience))`.
   */
  _blendedScore: number;
  /**
   * Set on rows that entered the result pool via expansion. Records the seed (namespace, type, id) from which this row was reached.
   * Absent for rows returned directly by knn.
   */
  _expandedFrom?: { namespace: string; type: string; id: string };
  /**
   * The row's stored embedding vector. Present iff the request set
   * `returnVector: true` and the store had a vector for the row (knn hits
   * always do; scored expansion rows carry the fetched neighbour vector).
   */
  vector?: number[];
}

export interface RecallTimings {
  /** Embedder call. */
  readonly embed_ms: number;
  /** KNN scan against the EmbeddingsStore (e.g. pgvector HNSW). */
  readonly knn_ms: number;
  /** End-to-end handler latency. */
  readonly total_ms: number;
}

export interface RecallOutput {
  rows: RecallRow[];
  /**
   * The dense arm's embedding model; empty string when no dense arm ran.
   * Required rather than optional so `undefined` is never read as "server
   * predates the field".
   */
  model: string;
  timings: RecallTimings;
  /**
   * Which arms actually ran: the effective mode, not the requested one
   * (recall ignores unknown body fields, so the request is not evidence).
   *
   * Optional because this is a wire response: `undefined` means the server
   * predates the field, not that no arm ran. Do not collapse the two.
   */
  arms?: {
    /**
     * Did the dense arm run? False when no embedder is configured, equally
     * when one is but no `EmbeddingsStore` is — knn needs both halves — and
     * equally when the TYPE declares no `embed.source`, which is the case a
     * caller cannot detect for itself. `denseWhy` says which.
     */
    dense: boolean;
    /**
     * Why the dense arm did or did not run; the mirror of `lexicalWhy`.
     * `no-source` means the type is never embedded, so an empty result is not
     * "nothing matched".
     *
     * Optional, unlike `lexicalWhy`, so consumers that construct a
     * `RecallOutput` keep compiling. The core always populates it; absent
     * means the server predates the field and must not be read as `ran`.
     */
    denseWhy?: 'ran' | 'no-embedder' | 'no-store' | 'no-source';
    /**
     * Did the lexical arm run? False when no `lexicalStore` is wired, when the
     * type declares no `lexical.source`, or when the caller passed
     * `lexical: false` — three different reasons, and `lexicalWhy` says which.
     */
    lexical: boolean;
    /**
     * Why the lexical arm did or did not run. `no-source` means the arm cannot
     * match for this type, which an empty result alone would not reveal.
     */
    lexicalWhy: 'ran' | 'no-store' | 'no-source' | 'disabled-by-request';
  };
}

/** Configuration for the salience blend in `handleRecallRequest`. */
export interface SalienceConfig {
  /**
   * Blend weight. `0` (default) → ranking unchanged.
   * `>0` re-ranks by `cosine * (1 + weight * log(1 + salience))`.
   */
  weight: number;
  /** Half-life used for the boost-on-recall decay. Hours. */
  halfLifeHours: number;
  /**
   * Activation-spreading damping. When the route's
   * `spreadResolver` returns opt-in crossRef neighbours, each gets a boost
   * of `spreadDamping` × the primary +1. Default 0.3 keeps the spread
   * signal modest; 0 disables spreading entirely even if a resolver is
   * configured.
   */
  spreadDamping: number;
}

/** Default salience config: off (weight=0, 7-day half-life, 0.3 damping). */
export const DEFAULT_SALIENCE_CONFIG: SalienceConfig = {
  weight: 0,
  halfLifeHours: 24 * 7,
  spreadDamping: 0.3
};

/**
 * Spread-target resolver. Built by the plugin from
 * the spread registry + an `EdgesStore`. recall-route invokes it with the
 * boosted source rows; the resolver returns deduplicated forward + backward
 * targets to apply a damped boost on. `null` short-circuits the spread path.
 */
export type SpreadResolver = (sources: ReadonlyArray<SpreadSourceRow>) => Promise<SalienceTarget[]>;

/**
 * Expansion resolver. Built by the plugin from the spread
 * registry + an optional `EdgesStore`. recall-route invokes it with the knn
 * top-K source rows; the resolver returns deduplicated (namespace, type, id)
 * candidates to fetch + score. `null` short-circuits the expansion path.
 */
export type ExpansionResolver = (
  sources: ReadonlyArray<ExpansionSourceRow>
) => Promise<ExpansionNeighbour[]>;

/**
 * Dependencies for `handleRecallRequest`. Every member is optional; an absent
 * one defaults to the off/empty behaviour.
 */
export interface RecallDeps {
  /**
   * Dense arm: both halves or neither. An embedder with no store is no dense
   * arm, and `arms.dense` reports the conjunction. Optional because the
   * lexical arm needs no model.
   */
  embedder?: Embedder;
  store?: EmbeddingsStore;
  /**
   * Lexical arm store. Absent → the arm never runs, and the response says so
   * via `arms.lexicalWhy: 'no-store'` rather than leaving the caller to infer
   * it from an unchanged result.
   */
  lexicalStore?: LexicalStore;
  /**
   * Which types declare a `lexical.source` — satisfied by
   * `LexicalSourceRegistry`.
   *
   * Absent or empty both run the arm. An empty registry is not yet populated
   * (it fills at `contributePostWrites` time); treating it as authoritative
   * would disable the arm for every type.
   */
  lexicalSources?: { get(namespace: string, type: string): unknown; size(): number };
  /**
   * Which types declare an `embed.source` — satisfied by
   * `EmbedSourceRegistry`. Lets the dense arm answer `denseWhy: 'no-source'`
   * instead of running a knn that cannot match.
   *
   * Absent or empty both run the arm, as for `lexicalSources`.
   */
  embedSources?: { get(namespace: string, type: string): unknown; size(): number };
  salience?: SalienceConfig;
  spreadResolver?: SpreadResolver | null;
  expansionResolver?: ExpansionResolver | null;
  expansionEnabled?: boolean;
  stats?: EmbedStats;
  /**
   * Identity-bound read-policy check — the transport caller
   * (HTTP route / MCP tool) binds its identity before delegating here.
   * Denied primary scope throws `{ code: 'policy_denied' }` before any
   * embedder/store work; denied expansion-neighbour types are silently
   * dropped from the candidate pool. Absent → open.
   */
  checkReadPolicy?: (ns: string, type: string) => PolicyDecision;
  /** The caller's request context, for row-filter obligations. Absent → anonymous. */
  caller?: CallerContext;
  /**
   * Identity-bound write-policy check for the salience boost only. A denial
   * skips the boost but does not fail the recall. Absent → no boost (fails
   * closed).
   */
  checkWritePolicy?: (ns: string, type: string) => PolicyDecision;
}
