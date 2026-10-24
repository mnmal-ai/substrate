/**
 * A date-declared field matches only values pg's `substrate_ts` reads as an
 * instant: ISO date and time with an explicit offset or `Z`, on a real day.
 * Anything else is a non-match, so memory and pg agree.
 */

import type { FieldDef, Row, WhereClause } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { evaluateWhere } from '../src/index.js';

const asDate = (field: string): FieldDef | undefined =>
  field === 'at' ? { kind: 'scalar', type: 'date' } : undefined;
const matches = (at: unknown, where: WhereClause): boolean =>
  evaluateWhere({ id: '1', at }, where, asDate);
const gte = { at: { gte: '2026-01-01T00:00:00Z' } };

describe('evaluateWhere — date shape', () => {
  it('matches offset and Z forms, including a space separator and a bare-hour offset', () => {
    expect(matches('2026-10-24T10:00:00Z', gte)).toBe(true);
    expect(matches('2026-10-24 10:00:00.123456+05:30', gte)).toBe(true);
    expect(matches('2026-10-24T10:00+05', gte)).toBe(true);
    expect(matches('2026-10-24T10:00:00+05', { at: { eq: '2026-10-24T05:00:00Z' } })).toBe(true);
  });

  it('never matches an offset-less, date-only or impossible value', () => {
    for (const at of ['2026-10-24 10:00', '2026-10-24', '2026-02-30T10:00:00Z', 'soon']) {
      expect(matches(at, gte), at).toBe(false);
      expect(matches(at, { at: { lt: '2027-01-01T00:00:00Z' } }), at).toBe(false);
      expect(matches(at, { at: { eq: at } }), at).toBe(false);
      expect(matches(at, { NOT: gte }), at).toBe(true);
    }
  });

  it('reads operands leniently, as pg casts them', () => {
    expect(matches('2026-10-25T10:00:00Z', { at: { gt: '2026-10-24' } })).toBe(true);
    expect(matches('2026-10-25T10:00:00Z', { at: { lt: '2026-10-24 10:00' } })).toBe(false);
    const row = {
      id: '1',
      _metadata: {
        createdAt: '2026-10-25T10:00:00.000Z',
        updatedAt: '2026-10-25T10:00:00.000Z',
        createdBy: { kind: 'agent', id: 'a' },
        updatedBy: { kind: 'agent', id: 'a' }
      }
    } as Row;
    expect(evaluateWhere(row, { createdAt: { gt: '2026-10-24' } })).toBe(true);
  });

  it('reads operands leniently, as pg casts them', () => {
    expect(matches('2026-10-25T10:00:00Z', { at: { gt: '2026-10-24' } })).toBe(true);
    expect(matches('2026-10-25T10:00:00Z', { at: { lt: '2026-10-24 10:00' } })).toBe(false);
    const row = {
      id: '1',
      _metadata: {
        createdAt: '2026-10-25T10:00:00.000Z',
        updatedAt: '2026-10-25T10:00:00.000Z',
        createdBy: { kind: 'agent', id: 'a' },
        updatedBy: { kind: 'agent', id: 'a' }
      }
    } as Row;
    expect(evaluateWhere(row, { createdAt: { gt: '2026-10-24' } })).toBe(true);
  });

  it('a number operand never matches a non-number value', () => {
    expect(evaluateWhere({ id: '1', n: 'abc' }, { n: { gt: 1 } })).toBe(false);
    expect(evaluateWhere({ id: '1', n: 'abc' }, { n: { lt: 1 } })).toBe(false);
  });
});
