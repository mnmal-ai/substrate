/**
 * The `tables` layout's row codec, without pg: which part of a row goes to a
 * column, to `extra` or to `$raw`, and that decoding gives the written row back.
 */

import { ReservedField } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { applyPatch, decodeRow, type EncodedRow, encodeRow, RAW_KEY } from '../src/row-codec.js';
import type { TypedColumn, TypeTable } from '../src/type-table.js';

function tableOf(columns: TypedColumn[], pending: string[] = []): TypeTable {
  const byField = new Map(columns.map((c) => [c.field, c]));
  return {
    namespace: 'n',
    type: 'T',
    from: '"t__n__t"',
    jsonb: 'extra',
    column: (field) => byField.get(field),
    columns: () => columns,
    pending,
    orphaned: columns.filter((c) => c.state === 'orphaned').map((c) => c.field),
    version: '0'
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

/** A type-table row with every column NULL and an empty `extra`. */
const EMPTY: Record<string, unknown> = {
  ...Object.fromEntries(TABLE.columns().map((c) => [c.column, null])),
  extra: {}
};

/** `encoded` written over `record`, read back as pg hands it over: dates as `Date`. */
function write(record: Record<string, unknown>, encoded: EncodedRow): Record<string, unknown> {
  const next = applyPatch(record, encoded);
  for (const c of TABLE.columns()) {
    const v = next[c.column];
    if (c.kind === 'date' && typeof v === 'string') next[c.column] = new Date(v);
  }
  return next;
}

const stored = (row: Record<string, unknown>) => write(EMPTY, encodeRow(TABLE, row));
const roundTrip = (row: Record<string, unknown>) => decodeRow(TABLE, stored(row));

describe('row codec', () => {
  it("date '2026-10-26' round-trips exactly; column holds 2026-10-26T00:00:00Z", () => {
    const e = encodeRow(TABLE, { due: '2026-10-26' });
    expect(e.columns.f_due).toBe('2026-10-26T00:00:00Z');
    expect(e.raw).toEqual({ due: '2026-10-26' });
    expect(roundTrip({ due: '2026-10-26' })).toEqual({ due: '2026-10-26' });
  });

  it("'2026-10-26T10:00:00+02:00' round-trips; column 08:00Z", () => {
    const e = encodeRow(TABLE, { due: '2026-10-26T10:00:00+02:00' });
    expect(new Date(e.columns.f_due as string).toISOString()).toBe('2026-10-26T08:00:00.000Z');
    expect(roundTrip({ due: '2026-10-26T10:00:00+02:00' })).toEqual({
      due: '2026-10-26T10:00:00+02:00'
    });
  });

  it('nine fractional digits round-trip', () => {
    const due = '2026-10-26T10:00:00.123456789Z';
    // The column keeps microseconds, the precision memory and `substrate_ts` compare at.
    expect(encodeRow(TABLE, { due }).columns.f_due).toBe('2026-10-26T10:00:00.123456Z');
    expect(roundTrip({ due })).toEqual({ due });
  });

  it('dates follow the shared ISO grammar: no offset is UTC, loose or impossible text misfits', () => {
    expect(encodeRow(TABLE, { due: '2026-10-26T10:00:00' }).columns.f_due).toBe(
      '2026-10-26T10:00:00Z'
    );
    for (const due of ['2026-02-30', '1', 'March 7, 2026']) {
      const e = encodeRow(TABLE, { due });
      expect(e.columns.f_due, due).toBeNull();
      expect(e.raw, due).toEqual({ due });
    }
  });

  it('a year below 101 keeps its column and a $raw copy, even in canonical form', () => {
    for (const due of ['0099-06-01T00:00:00.000Z', '0100-01-01T00:00:00.000Z']) {
      const e = encodeRow(TABLE, { due });
      expect(e.columns.f_due, due).toBe(due);
      expect(e.raw, due).toEqual({ due });
    }
    expect(encodeRow(TABLE, { due: '0101-01-01T00:00:00.000Z' }).raw).toEqual({});
  });

  it('a JS Date is written as its JSON text: the column holds the instant, no $raw', () => {
    const due = new Date('2026-10-26T10:00:00.000Z');
    expect(encodeRow(TABLE, { due })).toEqual({
      columns: { f_due: '2026-10-26T10:00:00.000Z' },
      extra: {},
      raw: {},
      clear: [],
      unset: ['due']
    });
  });

  it('canonical ISO date stores no $raw', () => {
    const due = '2026-10-26T10:00:00.000Z';
    const e = encodeRow(TABLE, { due });
    expect(e).toEqual({ columns: { f_due: due }, extra: {}, raw: {}, clear: [], unset: ['due'] });
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
      clear: [],
      unset: ['note', 'blob', 'list']
    });
    expect(roundTrip({ note: 'hi', blob: null, list: [1, 2] })).toEqual({
      note: 'hi',
      blob: null,
      list: [1, 2]
    });
  });

  it('pending field → extra', () => {
    const e = encodeRow(TABLE, { later: 'soon' });
    expect(e).toEqual({
      columns: {},
      extra: { later: 'soon' },
      raw: {},
      clear: [],
      unset: ['later']
    });
    expect(roundTrip({ later: 'soon' })).toEqual({ later: 'soon' });
  });

  it('promoting field: the extra key wins over the column when present; the column when absent', () => {
    expect(encodeRow(TABLE, { moving: 'm' })).toEqual({
      columns: { f_moving: 'm' },
      extra: {},
      raw: {},
      clear: [],
      unset: ['moving']
    });
    const base = { ...EMPTY, f_moving: 'old' };
    expect(decodeRow(TABLE, base)).toEqual({ moving: 'old' });
    expect(decodeRow(TABLE, { ...base, extra: { moving: 'new' } })).toEqual({ moving: 'new' });
  });

  it('orphaned column value decodes as an extra; an extra key of the same name wins', () => {
    // A write goes to `extra` and clears the column, so no stale value outlives it.
    const e = encodeRow(TABLE, { gone: 'x' });
    expect(e).toEqual({
      columns: { f_gone: null },
      extra: { gone: 'x' },
      raw: {},
      clear: [],
      unset: ['gone']
    });
    const base = { ...EMPTY, f_gone: 'kept' };
    expect(decodeRow(TABLE, base)).toEqual({ gone: 'kept' });
    expect(decodeRow(TABLE, { ...base, extra: { gone: 'newer' } })).toEqual({ gone: 'newer' });
  });

  it('a stray extra key never shadows a column-state field', () => {
    const record = { ...stored({ title: 't' }), extra: { title: 'stale' } };
    expect(decodeRow(TABLE, record)).toEqual({ title: 't' });
  });

  it('a null in extra on a declared column field reads absent; on an undeclared one, null', () => {
    const record = {
      ...EMPTY,
      f_moving: 'old',
      f_gone: 'kept',
      extra: { later: null, moving: null, gone: null, note: null }
    };
    // `moving` is promoting: its extra key wins, and that key is a null, so absent.
    expect(decodeRow(TABLE, record)).toEqual({ gone: null, note: null });
  });

  it('an instant before year 1 UTC goes to $raw with the column null', () => {
    const due = '0001-01-01T00:30:00+01:00';
    const e = encodeRow(TABLE, { due });
    expect(e.columns.f_due).toBeNull();
    expect(e.raw).toEqual({ due });
    expect(encodeRow(TABLE, { due: '0001-01-01T00:30:00Z' }).columns.f_due).toBe(
      '0001-01-01T00:30:00Z'
    );
  });

  it('an unreadable column value is left to its $raw entry, and throws without one', () => {
    const record = { ...EMPTY, f_due: new Date(Number.NaN) };
    expect(decodeRow(TABLE, { ...record, extra: { [RAW_KEY]: { due: '0001-01-01' } } })).toEqual({
      due: '0001-01-01'
    });
    expect(() => decodeRow(TABLE, record)).toThrow(RangeError);
  });

  it('a non-finite number on a column field is refused', () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => encodeRow(TABLE, { count: v })).toThrow(RangeError);
      expect(() => encodeRow(TABLE, { title: v })).toThrow(RangeError);
    }
  });

  describe('a patch over a stored row', () => {
    const patch = (record: Record<string, unknown>, row: Record<string, unknown>) =>
      decodeRow(TABLE, write(record, encodeRow(TABLE, row)));

    it('a stale $raw is dropped when its field is written again', () => {
      const before = stored({ title: 't', count: '5' });
      expect(patch(before, { count: 7 })).toEqual({ title: 't', count: 7 });
      expect(patch(before, { count: null })).toEqual({ title: 't' });
      expect(write(before, encodeRow(TABLE, { count: 7 })).extra).toEqual({});
    });

    it('a promoting write strips the old extra key', () => {
      const before = { ...EMPTY, extra: { moving: 'old' } };
      const after = write(before, encodeRow(TABLE, { moving: 'new' }));
      expect(after.extra).toEqual({});
      expect(decodeRow(TABLE, after)).toEqual({ moving: 'new' });
    });

    it('a pending null removes the key', () => {
      const before = stored({ later: 'soon', note: 'n' });
      const after = write(before, encodeRow(TABLE, { later: null }));
      expect(after.extra).toEqual({ note: 'n' });
      expect(decodeRow(TABLE, after)).toEqual({ note: 'n' });
    });

    it("an orphaned field's column-era $raw is dropped when it is written as an extra", () => {
      const before = { ...EMPTY, f_gone: '42', extra: { [RAW_KEY]: { gone: 42, title: 5 } } };
      const after = write(before, encodeRow(TABLE, { gone: 'x' }));
      expect(after.extra).toEqual({ gone: 'x', [RAW_KEY]: { title: 5 } });
      expect(decodeRow(TABLE, after)).toEqual({ gone: 'x', title: 5 });
    });
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
      Number.MAX_SAFE_INTEGER,
      2 ** 60,
      1e300,
      Number.NaN,
      true,
      false,
      '2026-10-26',
      '2026-10-26T10:00:00.000Z',
      '2026-10-26T10:00:00.123456Z',
      '2026-10-26T10:00:00+02:00',
      '2026-10-26T10:00:00',
      '0099-06-01',
      '0050-01-01T00:00:00.000Z',
      '2026-02-30',
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
    const declared = (k: string) => held.has(k) || TABLE.pending.includes(k);
    for (let i = 0; i < 500; i++) {
      // A row's life: up to four patches, each over what the last one stored.
      let record = EMPTY;
      const model: Record<string, unknown> = {};
      for (let p = 0, n = 1 + Math.floor(rand() * 4); p < n; p++) {
        const row: Record<string, unknown> = {};
        for (const k of keys) if (rand() < 0.4) row[k] = pick(values);
        const nonFinite = Object.entries(row).some(
          ([k, v]) => held.has(k) && typeof v === 'number' && !Number.isFinite(v)
        );
        if (nonFinite) {
          expect(() => encodeRow(TABLE, row), `row ${i}.${p}`).toThrow(RangeError);
          continue;
        }
        const e = encodeRow(TABLE, row);
        for (const k of Object.keys(e.extra)) expect(held.has(k), `${k} in ${i}.${p}`).toBe(false);
        for (const k of Object.keys(e.raw))
          expect(held.has(k), `$raw ${k} in ${i}.${p}`).toBe(true);
        record = write(record, e);
        // An explicit null on a declared column field reads back absent; the rest as written.
        for (const [k, v] of Object.entries(row)) {
          if (v === null && declared(k)) delete model[k];
          else model[k] = v;
        }
        expect(decodeRow(TABLE, record), `row ${i}.${p}`).toEqual(model);
      }
    }
  });

  it('$raw input refused', () => {
    expect(() => encodeRow(TABLE, { [RAW_KEY]: {} })).toThrow(ReservedField);
    expect(() => encodeRow(TABLE, { [RAW_KEY]: {} })).toThrow(
      "field '$raw' is reserved and cannot be written by a create or an update"
    );
    // The existing callers' message is unchanged.
    expect(new ReservedField('_deletedAt').message).toBe(
      "field '_deletedAt' is reserved and cannot be written via updateField"
    );
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
