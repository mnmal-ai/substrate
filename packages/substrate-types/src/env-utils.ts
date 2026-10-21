/**
 * Pure env-string parsing helpers shared by plugins and deployment helpers
 * (e.g. `substrate-sentinel-client`) without a substrate-sdk runtime dep.
 */

/**
 * Strict positive-integer env parsing. Returns `fallback` when `raw` is
 * undefined (env var unset). Throws with `envVar` in the message when `raw`
 * is set but not a positive integer — never falls back on invalid input, so
 * a config typo fails at boot.
 */
export function parsePositiveInt(
  raw: string | undefined,
  envVar: string,
  fallback: number
): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${envVar} must be a positive integer (got '${raw}')`);
  }
  return n;
}
