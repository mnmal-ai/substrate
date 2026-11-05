import { describe, expect, it } from 'vitest';
import { parseQuestion } from '../parse/parse.js';
import { rangeFor } from '../parse/time.js';
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
});
