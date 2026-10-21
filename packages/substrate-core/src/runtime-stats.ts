/**
 * Process-local runtime-metrics counter for the GET /substrate/v1/metrics surface.
 * The server records requests, the engine MetricFn records events, and the
 * route reads `snapshot()`. Counts reset on restart by design.
 */

import type {
  ProcessStat,
  ResolveObservation,
  ResolverStat,
  RuntimeErrorEntry,
  RuntimeErrors,
  RuntimeOp,
  SlowRequest
} from '@mnmal-ai/substrate-types';
import type { SubscriptionEntryStat, SubscriptionStatsSnapshot } from './engine/internals.js';
import { LogHistogram } from './metrics/histogram.js';
import { ResolverTable } from './metrics/resolver-table.js';

export interface OpStat {
  /** Requests seen for this op. */
  readonly total: number;
  /** Transport-level successes (HTTP status < 400). */
  readonly ok: number;
  /** Transport-level failures (HTTP status >= 400). */
  readonly error: number;
  /** Summed request duration; consumer derives mean = durationMsSum / total. */
  readonly durationMsSum: number;
  /** Largest single request duration observed. */
  readonly durationMsMax: number;
}

export interface RuntimeStatsSnapshot {
  /** Wall-clock ISO timestamp when the counter was initialised. */
  readonly since: string;
  readonly requests: { readonly query: OpStat; readonly mutate: OpStat };
  /** Live gauge, read through the activeSubscriptions callback at snapshot time. */
  readonly subscriptions: {
    readonly active: number;
    /** Present when the subscriptionStats dep is wired and doesn't throw. */
    readonly maxQueueDepth?: number;
    /** Present when the subscriptionStats dep is wired and doesn't throw. */
    readonly entries?: readonly SubscriptionEntryStat[];
  };
  /** Engine MetricFn tallies, keyed by event name. Bounded by emission sites in code. */
  readonly events: Readonly<Record<string, number>>;
  /** Per-key latency/error stats, capped at 512 keys (LRU). */
  readonly resolvers?: Readonly<Record<string, ResolverStat>>;
  /** Present only when the processStats dep is wired and doesn't throw. */
  readonly process?: ProcessStat;
  /** The last ten resolves at or above the running p99, newest first. */
  readonly slowest?: readonly SlowRequest[];
}

export interface RuntimeStats {
  recordRequest(op: RuntimeOp, ok: boolean, durationMs: number): void;
  recordEvent(name: string): void;
  recordResolve(o: ResolveObservation): void;
  /** Newest-first ring of the last 50 failed resolves; messages truncated, no stacks. */
  errors(): RuntimeErrors;
  snapshot(): RuntimeStatsSnapshot;
}

export interface RuntimeStatsDeps {
  /** Defaults to () => new Date(); injectable for tests. */
  now?: () => Date;
  /** Live subscription count source. Guarded in snapshot() — throws default to 0. */
  activeSubscriptions: () => number;
  /**
   * Optional: per-entry queue-depth snapshot. When present and non-throwing,
   * `snapshot().subscriptions` adds `maxQueueDepth` and `entries`; otherwise
   * it carries only `active`.
   */
  subscriptionStats?: () => SubscriptionStatsSnapshot;
  /** Optional process sampler (supplied by the host; substrate-core stays runtime-agnostic). */
  processStats?: () => ProcessStat;
}

/** Mutable backing for OpStat — snapshot() spreads it into the readonly public type. */
interface MutableOpStat {
  total: number;
  ok: number;
  error: number;
  durationMsSum: number;
  durationMsMax: number;
}

function freshOp(): MutableOpStat {
  return { total: 0, ok: 0, error: 0, durationMsSum: 0, durationMsMax: 0 };
}

export function createRuntimeStats(deps: RuntimeStatsDeps): RuntimeStats {
  const now = deps.now ?? (() => new Date());
  const since = now().toISOString();
  const ops: Record<RuntimeOp, MutableOpStat> = { query: freshOp(), mutate: freshOp() };
  const events = new Map<string, number>();
  const resolvers = new ResolverTable(512, now);
  const slowest: SlowRequest[] = []; // newest first, max 10
  let allHist = new LogHistogram();
  let seen = 0;
  const errorRing: RuntimeErrorEntry[] = []; // newest first, max 50

  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
  const scrub = (v: string): string => v.replace(CONTROL, '').slice(0, 200);
  const clean = (m: string | undefined): string => scrub((m ?? '').split('\n')[0] ?? '');
  const UNKNOWN = '(unknown)';
  const round = (ms: number): number => Math.round(ms * 100) / 100;

  return {
    recordRequest(op: RuntimeOp, ok: boolean, durationMs: number): void {
      const s = ops[op];
      s.total++;
      if (ok) s.ok++;
      else s.error++;
      s.durationMsSum += durationMs;
      if (durationMs > s.durationMsMax) s.durationMsMax = durationMs;
    },
    recordEvent(name: string): void {
      events.set(name, (events.get(name) ?? 0) + 1);
    },
    recordResolve(raw: ResolveObservation): void {
      const o = { ...raw, key: scrub(raw.key) };
      resolvers.observe(o);
      const at = now().toISOString();
      // Last 10 observations at or above the running global p99; everything is
      // eligible until 100 have been seen.
      // The threshold is the p99 bucket's lower bound, and the reference
      // histogram restarts every 10,000 observations so it tracks current load.
      const eligible = seen < 100 || o.durationMs >= allHist.percentileLowerBound(0.99);
      allHist.observe(o.durationMs);
      if (++seen % 10_000 === 0) allHist = new LogHistogram();
      if (eligible && o.key !== UNKNOWN) {
        slowest.unshift({ key: o.key, kind: o.kind, durationMs: round(o.durationMs), at });
        slowest.length = Math.min(slowest.length, 10);
      }
      if (!o.ok) {
        const code = scrub(o.code ?? 'error');
        const caller = o.caller === undefined ? 'anonymous' : scrub(o.caller);
        const newest = errorRing[0];
        if (
          o.key === UNKNOWN &&
          newest?.key === UNKNOWN &&
          newest.code === code &&
          newest.caller === caller
        ) {
          newest.count = (newest.count ?? 1) + 1;
          newest.at = at;
          newest.message = clean(o.message);
          return;
        }
        errorRing.unshift({
          at,
          op: o.kind,
          key: o.key,
          code,
          message: clean(o.message),
          caller
        });
        errorRing.length = Math.min(errorRing.length, 50);
      }
    },
    errors(): RuntimeErrors {
      return { since, errors: errorRing.map((e) => ({ ...e })) };
    },
    snapshot(): RuntimeStatsSnapshot {
      let active = 0;
      try {
        active = deps.activeSubscriptions();
      } catch {
        active = 0;
      }

      let subscriptions: RuntimeStatsSnapshot['subscriptions'] = { active };
      if (deps.subscriptionStats !== undefined) {
        try {
          const ss = deps.subscriptionStats();
          subscriptions = { active, maxQueueDepth: ss.maxQueueDepth, entries: ss.entries };
        } catch {
          // dep threw — fall back to the `active`-only shape
        }
      }

      let process: ProcessStat | undefined;
      if (deps.processStats !== undefined) {
        try {
          process = deps.processStats();
        } catch {
          // sampler threw — omit the field
        }
      }

      return {
        since,
        requests: { query: { ...ops.query }, mutate: { ...ops.mutate } },
        subscriptions,
        events: Object.fromEntries(events),
        resolvers: resolvers.snapshot(),
        slowest: slowest.map((s) => ({ ...s })),
        ...(process !== undefined ? { process } : {})
      };
    }
  };
}
