/**
 * The `tables` layout's row codec, without pg: which part of a row goes to a
 * column, to `extra` or to `$raw`, and that decoding gives the written row back.
 */

import { ReservedField } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { decodeRow, encodeRow, RAW_KEY } from '../src/row-codec.js';
import type { TypedColumn, TypeTable } from '../src/type-table.js';

function tableOf(columns: TypedColumn[], pending: string[] = []): TypeTable {
  const byField = new Map(columns.map((c) => [c.field, c]));
  return {
    namespace: 'n',
    type: 'T',
    from: '"t__n__t"',
    jsonb: 'extra',
    scope: () => null,
    column: (field) => byField.get(field),
    columns: () => columns,
    pending,
    orphaned: columns.filter((c) => c.state === 'orphaned').map((c) => c.field)
  };
}

const col = (
  field: string,
  kind: TypedColumn['kind'],
  state: TypedColumn['state'] = 'column',
  vocab?: string[]
): TypedColumn => ({
  field,
  column: `f_${field}`,
  kind,
  state,
  ...(vocab === undefined ? {} : { vocab })
});

const TABLE = tableOf(
  [
    col('title', 'text'),
    col('status', 'enum', 'column', ['open', 'closed']),
    col('count', 'number'),
    col('due', 'date'),
    col('done', 'boolean'),
    col('owner', 'crossRef'),
    col('moving', 'text', 'promoting'),
    col('gone', 'text', 'orphaned')
  ],
  ['later']
);

/** What pg hands back for an encoded row: dates as `Date`, `$raw` inside `extra`. */
function stored(table: TypeTable, row: Record<string, unknown>): Record<string, unknown> {
  const { columns, extra, raw } = encodeRow(table, row);
  const record: Record<string, unknown> = {};
  for (const c of table.columns()) {
    const v = columns[c.column] ?? null;
    record[c.column] = c.kind === 'date' && typeof v === 'string' ? new Date(v) : v;
  }
  record.extra = Object.keys(raw).length === 0 ? extra : { ...extra, [RAW_KEY]: raw };
  return record;
}

const roundTrip = (row: Record<string, unknown>) => decodeRow(TABLE, stored(TABLE, row));

describe('row codec', () => {
  it("date '2026-10-26' round-trips exactly; column holds 2026-10-26T00:00:00Z", () => {
    const e = encodeRow(TABLE, { due: '2026-10-26' });
    expect(e.columns.f_due).toBe('2026-10-26T00:00:00.000Z');
    expect(e.raw).toEqual({ due: '2026-10-26' });
    expect(roundTrip({ due: '2026-10-26' })).toEqual({ due: '2026-10-26' });
  });

  it("'2026-10-26T10:00:00+02:00' round-trips; column 08:00Z", () => {
    const e = encodeRow(TABLE, { due: '2026-10-26T10:00:00+02:00' });
    expect(e.columns.f_due).toBe('2026-10-26T08:00:00.000Z');
    expect(roundTrip({ due: '2026-10-26T10:00:00+02:00' })).toEqual({
      due: '2026-10-26T10:00:00+02:00'
    });
  });

  it('nine fractional digits round-trip', () => {
    const due = '2026-10-26T10:00:00.123456789Z';
    expect(encodeRow(TABLE, { due }).columns.f_due).toBe('2026-10-26T10:00:00.123Z');
    expect(roundTrip({ due })).toEqual({ due });
  });

  it('canonical ISO date stores no $raw', () => {
    const due = '2026-10-26T10:00:00.000Z';
    const e = encodeRow(TABLE, { due });
    expect(e).toEqual({ columns: { f_due: due }, extra: {}, raw: {}, clear: [] });
    expect(roundTrip({ due })).toEqual({ due });
  });

  it("'5' in a number field → column null, raw '5', decodes '5'", () => {
    const e = encodeRow(TABLE, { count: '5' });
    expect(e.columns).toEqual({ f_count: null });
    expect(e.raw).toEqual({ count: '5' });
    expect(e.extra).toEqual({});
    expect(roundTrip({ count: '5' })).toEqual({ count: '5' });
  });

  it('other misfits keep the column out of reach and decode as written', () => {
    const e = encodeRow(TABLE, {
      status: 'archived',
      owner: 42,
      done: 'yes',
      due: 'not a date',
      title: { nested: true }
    });
    // An out-of-vocab enum value never reaches the column's CHECK.
    expect(e.columns).toEqual({
      f_status: null,
      f_owner: '42',
      f_done: null,
      f_due: null,
      f_title: null
    });
    expect(e.raw).toEqual({
      status: 'archived',
      owner: 42,
      done: 'yes',
      due: 'not a date',
      title: { nested: true }
    });
    expect(roundTrip({ status: 'archived', owner: 42 })).toEqual({ status: 'archived', owner: 42 });
  });

  it('a date pg cannot hold goes to $raw with the column null', () => {
    for (const due of ['0000-01-01T00:00:00.000Z', '+010000-01-01T00:00:00.000Z']) {
      const e = encodeRow(TABLE, { due });
      expect(e.columns.f_due, due).toBeNull();
      expect(e.raw, due).toEqual({ due });
    }
  });

  it('explicit null → clear, decodes absent', () => {
    const e = encodeRow(TABLE, { title: null, later: null, moving: null });
    expect(e.clear).toEqual(['title', 'later', 'moving']);
    expect(e.columns).toEqual({ f_title: null, f_moving: null });
    expect(e.extra).toEqual({});
    expect(roundTrip({ title: null, later: null, moving: null })).toEqual({});
  });

  it('undeclared key → extra', () => {
    const e = encodeRow(TABLE, { note: 'hi', blob: null, list: [1, 2] });
    expect(e).toEqual({
      columns: {},
      extra: { note: 'hi', blob: null, list: [1, 2] },
      raw: {},
      clear: []
    });
    expect(roundTrip({ note: 'hi', blob: null, list: [1, 2] })).toEqual({
      note: 'hi',
      blob: null,
      list: [1, 2]
    });
  });

  it('pending field → extra', () => {
    const e = encodeRow(TABLE, { later: 'soon' });
    expect(e).toEqual({ columns: {}, extra: { later: 'soon' }, raw: {}, clear: [] });
    expect(roundTrip({ later: 'soon' })).toEqual({ later: 'soon' });
  });

  it('promoting field: the extra key wins over the column when present; the column when absent', () => {
    expect(encodeRow(TABLE, { moving: 'm' })).toEqual({
      columns: { f_moving: 'm' },
      extra: {},
      raw: {},
      clear: []
    });
    const base = { ...stored(TABLE, {}), f_moving: 'old' };
    expect(decodeRow(TABLE, base)).toEqual({ moving: 'old' });
    expect(decodeRow(TABLE, { ...base, extra: { moving: 'new' } })).toEqual({ moving: 'new' });
  });

  it('orphaned column value decodes as an extra; an extra key of the same name wins', () => {
    const e = encodeRow(TABLE, { gone: 'x' });
    expect(e).toEqual({ columns: {}, extra: { gone: 'x' }, raw: {}, clear: [] });
    const base = { ...stored(TABLE, {}), f_gone: 'kept' };
    expect(decodeRow(TABLE, base)).toEqual({ gone: 'kept' });
    expect(decodeRow(TABLE, { ...base, extra: { gone: 'newer' } })).toEqual({ gone: 'newer' });
  });

  it('a stray extra key never shadows a column-state field', () => {
    const record = { ...stored(TABLE, { title: 't' }), extra: { title: 'stale' } };
    expect(decodeRow(TABLE, record)).toEqual({ title: 't' });
  });

  it('no declared column key ever lands in extra', () => {
    const rand = mulberry32(0x5eed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const values: readonly unknown[] = [
      null,
      'open',
      'closed',
      'text',
      '',
      '5',
      0,
      -0,
      1.5,
      42,
      true,
      false,
      '2026-10-26',
      '2026-10-26T10:00:00.000Z',
      '2026-10-26T10:00:00+02:00',
      'not a date',
      [1, 'a'],
      { a: 1 }
    ];
    const keys = [...TABLE.columns().map((c) => c.field), 'later', 'note', 'blob'];
    const held = new Set(
      TABLE.columns()
        .filter((c) => c.state !== 'orphaned')
        .map((c) => c.field)
    );
    for (let i = 0; i < 2000; i++) {
      const row: Record<string, unknown> = {};
      for (const k of keys) if (rand() < 0.5) row[k] = pick(values);
      const e = encodeRow(TABLE, row);
      for (const k of Object.keys(e.extra)) expect(held.has(k), `${k} in ${i}`).toBe(false);
      for (const k of Object.keys(e.raw)) expect(held.has(k), `$raw ${k} in ${i}`).toBe(true);
      // An explicit null on a declared column field reads back absent; the rest exactly.
      const expected = Object.fromEntries(
        Object.entries(row).filter(([k, v]) => !(v === null && (held.has(k) || k === 'later')))
      );
      expect(roundTrip(row), `row ${i}`).toEqual(expected);
    }
  });

  it('$raw input refused', () => {
    expect(() => encodeRow(TABLE, { [RAW_KEY]: {} })).toThrow(ReservedField);
    expect(() => encodeRow(TABLE, { [RAW_KEY]: {} })).toThrow(`'${RAW_KEY}'`);
  });
});

/** A seeded PRNG, so the property test sees the same rows every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
