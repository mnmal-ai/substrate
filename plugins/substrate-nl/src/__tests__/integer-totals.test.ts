import type { Schema } from '@mnmal-ai/substrate/sdk';
import { describe, expect, it } from 'vitest';
import { buildNamespacePack } from '../pack/build.js';
import type { NamespaceRulings } from '../pack/rulings.js';
import { parseQuestion } from '../parse/parse.js';
import { OPERATORS } from './_fixture.js';

const scalar = (type: 'string' | 'date' | 'int32' | 'int64') => ({
  kind: 'scalar' as const,
  type,
  indexed: true
});
const types: Schema['types'] = {
  Invoice: {
    fields: {
      title: scalar('string'),
      amount: scalar('int64'),
      units: scalar('int32'),
      sentAt: scalar('date'),
      dueDate: scalar('date'),
      status: { ...scalar('string'), enum: ['draft', 'sent'] }
    }
  }
};
const pack = buildNamespacePack({
  namespace: 'shop',
  schema: { schemaVersion: 'v', mutations: {}, types },
  operators: {
    ...OPERATORS,
    'scalar.int64': ['eq', 'gt', 'in'],
    'scalar.int32': ['eq', 'gt', 'in']
  }
});
const rulings: NamespaceRulings = { timeField: { Invoice: 'sentAt' } };
const parse = (q: string) =>
  parseQuestion(q, pack, { asOf: '2026-10-30T12:00:00Z', rulings }).candidates[0];
const params = (q: string) => Object.values(parse(q)?.frame ?? {})[0]?.params;
/** `q` read against an Invoice whose fields are `title`, `amount`, `sentAt` and `fields`. */
const parseWith = (fields: Schema['types'][string]['fields'], q: string) => {
  const p = buildNamespacePack({
    namespace: 'shop',
    schema: {
      schemaVersion: 'v',
      mutations: {},
      types: {
        Invoice: {
          fields: {
            title: scalar('string'),
            amount: scalar('int64'),
            sentAt: scalar('date'),
            ...fields
          }
        }
      }
    },
    operators: OPERATORS
  });
  return parseQuestion(q, p, { asOf: '2026-10-30T12:00:00Z', rulings }).candidates[0];
};
const groupOf = (c: ReturnType<typeof parse>) =>
  Object.values(c?.frame ?? {})[0]?.params.groupBy as unknown;

describe('totals over integer fields', () => {
  it('sums an int64 field per month', () => {
    expect(params('total amount of invoices per month')).toEqual({
      aggregate: { value: { sum: 'amount' } },
      groupBy: { bucket: { dateTrunc: [{ lit: 'month' }, 'sentAt'] } }
    });
  });

  it('averages an int32 field', () => {
    expect(params('average units of invoices')?.aggregate).toEqual({ value: { avg: 'units' } });
  });

  it('still refuses a string field, with the existing reason', () => {
    expect(parse('total title of invoices')?.dropped.map((d) => d.reason)).toEqual([
      'total needs a number field; title is a string field'
    ]);
  });
});

describe('grouping by a named date field', () => {
  it('buckets a count on it', () => {
    const c = parse('how many invoices per month by due date');
    expect(Object.values(c?.frame ?? {})[0]?.params.groupBy).toEqual({
      bucket: { dateTrunc: [{ lit: 'month' }, 'dueDate'] }
    });
    expect(c?.evidence.map((e) => e.detail)).toContain('bucket dueDate by month');
    expect(c?.residual).toEqual([]);
  });

  it('buckets an aggregate on it, by a unique prefix of its name', () => {
    expect(params('total amount of invoices per month by due')?.groupBy).toEqual({
      bucket: { dateTrunc: [{ lit: 'month' }, 'dueDate'] }
    });
  });

  it('takes one generic date word after the field it names', () => {
    const due = parseWith({ dueAt: scalar('date') }, 'how many invoices per month by due date');
    expect(groupOf(due)).toEqual({ bucket: { dateTrunc: [{ lit: 'month' }, 'dueAt'] } });
    expect(due?.residual).toEqual([]);
    for (const word of ['time', 'day', 'timestamp']) {
      const c = parseWith({ dueAt: scalar('date') }, `how many invoices per month by due ${word}`);
      expect(groupOf(c), word).toEqual({ bucket: { dateTrunc: [{ lit: 'month' }, 'dueAt'] } });
      expect(c?.residual, word).toEqual([]);
    }
    const created = parse('how many invoices per month by created date');
    expect(groupOf(created)).toEqual({ bucket: { dateTrunc: [{ lit: 'month' }, 'createdAt'] } });
    expect(created?.residual).toEqual([]);
  });

  it('takes no date word when the words name no date field', () => {
    const c = parseWith({ dueCode: scalar('string') }, 'how many invoices per month by due date');
    expect(groupOf(c)).toEqual({ bucket: { dateTrunc: [{ lit: 'month' }, 'sentAt'] } });
    expect(c?.residual).toEqual(expect.arrayContaining(['due', 'date']));
  });

  it('leaves the words unread when they name no date field', () => {
    const c = parse('how many invoices per month by status');
    expect(Object.values(c?.frame ?? {})[0]?.params.groupBy).toEqual({
      bucket: { dateTrunc: [{ lit: 'month' }, 'sentAt'] }
    });
    expect(c?.residual).toEqual(['status']);
  });
});

describe('other readings of an integer field', () => {
  it('takes the max of one', () => {
    expect(params('max amount of invoices')?.aggregate).toEqual({ value: { max: 'amount' } });
  });

  it('orders by one', () => {
    expect(params('invoices with the highest amount')).toEqual({
      orderBy: [{ amount: 'desc' }],
      limit: 10
    });
  });

  it('keeps an int64 operand exact past 2^53', () => {
    const c = parse('invoices amount:>9007199254740993');
    expect(JSON.stringify(c?.frame)).toContain('"gt":"9007199254740993"');
    expect(c?.evidence.map((e) => e.detail).join()).toContain('"9007199254740993"');
  });

  it('keeps a safe int64 operand a number', () => {
    expect(JSON.stringify(parse('invoices amount:>500')?.frame)).toContain('"gt":500');
  });

  it("reads a dropped aggregate's date words as unread", () => {
    const c = parse('total zorb of invoices per month by due date');
    expect(c?.residual).toEqual(expect.arrayContaining(['due', 'date']));
    // The generic date word is released with the field's words.
    const at = parseWith({ dueAt: scalar('date') }, 'total zorb of invoices per month by due date');
    expect(at?.residual).toEqual(expect.arrayContaining(['due', 'date']));
  });
});
