/** A half-open range of instants, ISO-8601 with the asking offset. One bound may be open. */
export type DateRange =
  | { gte: string; lt: string }
  | { gte: string; lt?: never }
  | { gte?: never; lt: string };

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** An ISO-8601 date-time with an offset: the only accepted `asOf`. */
const AS_OF = /^(\d{4})-(\d{2})-(\d{2})T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;
/** A year from 1000 to 9998, so every window's end is still a four-digit year. */
const YEAR = /^(?!9999)[1-9]\d{3}$/;

/** True when `asOf` is an ISO-8601 date-time with an offset naming a real instant in a `YEAR`. */
export function validAsOf(asOf: unknown): asOf is string {
  if (typeof asOf !== 'string') return false;
  const m = AS_OF.exec(asOf);
  if (m === null || !YEAR.test(m[1] as string) || !Number.isFinite(Date.parse(asOf))) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDate() === d;
}

/**
 * The range a time phrase names, relative to `asOf` and in its offset:
 * today, yesterday, this/last week (weeks start Monday), this/last month,
 * this/last year (calendar years), rolling "past <unit>" and "last N <units>",
 * "since <weekday>", any of these after "during" or "during the" (as after the glue
 * words "in the"); and explicit dates (see `explicitRange`). Null when the phrase is
 * not a time phrase, or when a bound falls outside years 1000 to 9998.
 */
export function rangeFor(phrase: string, asOf: string): DateRange | null {
  const r = windowOf(phrase, asOf);
  return r !== null && supported(r.gte) && supported(r.lt) ? r : null;
}

/** True when a bound is a four-digit date from 1000-01-01 to 9999-01-01, the end of a `YEAR`. */
function supported(bound: string | undefined): boolean {
  const date = bound?.slice(0, 10);
  return (
    date === undefined || (/^\d{4}-/.test(date) && date >= '1000-01-01' && date <= '9999-01-01')
  );
}

/** The range `rangeFor` reads, before its bounds are checked. */
function windowOf(phrase: string, asOf: string): DateRange | null {
  const m = AS_OF.exec(asOf);
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
    case 'this year':
      return { gte: at(Date.UTC(Number(y), 0, 1)), lt: at(Date.UTC(Number(y) + 1, 0, 1)) };
    case 'last year':
      return { gte: at(Date.UTC(Number(y) - 1, 0, 1)), lt: at(Date.UTC(Number(y), 0, 1)) };
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
    // Too far back for a Date: no window, rather than a throw from `at`.
    if (Number.isNaN(back.getTime())) return null;
    return { gte: at(back.getTime()), lt: at(today + day) };
  }
  const since = /^since (\w+)$/.exec(phrase);
  const target = since === null ? -1 : WEEKDAYS.indexOf(since[1] as string);
  if (target >= 0) {
    const back = (weekday - target + 7) % 7;
    return { gte: at(today - back * day), lt: at(today + day) };
  }
  // A lead word before a named range ("since last week") opens it at one edge.
  const lead = /^(since|after|before|until|during the|during) (.+)$/.exec(phrase);
  const named = lead === null ? null : rangeFor(lead[2] as string, asOf);
  if (named?.gte !== undefined && named.lt !== undefined) {
    switch (lead?.[1]) {
      case 'since':
        return { gte: named.gte };
      case 'after':
        return { gte: named.lt };
      case 'before':
        return { lt: named.gte };
      case 'until':
        return { lt: named.lt };
      case 'during':
      case 'during the':
        return named;
    }
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
/** A day of the month, with an optional ordinal: "5", "5th". */
const DAY_OF_MONTH = /^(\d{1,2})(?:st|nd|rd|th)?$/;

/** A month name's number (full, three-letter, or "sept"), or 0. */
function monthNumber(w: string): number {
  return (
    MONTHS.findIndex((m) => w === m || (w.length === 3 && m.startsWith(w))) + 1 ||
    (w === 'sept' ? 9 : 0)
  );
}

/**
 * Where a time phrase `rangeFor` accepted names a whole year or month: the positions of
 * the words of each such operand, as "may" in "in may", "june", "august" and "2025" in
 * "between june and august 2025"; none in "on may 5 2025" (a day) or "last 2000 days".
 */
export function unitsAt(phrase: string): number[] {
  const words = phrase.split(' ');
  const head = words[0] ?? '';
  if (!['in', 'during', 'since', 'after', 'before', 'until', 'from', 'between'].includes(head))
    return [];
  const sep = head === 'from' ? 'to' : head === 'between' ? 'and' : undefined;
  const out: number[] = [];
  for (let start = 1, i = 1; i <= words.length; i++) {
    if (i < words.length && words[i] !== sep) continue;
    const operand = words.slice(start, i);
    if (operand.length <= 2 && operand.every((w) => YEAR.test(w) || monthNumber(w) > 0))
      for (let j = start; j < i; j++) out.push(j);
    start = i + 1;
  }
  return out;
}

/**
 * A date operand: the instant it starts at and the instant it ends at (the start of the
 * next day, month or year), or the same exact instant twice.
 */
interface Operand {
  start: string;
  end: string;
  /** Set for a whole year or month, the only operands "in" and "during" accept. */
  unit?: 'year' | 'month';
}

/**
 * Explicit dates, always after a lead word: "on D" (that day), "in Y" / "during Y"
 * (that year or month), "from D to D" and "between D and D" (inclusive of the last
 * day), "since D" / "after D" (from the start of D / from its end: the next day,
 * month or year), "before D" / "until D" (before D starts / through its end). A
 * year is 1000 to 9998 and covers its calendar year; a month name, alone or with a
 * year in either order, covers that month (alone, the most recent one that has
 * begun). In "between M and M Y" a yearless month takes the other operand's year,
 * or the year before when it comes later in the year ("between november and
 * february 2026"). A date is ISO `YYYY-MM-DD`, an ISO date-time (an exact instant),
 * or a month name (full, three-letter, or "sept") with a day, optional ordinal and
 * optional year, in either order. A month-day without a year is the most recent one
 * not after `today`. An invalid date is not a date.
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
      if (YEAR.test(w)) {
        return {
          start: at(Date.UTC(Number(w), 0, 1)),
          end: at(Date.UTC(Number(w) + 1, 0, 1)),
          unit: 'year'
        };
      }
      const mo = monthNumber(w);
      if (mo > 0) {
        const thisYear = new Date(today).getUTCFullYear();
        return monthOf(Date.UTC(thisYear, mo - 1, 1) > today ? thisYear - 1 : thisYear, mo);
      }
      const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(w);
      if (iso !== null) return dayOf(Number(iso[1]), Number(iso[2]), Number(iso[3]));
      const dt =
        /^(\d{4})-(\d{2})-(\d{2})t((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?)(z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.exec(
          w
        );
      if (dt === null || dayOf(Number(dt[1]), Number(dt[2]), Number(dt[3])) === null) return null;
      const instant = `${dt[1]}-${dt[2]}-${dt[3]}T${dt[4]}${dt[5] === undefined ? offset : dt[5].toUpperCase()}`;
      return { start: instant, end: instant };
    }
    if (words.length !== 2 && words.length !== 3) return null;
    const [a = '', b = '', year] = words;
    if (YEAR.test(b) && monthNumber(a) > 0 && year === undefined)
      return monthOf(Number(b), monthNumber(a));
    if (YEAR.test(a) && monthNumber(b) > 0 && year === undefined)
      return monthOf(Number(a), monthNumber(b));
    const dom = (w: string) => DAY_OF_MONTH.exec(w)?.[1];
    const [mo, d] = monthNumber(a) > 0 ? [monthNumber(a), dom(b)] : [monthNumber(b), dom(a)];
    if (mo === 0 || d === undefined) return null;
    if (year !== undefined) return YEAR.test(year) ? dayOf(Number(year), mo, Number(d)) : null;
    // Most recent such date not after today: this year, else an earlier one (Feb 29 may go back several).
    for (let y = new Date(today).getUTCFullYear(), n = 0; n < 8; y--, n++) {
      const t = Date.UTC(y, mo - 1, Number(d));
      if (t <= today && valid(y, mo, Number(d))) return { start: at(t), end: at(t + DAY_MS) };
    }
    return null;
  };
  const monthOf = (y: number, mo: number): Operand => ({
    start: at(Date.UTC(y, mo - 1, 1)),
    end: at(Date.UTC(y, mo, 1)),
    unit: 'month'
  });
  const valid = (y: number, mo: number, d: number) => {
    if (!YEAR.test(String(y))) return false;
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
  if (head === 'from' || head === 'between') {
    const sep = head === 'from' ? 'to' : 'and';
    const i = rest.indexOf(sep);
    if (i < 0) return null;
    const xw = rest.slice(0, i);
    const yw = rest.slice(i + 1);
    const yearOf = (ws: string[]) => (ws.length === 2 ? ws.find((w) => YEAR.test(w)) : undefined);
    const monthIn = (ws: string[]) => Math.max(...ws.map(monthNumber));
    const bare = (ws: string[]) => ws.length === 1 && monthNumber(ws[0] as string) > 0;
    const xYear = bare(xw) ? yearOf(yw) : undefined;
    const before = xYear !== undefined && monthIn(xw) > monthIn(yw) ? 1 : 0;
    const x = operand(xYear === undefined ? xw : [...xw, String(Number(xYear) - before)]);
    const y = operand(bare(yw) && yearOf(xw) ? [...yw, yearOf(xw) as string] : yw);
    if (x === null || y === null || Date.parse(y.end) <= Date.parse(x.start)) return null;
    return { gte: x.start, lt: y.end };
  }
  const o = operand(rest);
  if (o === null) return null;
  switch (head) {
    case 'on':
      return o.start === o.end || o.unit !== undefined ? null : { gte: o.start, lt: o.end };
    case 'in':
    case 'during':
      return o.unit === undefined ? null : { gte: o.start, lt: o.end };
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
