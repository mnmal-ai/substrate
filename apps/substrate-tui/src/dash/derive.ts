import type { ResolverStat, RuntimeErrors, RuntimeMetrics } from '@mnmal-ai/substrate/sdk';

/** Polls kept per sparkline. */
export const HISTORY = 30;
/** Metrics samples closer together than this add no history point: the baseline holds until a
 *  later sample spans a meaningful interval (an `r` right after a tick would spike the rate). */
export const MIN_RATE_INTERVAL_MS = 1000;
/** Per-key p99 histories kept, most recently seen first. */
export const MAX_KEYS = 50;
/** The engine event counted as a policy denial. */
export const DENIAL_EVENT = 'engine_policy_denied';

/** Why a source has nothing to show: 401, 403, 404, or anything else. */
export type Why = 'auth' | 'admin' | 'absent' | 'down';
export type Src<T> = { ok: true; value: T } | { ok: false; why: Why };

export interface Health {
  version?: string;
  uptimeSeconds?: number;
}
/** The fields of GET /substrate/v1/embed-stats the panel reads. */
export interface EmbedStats {
  enabled?: boolean;
  writes?: number;
  failures?: number;
  expansionFailures?: number;
}
/** One poll: each source either answered or says why not. */
export interface Sample {
  health: Src<Health>;
  metrics: Src<RuntimeMetrics>;
  embed: Src<EmbedStats>;
  errors: Src<RuntimeErrors>;
  /**
   * Monotonic ms (performance.now) when the metrics source answered. Rates divide by the gap
   * between these, never by when the slowest sibling source settled. Absent: `step`'s `now`.
   */
  metricsAt?: number;
}

export type SortBy = 'p99' | 'calls' | 'errors';
export const SORTS: readonly SortBy[] = ['p99', 'calls', 'errors'];

export interface Totals {
  /** When these totals were read, for the per-second rate. */
  at: number;
  query: number;
  mutate: number;
  queryErr: number;
  mutateErr: number;
  events: Readonly<Record<string, number>>;
  /** Per-key cumulative error counts. */
  keyErrors: Readonly<Record<string, number>>;
}

export interface DashHist {
  /** Requests per second. */
  queryRate: number[];
  mutateRate: number[];
  /** Errors per poll. */
  queryErr: number[];
  mutateErr: number[];
  /** Policy denials per poll. */
  denials: number[];
  /** key -> p99 ms per poll; insertion order is most recently seen first. */
  p99: ReadonlyMap<string, number[]>;
}

export interface DashState {
  /** null until the first poll answers. */
  health: Src<Health> | null;
  metrics: Src<RuntimeMetrics> | null;
  embed: Src<EmbedStats> | null;
  errors: Src<RuntimeErrors> | null;
  hist: DashHist;
  prevTotals?: Totals;
  /** Per-event change since the previous metrics poll. */
  eventDelta: Readonly<Record<string, number>>;
  /** Keys whose error count rose since the previous metrics poll. */
  keyErrRose: ReadonlySet<string>;
  sort: SortBy;
  lastAt?: number;
}

export function initialDash(sort: SortBy = 'p99'): DashState {
  return {
    health: null,
    metrics: null,
    embed: null,
    errors: null,
    hist: {
      queryRate: [],
      mutateRate: [],
      queryErr: [],
      mutateErr: [],
      denials: [],
      p99: new Map()
    },
    eventDelta: {},
    keyErrRose: new Set(),
    sort
  };
}

/** `hist` plus `v`, keeping the last HISTORY values. */
export function push(hist: readonly number[], v: number): number[] {
  const next = [...hist, v];
  return next.length > HISTORY ? next.slice(next.length - HISTORY) : next;
}

/** Growth of a counter; a counter that went down (a restart) clamps to 0. */
export function delta(prev: number | undefined, next: number): number {
  return prev === undefined ? 0 : Math.max(0, next - prev);
}

/** Latency bands: below 20 ms ok, below 100 ms warn, else error. */
export function latencyTone(ms: number): 'ok' | 'warn' | 'error' {
  return ms < 20 ? 'ok' : ms < 100 ? 'warn' : 'error';
}

/** Largest first by `by`, ties by key name. */
export function sortKeys(
  r: Readonly<Record<string, ResolverStat>>,
  by: SortBy
): [string, ResolverStat][] {
  const metric = (s: ResolverStat) =>
    by === 'p99' ? s.p99Ms : by === 'calls' ? s.calls : s.errors;
  return Object.entries(r).sort(
    ([ka, a], [kb, b]) => metric(b) - metric(a) || (ka < kb ? -1 : ka > kb ? 1 : 0)
  );
}

export function nextSort(by: SortBy): SortBy {
  return SORTS[(SORTS.indexOf(by) + 1) % SORTS.length] ?? 'p99';
}

/** Maps a failed fetch to why, from the HTTP status the error carries. */
export function classify(err: unknown): Why {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 401) return 'auth';
  if (status === 403) return 'admin';
  if (status === 404) return 'absent';
  return 'down';
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round2 = (v: number): number => Math.round(v * 100) / 100;

function totalsOf(m: RuntimeMetrics, at: number): Totals {
  // fromEntries defines own properties, so a server-sent '__proto__' key stays data.
  const events = Object.fromEntries(Object.entries(m.events ?? {}).map(([k, v]) => [k, num(v)]));
  return {
    at,
    query: num(m.requests?.query?.total),
    mutate: num(m.requests?.mutate?.total),
    queryErr: num(m.requests?.query?.error),
    mutateErr: num(m.requests?.mutate?.error),
    events,
    keyErrors: Object.fromEntries(
      Object.entries(m.resolvers ?? {}).map(([k, st]) => [k, num(st?.errors)])
    )
  };
}

function foldP99(
  prev: ReadonlyMap<string, number[]>,
  resolvers: Readonly<Record<string, ResolverStat>>
): Map<string, number[]> {
  // Keys in this sample come first, newest activity first; older keys keep their order behind them.
  const seen = Object.entries(resolvers).sort(
    ([ka, a], [kb, b]) =>
      (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0) || (ka < kb ? -1 : 1)
  );
  const next = new Map<string, number[]>();
  for (const [key, stat] of seen) {
    if (next.size >= MAX_KEYS) break;
    next.set(key, push(prev.get(key) ?? [], num(stat.p99Ms)));
  }
  for (const [key, hist] of prev) {
    if (next.size >= MAX_KEYS) break;
    if (!next.has(key)) next.set(key, hist);
  }
  return next;
}

/** Folds one poll into the state. Histories grow only once a previous metrics poll gives a baseline. */
export function step(prev: DashState, sample: Sample, now: number): DashState {
  const next: DashState = {
    ...prev,
    health: sample.health,
    metrics: sample.metrics,
    embed: sample.embed,
    errors: sample.errors,
    lastAt: now
  };
  if (!sample.metrics.ok) return next;
  const m = sample.metrics.value;
  const at = sample.metricsAt ?? now;
  const cur = totalsOf(m, at);
  const was = prev.prevTotals;
  if (was === undefined) {
    const p99 = foldP99(prev.hist.p99, m.resolvers ?? {});
    return { ...next, prevTotals: cur, eventDelta: {}, hist: { ...prev.hist, p99 } };
  }
  // Too soon (or the clock went backwards): show the fresh values, keep the baseline and histories.
  if (at - was.at < MIN_RATE_INTERVAL_MS) return next;
  const p99 = foldP99(prev.hist.p99, m.resolvers ?? {});
  const secs = (at - was.at) / 1000;
  const eventDelta: Record<string, number> = Object.fromEntries(
    Object.entries(cur.events).map(([k, v]) => [
      k,
      delta(Object.hasOwn(was.events, k) ? was.events[k] : 0, v)
    ])
  );
  const keyErrRose = new Set(
    Object.entries(cur.keyErrors)
      .filter(([k, v]) => delta(Object.hasOwn(was.keyErrors, k) ? was.keyErrors[k] : 0, v) > 0)
      .map(([k]) => k)
  );
  const h = prev.hist;
  return {
    ...next,
    prevTotals: cur,
    eventDelta,
    keyErrRose,
    hist: {
      queryRate: push(h.queryRate, round2(delta(was.query, cur.query) / secs)),
      mutateRate: push(h.mutateRate, round2(delta(was.mutate, cur.mutate) / secs)),
      queryErr: push(h.queryErr, delta(was.queryErr, cur.queryErr)),
      mutateErr: push(h.mutateErr, delta(was.mutateErr, cur.mutateErr)),
      denials: push(h.denials, eventDelta[DENIAL_EVENT] ?? 0),
      p99
    }
  };
}
