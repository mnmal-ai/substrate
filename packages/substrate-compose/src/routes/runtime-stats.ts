/**
 * `GET /substrate/v1/metrics` — read the in-memory runtime-stats counter
 * (query/mutate throughput + latency, live subscription gauge, engine event
 * tallies): a pure data handler (`handleMetricsRequest`) plus an
 * `HttpHandler` factory (`metricsRouteHandler`) registered as a gated route.
 *
 * Counts reset on process restart — this is a process-local liveness surface,
 * not durable history.
 */

import type { RuntimeStats, RuntimeStatsSnapshot } from '@mnmal-ai/substrate-core';
import {
  grantedIn,
  grantOf,
  type HttpHandler,
  type SubstrateRequest
} from '@mnmal-ai/substrate-types';
import { jsonResponse } from './helpers.js';

/**
 * Pure handler. Per-key fields (`resolvers`, `slowest`, `subscriptions.entries`) name frame keys across
 * all namespaces, so for a caller they are filtered to what the caller's grant
 * lets it READ: `ns/Name` is visible iff the grant confers `read` in `ns`
 * (explicit entry, else `*`); an unqualified key is visible only on a `*` read.
 *
 * `identity` is `null` for a caller with no identity (an anonymous read): no
 * per-key entries, aggregates only. Omitting the argument (`undefined`) means
 * UNFILTERED and is for programmatic callers only; the route always passes
 * `req.identity ?? null`.
 */
export function handleMetricsRequest(
  stats: RuntimeStats,
  identity?: SubstrateRequest['identity'] | null
): RuntimeStatsSnapshot {
  const snap = stats.snapshot();
  if (identity === undefined) return snap;
  const grant = grantOf(identity);
  const visible = (key: string): boolean => {
    const slash = key.indexOf('/');
    if (slash <= 0) return grant?.['*']?.includes('read') === true;
    return grantedIn(grant, key.slice(0, slash)).includes('read');
  };
  const { resolvers, slowest, subscriptions, ...rest } = snap;
  return {
    ...rest,
    subscriptions:
      subscriptions.entries === undefined
        ? subscriptions
        : {
            ...subscriptions,
            entries: subscriptions.entries.filter((e) => visible(`${e.ns}/${e.type}`))
          },
    ...(resolvers !== undefined
      ? { resolvers: Object.fromEntries(Object.entries(resolvers).filter(([k]) => visible(k))) }
      : {}),
    ...(slowest !== undefined ? { slowest: slowest.filter((x) => visible(x.key)) } : {})
  };
}

/**
 * Route handler factory. Pass to `gate(metricsRouteHandler(stats), 'read')`
 * in compose.ts so it inherits the same auth treatment as /substrate/v1/query.
 */
export function metricsRouteHandler(stats: RuntimeStats): HttpHandler {
  return (req: SubstrateRequest) =>
    jsonResponse(200, handleMetricsRequest(stats, req.identity ?? null));
}
