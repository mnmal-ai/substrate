/** Per-key resolver latency and error counts, as served by GET /substrate/v1/metrics. */
export interface ResolverStat {
  kind: 'query' | 'mutate';
  calls: number;
  errors: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  lastAt: string;
}

export interface ProcessStat {
  rssMB: number;
  heapUsedMB: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  eventLoopLagP99Ms: number;
  inFlight: number;
}

export interface SlowRequest {
  key: string;
  kind: 'query' | 'mutate';
  durationMs: number;
  at: string;
}

export interface RuntimeErrorEntry {
  at: string;
  op: 'query' | 'mutate';
  key: string;
  code: string;
  message: string;
  /** The verified identity's id, or `'anonymous'`. */
  caller?: string;
  /** Present when consecutive identical `(unknown)` failures were merged into this entry. */
  count?: number;
}

export interface RuntimeErrors {
  since: string;
  errors: RuntimeErrorEntry[];
}

export interface ResolveObservation {
  key: string;
  kind: 'query' | 'mutate';
  durationMs: number;
  ok: boolean;
  code?: string;
  message?: string;
  /** The verified identity's id; absent for an anonymous caller. */
  caller?: string;
}

/**
 * One type's table and index statistics, for the index advisor. Counters are
 * cumulative since the server's statistics were last reset. Row counts are
 * estimates. A type ABSENT from a `typeStats()` result is unknown, not empty:
 * never read its absence as 0 rows (a sampled store can miss a small type).
 */
export interface TypeStats {
  namespace: string;
  type: string;
  liveRows: number;
  insertsTotal: number;
  /** Rows inserted, updated and deleted: the write volume behind `statsSince`. */
  writesTotal: number;
  /** When the database's statistics were last reset (ISO), or null when never: the counters' origin. */
  statsSince: string | null;
  indexes: Array<{
    name: string;
    scans: number;
    /** The last scan (ISO), or null when none since `statsSince`. */
    lastScanAt: string | null;
    sizeBytes: number;
    unique: boolean;
    /** Built or adopted by the engine's index reconciler for this type. */
    engineOwned: boolean;
  }>;
}

/** What GET /substrate/v1/metrics returns. The new fields are optional so an older server still type-checks. */
export interface RuntimeMetrics {
  since: string;
  requests: {
    query: {
      total: number;
      ok: number;
      error: number;
      durationMsSum: number;
      durationMsMax: number;
    };
    mutate: {
      total: number;
      ok: number;
      error: number;
      durationMsSum: number;
      durationMsMax: number;
    };
  };
  subscriptions: {
    active: number;
    maxQueueDepth?: number;
    entries?: { id: string; ns: string; type: string; queueLength: number }[];
  };
  events: Record<string, number>;
  resolvers?: Record<string, ResolverStat>;
  process?: ProcessStat;
  slowest?: SlowRequest[];
}
