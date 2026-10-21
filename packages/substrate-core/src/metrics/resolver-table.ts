import type { ResolveObservation, ResolverStat } from '@mnmal-ai/substrate-types';
import { LogHistogram } from './histogram.js';

interface Row {
  kind: 'query' | 'mutate';
  calls: number;
  errors: number;
  hist: LogHistogram;
  lastAt: Date;
}

const round = (ms: number) => Math.round(ms * 100) / 100;

/** Per-key stats, at most `cap` keys; a Map re-inserted on every hit is the LRU order. */
export class ResolverTable {
  readonly #rows = new Map<string, Row>();
  readonly #now: () => Date;
  readonly cap: number;

  constructor(cap = 512, now: () => Date = () => new Date()) {
    this.cap = cap;
    this.#now = now;
  }

  observe(o: ResolveObservation): void {
    let row = this.#rows.get(o.key);
    if (row === undefined) {
      if (this.#rows.size >= this.cap) {
        const oldest = this.#rows.keys().next().value;
        if (oldest !== undefined) this.#rows.delete(oldest);
      }
      row = { kind: o.kind, calls: 0, errors: 0, hist: new LogHistogram(), lastAt: this.#now() };
    } else {
      this.#rows.delete(o.key);
    }
    row.calls++;
    if (!o.ok) row.errors++;
    row.hist.observe(o.durationMs);
    row.lastAt = this.#now();
    this.#rows.set(o.key, row);
  }

  snapshot(): Record<string, ResolverStat> {
    const out: Record<string, ResolverStat> = {};
    for (const [key, r] of this.#rows) {
      out[key] = {
        kind: r.kind,
        calls: r.calls,
        errors: r.errors,
        p50Ms: round(r.hist.percentile(0.5)),
        p99Ms: round(r.hist.percentile(0.99)),
        maxMs: round(r.hist.max),
        lastAt: r.lastAt.toISOString()
      };
    }
    return out;
  }
}
