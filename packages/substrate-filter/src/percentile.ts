/**
 * The `p` percentile (0 to 1) of `values`, null over none. By default the
 * value at position `p × (n − 1)` of the ascending values, interpolated
 * linearly between its neighbours, as a float64. With `nearest`, the value at
 * index `ceil(p × n) − 1` (at least 0), returned unchanged. Both match
 * Postgres's percentile_cont and percentile_disc.
 */
export function percentileOf<T extends number | bigint>(
  values: readonly T[],
  p: number,
  nearest: boolean
): T | number | null {
  const n = values.length;
  if (n === 0) return null;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (nearest) return sorted[Math.max(0, Math.ceil(p * n) - 1)] as T;
  const h = p * (n - 1);
  const lo = Math.floor(h);
  const low = Number(sorted[lo]);
  return low + (h - lo) * (Number(sorted[Math.ceil(h)]) - low);
}
