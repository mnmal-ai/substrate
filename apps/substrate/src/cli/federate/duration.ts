/**
 * `--ttl` parsing for `substrate federate enroll`.
 *
 * The 30-day ceiling matches MAX_TTL_MS in the `_system` invites route, so a
 * CLI-minted invite can never outlive what the HTTP route would allow.
 */

export const MAX_TTL_MS = 30 * 86_400_000;

const DURATION = /^(\d+)(s|m|h|d)$/;

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000
};

export function parseDuration(raw: string): number {
  const match = DURATION.exec(raw.trim());
  if (match === null) {
    throw new Error(`invalid duration '${raw}' — expected a value like 30s, 15m, 24h, 7d`);
  }
  // The regex has two capture groups, both matched when exec returns non-null.
  const count = Number(match[1]);
  const unitMs = UNIT_MS[match[2] as string] as number;
  const ms = count * unitMs;
  if (ms <= 0) {
    throw new Error(`invalid duration '${raw}' — must be greater than zero`);
  }
  if (ms > MAX_TTL_MS) {
    throw new Error(`invalid duration '${raw}' — must not exceed 30 days`);
  }
  return ms;
}
