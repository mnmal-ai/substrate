/**
 * Row-scoped read policy on the recall surfaces.
 *
 * A `row()` policy allows a (namespace, type) and attaches `row-filter`
 * obligations. The surfaces evaluate them per row with the caller's request
 * context, through the engine's own evaluator (`applyObligations`), against
 * the full stored row body.
 */

import { buildContext } from '@mnmal-ai/substrate-compose';
import { applyObligations } from '@mnmal-ai/substrate-core';
import type {
  PolicyDecision,
  RequestContext,
  Row,
  SubstrateRequest
} from '@mnmal-ai/substrate-types';
import type { EmbeddingsStore, SalienceTarget } from './embeddings-store.js';

/** The caller's request context; the per-scope fields are filled per check. */
export type CallerContext = Omit<RequestContext, 'namespace' | 'operation' | 'entry' | 'verb'>;

/** A read check with the caller's identity already bound. */
export type BoundReadCheck = (ns: string, type: string) => PolicyDecision;

/** The context of a caller with no transport identity (the MCP tool). */
export function anonymousCaller(): CallerContext {
  return { identity: null, now: new Date(), headers: {}, meta: {} };
}

// The host stamps the post-trust `clientIp` on the request; a handler mounted
// without that stamp falls back to the peer IP.
const NO_TRUSTED_PROXIES = new Set<string>();

/** The caller context the engine would build for this HTTP request. */
export function callerFromRequest(req: SubstrateRequest): CallerContext {
  return {
    ...anonymousCaller(),
    ...buildContext(req, NO_TRUSTED_PROXIES)
  };
}

/** A frame resolver's ctx, as a caller context. */
export function callerFromContext(ctx: RequestContext): CallerContext {
  const { namespace: _ns, operation: _op, entry: _entry, verb: _verb, ...caller } = ctx;
  return caller;
}

/** `check`, evaluated at most once per (namespace, type). */
export function memoCheck(check: BoundReadCheck | undefined): BoundReadCheck | undefined {
  if (check === undefined) return undefined;
  const seen = new Map<string, PolicyDecision>();
  return (ns, type) => {
    const key = `${ns}/${type}`;
    let decision = seen.get(key);
    if (decision === undefined) {
      decision = check(ns, type);
      seen.set(key, decision);
    }
    return decision;
  };
}

const STAND_INS = new WeakSet<object>();

/**
 * Marks `row` as a stand-in for a body the store could not resolve. A scope
 * with row filters never admits a stand-in, since the filter would judge a
 * body that is not the row's.
 */
export function unresolvedRow<T extends object>(row: T): T {
  STAND_INS.add(row);
  return row;
}

export function hasRowFilters(decision: PolicyDecision): boolean {
  return decision.obligations?.some((o) => o.kind === 'row-filter') ?? false;
}

/**
 * Keeps the items the caller may read, in order: a denied scope drops all of
 * its items, and an allowed one keeps those whose `row` its row-filter
 * obligations admit (never an {@link unresolvedRow} stand-in). Without a
 * check everything is kept.
 */
export function visibleRows<
  T extends { namespace: string; type: string; row: Row | Record<string, unknown> }
>(items: readonly T[], check: BoundReadCheck | undefined, caller: CallerContext | undefined): T[] {
  if (check === undefined) return [...items];
  const byScope = new Map<string, { decision: PolicyDecision; items: T[] }>();
  for (const item of items) {
    const scope = `${item.namespace}/${item.type}`;
    let entry = byScope.get(scope);
    if (entry === undefined) {
      entry = { decision: check(item.namespace, item.type), items: [] };
      byScope.set(scope, entry);
    }
    entry.items.push(item);
  }
  const kept = new Set<T>();
  for (const { decision, items: scoped } of byScope.values()) {
    if (!decision.allow) continue;
    const first = scoped[0] as T;
    const ctx: RequestContext = {
      ...(caller ?? anonymousCaller()),
      namespace: first.namespace,
      operation: 'query',
      entry: first.type
    };
    const admitted = new Set(
      applyObligations(
        decision,
        scoped.map((i) => i.row),
        ctx
      )
    );
    const filtered = hasRowFilters(decision);
    for (const item of scoped) {
      if (admitted.has(item.row) && !(filtered && STAND_INS.has(item.row))) kept.add(item);
    }
  }
  return items.filter((i) => kept.has(i));
}

/**
 * `visibleRows` for refs that carry no body. Refs in a row-scoped scope are
 * judged on the body stored with their embedding under `model`; one with no
 * such embedding, or with no `model`, is dropped.
 */
export async function visibleRefs<T extends SalienceTarget>(
  refs: readonly T[],
  check: BoundReadCheck | undefined,
  caller: CallerContext | undefined,
  store: EmbeddingsStore,
  model: string | undefined
): Promise<T[]> {
  if (check === undefined) return [...refs];
  const decisions = new Map<string, PolicyDecision>();
  const decide = (r: T): PolicyDecision => {
    const scope = `${r.namespace}/${r.type}`;
    let d = decisions.get(scope);
    if (d === undefined) {
      d = check(r.namespace, r.type);
      decisions.set(scope, d);
    }
    return d;
  };
  const scoped = refs.filter((r) => {
    const d = decide(r);
    return d.allow && hasRowFilters(d);
  });
  const admitted = new Set<string>();
  if (scoped.length > 0 && model !== undefined) {
    const fetched = await store.fetchEmbeddings(scoped, model);
    for (const f of visibleRows(fetched, check, caller)) {
      admitted.add(`${f.namespace}/${f.type}/${f.id}`);
    }
  }
  return refs.filter((r) => {
    const d = decide(r);
    if (!d.allow) return false;
    return !hasRowFilters(d) || admitted.has(`${r.namespace}/${r.type}/${r.id}`);
  });
}

// Both pg stores clamp one search to 100 rows.
const STORE_MAX_K = 100;

/**
 * Collects up to `k` visible items from a ranked source. With no row filter
 * one fetch of `k` suffices; otherwise it refetches at 2k, 4k, ... up to 10k
 * (and never past the stores' 100-row clamp), stopping once k are visible or
 * the source runs dry.
 *
 * shortcut: when the cap is hit it returns fewer than k even if more visible
 * rows rank further down; push the predicate into the store query if callers
 * hit it.
 */
export async function fillVisible<T>(
  k: number,
  decision: PolicyDecision | undefined,
  fetch: (n: number) => Promise<T[]>,
  keep: (items: T[]) => T[]
): Promise<T[]> {
  if (decision === undefined || !hasRowFilters(decision)) return keep(await fetch(k));
  const cap = Math.max(k, Math.min(k * 10, STORE_MAX_K));
  for (let n = Math.min(k * 2, cap); ; n = Math.min(n * 2, cap)) {
    const raw = await fetch(n);
    const kept = keep(raw);
    if (kept.length >= k || raw.length < n || n === cap) return kept.slice(0, k);
  }
}
