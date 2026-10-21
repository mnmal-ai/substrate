/**
 * Returns a copy of `value` with object keys sorted recursively, so
 * `JSON.stringify(canonicalize(x))` is stable regardless of insertion order.
 * Arrays keep their element order; primitives (incl. `null`) pass through.
 */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  const sorted: Record<string, unknown> = {};
  for (const [k, v] of entries) sorted[k] = canonicalize(v);
  return sorted;
}
