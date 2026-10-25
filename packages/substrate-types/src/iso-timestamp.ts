/**
 * The one ISO 8601 date and date-time grammar a `date` field accepts. The
 * write validator, the memory evaluator and pg's `substrate_ts` (0003, which
 * carries the same pattern as SQL) all read it to the same instant.
 *
 * Groups: date, `HH:MM`, seconds, the first 6 fraction digits (pg keeps
 * microseconds; more digits are truncated), the offset. Anchored and free of
 * nested quantifiers, so no backtracking blow-up. pg caps an offset at ±15:59.
 */
const ISO_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})(?:[T ]((?:[01]\d|2[0-3]):[0-5]\d)(?::([0-5]\d)(?:\.(\d{1,6})\d{0,3})?)?)?(Z|[+-](?:0\d|1[0-5])(?::?[0-5]\d)?)?$/;

/**
 * `v` as `YYYY-MM-DDTHH:MM:SS[.ffffff](Z|±HH:MM)`, or `undefined` when it is
 * outside the grammar or names a day that does not exist (Feb 30, year 0000).
 * No offset is read as UTC, and a date alone as its midnight UTC.
 */
export function normalizeIsoTimestamp(v: string): string | undefined {
  const m = ISO_TIMESTAMP.exec(v);
  if (m === null) return undefined;
  const [, date = '', hm, sec, frac, offset] = m;
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return undefined;
  // setUTCFullYear, not Date.UTC, which maps years 0-99 onto 1900-1999.
  const probe = new Date(0);
  probe.setUTCFullYear(y, mo - 1, d);
  if (probe.getUTCDate() !== d) return undefined;
  const zone =
    offset === undefined || offset === 'Z'
      ? 'Z'
      : `${offset.slice(0, 3)}:${offset.slice(3).replace(':', '') || '00'}`;
  return `${date}T${hm ?? '00:00'}:${sec ?? '00'}${frac === undefined ? '' : `.${frac}`}${zone}`;
}

/** Is `v` a timestamp every dataset reads to the same instant? */
export function isIsoTimestamp(v: string): boolean {
  return normalizeIsoTimestamp(v) !== undefined;
}
