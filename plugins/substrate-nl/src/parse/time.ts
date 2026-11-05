/** A half-open range of instants, ISO-8601 with the asking offset. One bound may be open. */
export type DateRange =
  | { gte: string; lt: string }
  | { gte: string; lt?: never }
  | { gte?: never; lt: string };

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * The range a time phrase names, relative to `asOf` and in its offset:
 * today, yesterday, this/last week (weeks start Monday), this/last month,
 * rolling "past <unit>" and "last N <units>", "since <weekday>"; and explicit
 * dates (see `explicitRange`). Null when the phrase is not a time phrase.
 */
export function rangeFor(phrase: string, asOf: string): DateRange | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.exec(asOf);
  if (m === null) throw new Error(`asOf must be ISO-8601 with an offset: ${asOf}`);
  const [, y, mo, d, offset] = m as unknown as [string, string, string, string, string];
  const today = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  const day = 86_400_000;
  const at = (utcMidnight: number) =>
    `${new Date(utcMidnight).toISOString().slice(0, 10)}T00:00:00${offset === 'Z' ? 'Z' : offset}`;
  const weekday = new Date(today).getUTCDay();
  const monday = today - ((weekday + 6) % 7) * day;
  const monthStart = Date.UTC(Number(y), Number(mo) - 1, 1);
  const nextMonth = Date.UTC(Number(y), Number(mo), 1);
  const lastMonth = Date.UTC(Number(y), Number(mo) - 2, 1);
  switch (phrase) {
    case 'today':
      return { gte: at(today), lt: at(today + day) };
    case 'yesterday':
      return { gte: at(today - day), lt: at(today) };
    case 'this week':
      return { gte: at(monday), lt: at(monday + 7 * day) };
    case 'last week':
      return { gte: at(monday - 7 * day), lt: at(monday) };
    case 'this month':
      return { gte: at(monthStart), lt: at(nextMonth) };
    case 'last month':
      return { gte: at(lastMonth), lt: at(monthStart) };
  }
  // Rolling windows end today: "past month" is a month back from today, unlike
  // the calendar "last month".
  const rolling = /^(?:past|last) (\d+ )?(day|week|month|year)s?$/.exec(phrase);
  if (rolling !== null && (rolling[1] !== undefined || phrase.startsWith('past'))) {
    const n = rolling[1] === undefined ? 1 : Number(rolling[1]);
    const unit = rolling[2] as string;
    const back = new Date(today);
    if (unit === 'day') back.setUTCDate(back.getUTCDate() - n);
    if (unit === 'week') back.setUTCDate(back.getUTCDate() - 7 * n);
    if (unit === 'month') back.setUTCMonth(back.getUTCMonth() - n);
    if (unit === 'year') back.setUTCFullYear(back.getUTCFullYear() - n);
    return { gte: at(back.getTime()), lt: at(today + day) };
  }
  const since = /^since (\w+)$/.exec(phrase);
  if (since !== null) {
    const target = WEEKDAYS.indexOf(since[1] as string);
    if (target < 0) return null;
    const back = (weekday - target + 7) % 7;
    return { gte: at(today - back * day), lt: at(today + day) };
  }
  return explicitRange(phrase, today, at, offset);
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december'
];
const DAY_MS = 86_400_000;

/** A date operand: the instant it starts at and the start of the following day, or the exact instant. */
interface Operand {
  start: string;
  end: string;
}

/**
 * Explicit dates: "on D" or a bare ISO date (that day), "from D to D" and
 * "between D and D" (inclusive of the last day), "since D" / "after D" (from
 * D / the day after), "before D" / "until D" (before D / through D). A date
 * is ISO `YYYY-MM-DD`, an ISO date-time (an exact instant), or a month name
 * (full or three-letter) with a day, optional ordinal and optional year, in
 * either order. A month-day without a year is the most recent one not after
 * `today`. An invalid date is not a date.
 */
function explicitRange(
  phrase: string,
  today: number,
  at: (utcMidnight: number) => string,
  offset: string
): DateRange | null {
  const operand = (words: string[]): Operand | null => {
    if (words.length === 1) {
      const w = words[0] as string;
      const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(w);
      if (iso !== null) return dayOf(Number(iso[1]), Number(iso[2]), Number(iso[3]));
      const dt =
        /^(\d{4})-(\d{2})-(\d{2})t(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(z|[+-]\d{2}:\d{2})?$/.exec(w);
      if (dt === null || dayOf(Number(dt[1]), Number(dt[2]), Number(dt[3])) === null) return null;
      const instant = `${dt[1]}-${dt[2]}-${dt[3]}T${dt[4]}${dt[5] === undefined ? offset : dt[5].toUpperCase()}`;
      return { start: instant, end: instant };
    }
    if (words.length !== 2 && words.length !== 3) return null;
    const [a = '', b = '', year] = words;
    const month = (w: string) =>
      MONTHS.findIndex((m) => w === m || (w.length === 3 && m.startsWith(w))) + 1;
    const dom = (w: string) => /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(w)?.[1];
    const [mo, d] = month(a) > 0 ? [month(a), dom(b)] : [month(b), dom(a)];
    if (mo === 0 || d === undefined) return null;
    if (year !== undefined) return /^\d{4}$/.test(year) ? dayOf(Number(year), mo, Number(d)) : null;
    // Most recent such date not after today: this year, else an earlier one (Feb 29 may go back several).
    for (let y = new Date(today).getUTCFullYear(), n = 0; n < 8; y--, n++) {
      const t = Date.UTC(y, mo - 1, Number(d));
      if (t <= today && valid(y, mo, Number(d))) return { start: at(t), end: at(t + DAY_MS) };
    }
    return null;
  };
  const valid = (y: number, mo: number, d: number) => {
    const t = new Date(Date.UTC(y, mo - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
  };
  const dayOf = (y: number, mo: number, d: number): Operand | null => {
    if (!valid(y, mo, d)) return null;
    const t = Date.UTC(y, mo - 1, d);
    return { start: at(t), end: at(t + DAY_MS) };
  };

  const words = phrase.split(' ');
  const [head = '', ...rest] = words;
  if (words.length === 1) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(head)) return null;
    const o = operand(words);
    return o === null ? null : { gte: o.start, lt: o.end };
  }
  if (head === 'from' || head === 'between') {
    const sep = head === 'from' ? 'to' : 'and';
    const i = rest.indexOf(sep);
    if (i < 0) return null;
    const x = operand(rest.slice(0, i));
    const y = operand(rest.slice(i + 1));
    if (x === null || y === null || Date.parse(y.end) <= Date.parse(x.start)) return null;
    return { gte: x.start, lt: y.end };
  }
  const o = operand(rest);
  if (o === null) return null;
  switch (head) {
    case 'on':
      return o.start === o.end ? null : { gte: o.start, lt: o.end };
    case 'since':
      return { gte: o.start };
    case 'after':
      return { gte: o.end };
    case 'before':
      return { lt: o.start };
    case 'until':
      return { lt: o.end };
  }
  return null;
}
