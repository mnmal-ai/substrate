import { describe, expect, it } from 'vitest';
import { parseQuestion } from '../parse/parse.js';
import { rangeFor, validAsOf } from '../parse/time.js';
import { ctx, pack } from './_fixture.js';

const asOf = '2026-10-02T12:00:00-05:00';
const day = (d: string) => `${d}T00:00:00-05:00`;
const params = (q: string) =>
  Object.values(parseQuestion(q, pack, ctx).candidates[0]?.frame ?? {})[0]?.params;

describe('explicit dates', () => {
  it('reads "on <date>" as that whole day', () => {
    const whole = { gte: day('2026-09-15'), lt: day('2026-09-16') };
    for (const p of [
      'on 2026-09-15',
      'on sep 15',
      'on september 15th',
      'on sep 15 2026',
      'on 15 sep 2026',
      'on 15th september'
    ])
      expect(rangeFor(p, asOf), p).toEqual(whole);
  });

  it('infers a missing year as the most recent such date not after asOf', () => {
    expect(rangeFor('on oct 2', asOf)).toEqual({ gte: day('2026-10-02'), lt: day('2026-10-03') });
    expect(rangeFor('on oct 3', asOf)).toEqual({ gte: day('2025-10-03'), lt: day('2025-10-04') });
    expect(rangeFor('on dec 31', '2026-01-03T09:00:00Z')).toEqual({
      gte: '2025-12-31T00:00:00Z',
      lt: '2026-01-01T00:00:00Z'
    });
  });

  it('reads from/between as inclusive of the last day', () => {
    const r = { gte: day('2026-09-01'), lt: day('2026-09-16') };
    expect(rangeFor('from 2026-09-01 to 2026-09-15', asOf)).toEqual(r);
    expect(rangeFor('between sep 1 and sep 15', asOf)).toEqual(r);
    expect(rangeFor('from 1st sep 2026 to 15th sep 2026', asOf)).toEqual(r);
    // A reversed range is not a range.
    expect(rangeFor('from 2026-09-15 to 2026-09-01', asOf)).toBeNull();
  });

  it('reads since/after/before/until as open-ended', () => {
    expect(rangeFor('since 2026-09-01', asOf)).toEqual({ gte: day('2026-09-01') });
    expect(rangeFor('after 2026-09-01', asOf)).toEqual({ gte: day('2026-09-02') });
    expect(rangeFor('before 2026-09-01', asOf)).toEqual({ lt: day('2026-09-01') });
    expect(rangeFor('until 2026-09-01', asOf)).toEqual({ lt: day('2026-09-02') });
  });

  it('uses an ISO date-time operand as the exact instant, in the asking offset when it has none', () => {
    expect(rangeFor('since 2026-09-01t08:30:00z', asOf)).toEqual({ gte: '2026-09-01T08:30:00Z' });
    expect(rangeFor('from 2026-09-01t08:30:00+01:00 to 2026-09-02', asOf)).toEqual({
      gte: '2026-09-01T08:30:00+01:00',
      lt: day('2026-09-03')
    });
    expect(rangeFor('before 2026-09-01t08:30', asOf)).toEqual({ lt: '2026-09-01T08:30-05:00' });
  });

  it('needs a lead word before an ISO date, as before a month-day', () => {
    expect(rangeFor('2026-09-15', asOf)).toBeNull();
    const r = parseQuestion('todos with title 2026-09-01', pack, ctx);
    expect(JSON.stringify(r.candidates[0]?.frame)).not.toContain('createdAt');
    expect(r.candidates[0]?.evidence.some((e) => e.role === 'time')).toBe(false);
  });

  it('reads "sept" as September', () => {
    expect(rangeFor('on sept 15', asOf)).toEqual({ gte: day('2026-09-15'), lt: day('2026-09-16') });
  });

  it('does not parse an invalid time of day', () => {
    for (const p of [
      'before 2026-09-01t99:99',
      'since 2026-09-01t25:00z',
      'since 2026-09-01t10:60',
      'since 2026-09-01t10:00:60',
      'since 2026-09-01t10:00+25:00',
      'from 2026-09-01t99:99 to 2026-09-02'
    ])
      expect(rangeFor(p, asOf), p).toBeNull();
    expect(rangeFor('since 2026-09-01t23:59:59.5+05:30', asOf)).toEqual({
      gte: '2026-09-01T23:59:59.5+05:30'
    });
  });

  it('does not parse an invalid date', () => {
    expect(rangeFor('on 2026-02-30', asOf)).toBeNull();
    expect(rangeFor('on feb 30', asOf)).toBeNull();
    expect(rangeFor('2026-13-01', asOf)).toBeNull();
    const r = parseQuestion('todos on 2026-02-30', pack, ctx);
    expect(r.candidates[0]?.evidence.some((e) => e.role === 'time')).toBe(false);
    expect(r.status).toBe('partial');
  });
});

describe('explicit dates in a question', () => {
  it('windows the time field and names the range in evidence', () => {
    const r = parseQuestion('todos created on sep 15', pack, ctx);
    expect(JSON.stringify(r.candidates[0]?.frame)).toContain(
      `{"createdAt":{"gte":"${day('2026-09-15')}","lt":"${day('2026-09-16')}"}}`
    );
    expect(r.candidates[0]?.evidence).toContainEqual({
      span: 'on sep 15',
      role: 'time',
      detail: `${day('2026-09-15')} .. ${day('2026-09-16')}`
    });
    expect(r.status).toBe('resolved');
  });

  it('keeps an open-ended range open, and reads a date-time as written', () => {
    const r = parseQuestion('todos since 2026-09-01T08:30:00Z', pack, ctx);
    expect(JSON.stringify(r.candidates[0]?.frame)).toContain(
      '{"createdAt":{"gte":"2026-09-01T08:30:00Z"}}'
    );
    expect(r.candidates[0]?.evidence).toContainEqual({
      span: 'since 2026-09-01t08:30:00z',
      role: 'time',
      detail: '2026-09-01T08:30:00Z ..'
    });
    expect(r.status).toBe('resolved');
  });

  it('reads a long range in a question', () => {
    expect(JSON.stringify(params('todos between oct 1 2025 and 2026-09-30'))).toContain(
      `{"createdAt":{"gte":"${day('2025-10-01')}","lt":"${day('2026-10-01')}"}}`
    );
  });

  it('leaves relative phrases as they were', () => {
    expect(JSON.stringify(params('todos yesterday'))).toContain(
      `{"createdAt":{"gte":"${day('2026-10-01')}","lt":"${day('2026-10-02')}"}}`
    );
    expect(rangeFor('since monday', asOf)).toEqual({
      gte: day('2026-09-28'),
      lt: day('2026-10-03')
    });
  });

  it('reads since/after/before/until a named range as open-ended at its edges', () => {
    // asOf is Friday 2026-10-02; last week is Mon 09-21 .. Mon 09-28.
    expect(rangeFor('since last week', asOf)).toEqual({ gte: day('2026-09-21') });
    expect(rangeFor('after last week', asOf)).toEqual({ gte: day('2026-09-28') });
    expect(rangeFor('before last week', asOf)).toEqual({ lt: day('2026-09-21') });
    expect(rangeFor('until yesterday', asOf)).toEqual({ lt: day('2026-10-02') });
    expect(rangeFor('since last month', asOf)).toEqual({ gte: day('2026-09-01') });
    expect(rangeFor('since open', asOf)).toBeNull();
  });

  it('claims "since last week" whole, so no word of it is dropped', () => {
    expect(JSON.stringify(params('how many decisions since last week')?.where)).toContain(
      JSON.stringify({ createdAt: { gte: day('2026-09-21') } })
    );
    expect(parseQuestion('how many decisions since last week', pack, ctx).status).toBe('resolved');
  });
});

describe('years and months as windows', () => {
  const est = '2026-11-19T10:00:00-05:00';
  const z = '2026-11-19T10:00:00Z';
  const e = (d: string) => `${d}T00:00:00-05:00`;
  const zz = (d: string) => `${d}T00:00:00Z`;

  it('reads a year as a window', () => {
    for (const p of ['in 2025', 'during 2025'])
      expect(rangeFor(p, est), p).toEqual({ gte: e('2025-01-01'), lt: e('2026-01-01') });
    expect(rangeFor('since 2024', est)).toEqual({ gte: e('2024-01-01') });
    expect(rangeFor('after 2024', est)).toEqual({ gte: e('2025-01-01') });
    expect(rangeFor('before 2025', est)).toEqual({ lt: e('2025-01-01') });
    expect(rangeFor('until 2025', est)).toEqual({ lt: e('2026-01-01') });
    for (const p of ['between 2024 and 2025', 'from 2024 to 2025'])
      expect(rangeFor(p, est), p).toEqual({ gte: e('2024-01-01'), lt: e('2026-01-01') });
  });

  it('reads this year and last year as calendar years', () => {
    expect(rangeFor('this year', z)).toEqual({ gte: zz('2026-01-01'), lt: zz('2027-01-01') });
    expect(rangeFor('last year', z)).toEqual({ gte: zz('2025-01-01'), lt: zz('2026-01-01') });
    expect(rangeFor('this year', '2026-01-01T00:30:00+05:30')?.gte).toBe(
      '2026-01-01T00:00:00+05:30'
    );
    expect(rangeFor('last 2 years', z)).toEqual({ gte: zz('2024-11-19'), lt: zz('2026-11-20') });
  });

  it('reads a month as a window', () => {
    expect(rangeFor('in october', z)).toEqual({ gte: zz('2026-10-01'), lt: zz('2026-11-01') });
    expect(rangeFor('in december', z)).toEqual({ gte: zz('2025-12-01'), lt: zz('2026-01-01') });
    expect(rangeFor('in november', z)).toEqual({ gte: zz('2026-11-01'), lt: zz('2026-12-01') });
    for (const p of ['in october 2025', 'in oct 2025', 'in 2025 october'])
      expect(rangeFor(p, z), p).toEqual({ gte: zz('2025-10-01'), lt: zz('2025-11-01') });
    expect(rangeFor('since october', z)).toEqual({ gte: zz('2026-10-01') });
    expect(rangeFor('before march 2025', z)).toEqual({ lt: zz('2025-03-01') });
    expect(rangeFor('until march 2025', z)).toEqual({ lt: zz('2025-04-01') });
    expect(rangeFor('between june and august 2025', z)).toEqual({
      gte: zz('2025-06-01'),
      lt: zz('2025-09-01')
    });
  });

  it('still rejects what is not a date', () => {
    for (const p of ['in 99', 'in 20255', 'in 0050', 'in octember', 'during'])
      expect(rangeFor(p, z), p).toBeNull();
    for (const p of ['on 2025', 'on october', 'on october 2025'])
      expect(rangeFor(p, z), p).toBeNull();
  });

  it('reads a four-digit number as a year only from 1900 to 2199', () => {
    for (const p of [
      'in 9999',
      'until 9999',
      'after 9999',
      'in december 9999',
      'on dec 31 9999',
      'on 9999-12-31',
      'in 9998',
      'in 1899',
      'in 2200',
      'in 3000',
      'since 1000',
      'between 1000 and 2000',
      'from 1000 to 2000',
      'between 2024 and 2200',
      'in may 1850',
      'in 1850 may',
      'between june and august 1850',
      'on may 5 1850'
    ])
      expect(rangeFor(p, z), p).toBeNull();
    expect(rangeFor('in 1900', z)).toEqual({ gte: zz('1900-01-01'), lt: zz('1901-01-01') });
    expect(rangeFor('in 2199', z)).toEqual({ gte: zz('2199-01-01'), lt: zz('2200-01-01') });
    expect(rangeFor('on may 5 1900', z)).toEqual({ gte: zz('1900-05-05'), lt: zz('1900-05-06') });
  });

  it('rejects any window with a bound outside years 1000 to 9998', () => {
    const late = '9999-12-15T10:00:00Z';
    expect(rangeFor('this year', late)).toBeNull();
    expect(rangeFor('in december', late)).toBeNull();
    expect(rangeFor('last 10000 years', z)).toBeNull();
    expect(rangeFor('last 1000 years', z)).toEqual({ gte: zz('1026-11-19'), lt: zz('2026-11-20') });
  });

  it('reads a rolling window too long for a date as no window, without throwing', () => {
    for (const p of ['last 200000000 days', 'last 99999999999999999999 years'])
      expect(rangeFor(p, z), p).toBeNull();
    const r = parseQuestion('todos in the last 200000000 days', pack, { ...ctx, asOf: z });
    expect(r.candidates[0]?.evidence.some((e) => e.role === 'time')).toBe(false);
    expect(r.status).toBe('partial');
  });

  it('accepts an asOf only in years 1000 to 9998', () => {
    for (const a of ['0050-03-01T00:00:00Z', '0999-12-31T23:00:00Z', '9999-01-01T00:00:00Z'])
      expect(validAsOf(a), a).toBe(false);
    for (const a of ['1000-01-01T00:00:00Z', '9998-12-31T23:00:00-05:00'])
      expect(validAsOf(a), a).toBe(true);
  });

  it('reads "in <month>" on the first of that month as the month just begun', () => {
    expect(rangeFor('in november', '2026-11-01T00:00:00Z')).toEqual({
      gte: zz('2026-11-01'),
      lt: zz('2026-12-01')
    });
    const ist = '2026-01-01T00:30:00+05:30';
    expect(rangeFor('in january', ist)).toEqual({
      gte: '2026-01-01T00:00:00+05:30',
      lt: '2026-02-01T00:00:00+05:30'
    });
    expect(rangeFor('in december', ist)).toEqual({
      gte: '2025-12-01T00:00:00+05:30',
      lt: '2026-01-01T00:00:00+05:30'
    });
  });

  it('reads a month range across a new year from the later month year', () => {
    const winter = { gte: zz('2025-11-01'), lt: zz('2026-03-01') };
    expect(rangeFor('between november and february 2026', z)).toEqual(winter);
    expect(rangeFor('between november 2025 and february 2026', z)).toEqual(winter);
    expect(rangeFor('between august and june 2025', z)).toEqual({
      gte: zz('2024-08-01'),
      lt: zz('2025-07-01')
    });
    // Reversed with both years given, or with neither, is not a range.
    for (const p of ['between november 2026 and february 2026', 'between october and december'])
      expect(rangeFor(p, z), p).toBeNull();
  });

  it('reads "during" a named range as "in" it', () => {
    expect(rangeFor('during this year', z)).toEqual(rangeFor('this year', z));
    expect(rangeFor('during last year', z)).toEqual(rangeFor('last year', z));
    for (const q of [
      'todos during this year',
      'todos during last year',
      'todos in last year',
      'todos during the last year',
      'todos in the last year',
      'todos during the past week'
    ]) {
      const r = parseQuestion(q, pack, { ...ctx, asOf: z });
      expect(r.status, q).toBe('resolved');
      expect(r.residual, q).toEqual([]);
    }
    expect(JSON.stringify(params('todos during last year')?.where)).toContain(
      JSON.stringify({ createdAt: { gte: day('2025-01-01'), lt: day('2026-01-01') } })
    );
  });
});
