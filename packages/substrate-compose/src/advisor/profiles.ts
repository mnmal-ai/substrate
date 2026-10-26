/**
 * Sizing profiles: how sensitive the index advisor is. A profile only tunes
 * when a recommendation is written; nothing is ever built without approval.
 */

export type StoreProfileName = 'personal' | 'growth' | 'scale';

export interface ProfileThresholds {
  /** A read shape whose p95 reaches this is slow. */
  slowP95Ms: number;
  /** Live rows a type needs before an `add` is recommended. */
  minRows: number;
  /** The same, for a type declaring `expectedSize: 'large'`. */
  minRowsLargeHint: number;
  /** How long an index's scan count must stay unchanged before `remove`. */
  unusedWindowMs: number;
  /** Writes per minute a type needs before one of its unused indexes is worth removing. */
  minWriteRatePerMin: number;
  /** Reads of a shape, in one drain window, before it can open an `add`: one slow outlier is not evidence. */
  minReads: number;
}

const DAY = 24 * 60 * 60 * 1000;

export const PROFILES: Record<StoreProfileName, ProfileThresholds> = {
  personal: {
    slowP95Ms: 250,
    minRows: 100_000,
    minRowsLargeHint: 10_000,
    unusedWindowMs: 7 * DAY,
    minWriteRatePerMin: 100,
    minReads: 50
  },
  growth: {
    slowP95Ms: 100,
    minRows: 50_000,
    minRowsLargeHint: 5_000,
    unusedWindowMs: 3 * DAY,
    minWriteRatePerMin: 50,
    minReads: 30
  },
  scale: {
    slowP95Ms: 50,
    minRows: 20_000,
    minRowsLargeHint: 1_000,
    unusedWindowMs: DAY,
    minWriteRatePerMin: 20,
    minReads: 20
  }
};

export const isStoreProfileName = (v: unknown): v is StoreProfileName =>
  typeof v === 'string' && Object.hasOwn(PROFILES, v);
