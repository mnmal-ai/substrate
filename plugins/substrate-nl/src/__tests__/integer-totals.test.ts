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
  operators: OPERATORS
});
const rulings: NamespaceRulings = { timeField: { Invoice: 'sentAt' } };
const parse = (q: string) =>
  parseQuestion(q, pack, { asOf: '2026-10-30T12:00:00Z', rulings }).candidates[0];
const params = (q: string) => Object.values(parse(q)?.frame ?? {})[0]?.params;

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

  it('leaves the words unread when they name no date field', () => {
    const c = parse('how many invoices per month by status');
    expect(Object.values(c?.frame ?? {})[0]?.params.groupBy).toEqual({
      bucket: { dateTrunc: [{ lit: 'month' }, 'sentAt'] }
    });
    expect(c?.residual).toEqual(['status']);
  });
});
