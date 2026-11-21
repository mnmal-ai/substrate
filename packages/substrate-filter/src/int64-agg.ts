/** Exact int64 aggregates over bigints, shared by grouped reads and walk aggregates. */
import { ResolverFrameError, VALUE_OUT_OF_RANGE } from '@mnmal-ai/substrate-types';

const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = 2n ** 63n - 1n;

/** The evaluator's int64 range error and its float overflow/underflow error: pg's 22003. */
const isRangeError = (err: unknown): err is Error =>
  (err instanceof RangeError && err.message === 'bigint out of range') ||
  (err instanceof Error && err.message.startsWith('value out of range: '));

export function outOfRange(err: unknown): never {
  if (isRangeError(err)) throw new ResolverFrameError(VALUE_OUT_OF_RANGE, err.message);
  throw err;
}

/**
 * avg, sum, min or max over `values` (all present), null over none. Sum, min
 * and max stay exact bigints and a sum past int64 raises the range error; avg
 * is float64(exact sum) / count.
 */
export function int64Agg(
  op: 'avg' | 'sum' | 'min' | 'max',
  values: readonly bigint[]
): bigint | number | null {
  if (values.length === 0) return null;
  if (op === 'min' || op === 'max') {
    return values.reduce((a, b) => ((op === 'min' ? b < a : b > a) ? b : a));
  }
  const sum = values.reduce((a, b) => a + b, 0n);
  if (op === 'avg') return Number(sum) / values.length;
  if (sum < MIN_INT64 || sum > MAX_INT64) outOfRange(new RangeError('bigint out of range'));
  return sum;
}
