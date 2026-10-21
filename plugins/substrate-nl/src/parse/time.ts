/** A half-open range of instants, ISO-8601 with the asking offset. */
export interface DateRange {
  gte: string;
  lt: string;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * The range a time phrase names, relative to `asOf` and in its offset:
 * today, yesterday, this/last week (weeks start Monday), this/last month,
 * rolling "past <unit>" and "last N <units>", "since <weekday>". Null when
 * the phrase is not a time phrase.
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
  return null;
}
