/**
 * Date fields compare as instants, as pg's timestamptz does: an offset or a
 * different number of fraction digits names the same instant.
 */

import type { FieldDef, Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { evaluateWhere } from '../src/index.js';

const row: Row = {
  id: 'r1',
  dueAt: '2026-10-20T09:30:00.000Z',
  label: '2026-10-20T09:30:00.000Z',
  _metadata: {
    createdAt: '2026-10-20T09:30:00.000Z',
    updatedAt: '2026-10-20T09:30:00.000Z',
    createdBy: null,
    updatedBy: null
  }
};
const dateDef: FieldDef = { kind: 'scalar', type: 'date' };
const fieldDefOf = (f: string): FieldDef | undefined => (f === 'dueAt' ? dateDef : undefined);

describe('evaluateWhere on date fields', () => {
  it('compares createdAt as an instant across offsets', () => {
    // 11:00+02:00 is 09:00Z, before the row's 09:30Z.
    expect(evaluateWhere(row, { createdAt: { gt: '2026-10-20T11:00:00+02:00' } })).toBe(true);
    expect(evaluateWhere(row, { createdAt: { lt: '2026-10-20T11:00:00+02:00' } })).toBe(false);
  });

  it('treats differently written forms of one instant as equal', () => {
    expect(evaluateWhere(row, { updatedAt: { eq: '2026-10-20T09:30:00Z' } })).toBe(true);
    expect(evaluateWhere(row, { updatedAt: { in: ['2026-10-20T11:30:00+02:00'] } })).toBe(true);
    expect(evaluateWhere(row, { updatedAt: { neq: '2026-10-20T09:30:00Z' } })).toBe(false);
  });

  it('keeps microseconds apart', () => {
    const r: Row = { id: 'r', dueAt: '2026-10-20T09:30:00.000001Z' };
    expect(evaluateWhere(r, { dueAt: { gt: '2026-10-20T09:30:00Z' } }, fieldDefOf)).toBe(true);
    expect(evaluateWhere(r, { dueAt: { eq: '2026-10-20T09:30:00Z' } }, fieldDefOf)).toBe(false);
  });

  it('compares a body field declared date as an instant', () => {
    expect(
      evaluateWhere(
        row,
        { dueAt: { between: ['2026-10-20T11:00:00+02:00', '2026-10-20T12:00:00+02:00'] } },
        fieldDefOf
      )
    ).toBe(true);
  });

  it('leaves a field not declared date comparing as text', () => {
    expect(evaluateWhere(row, { label: { gt: '2026-10-20T11:00:00+02:00' } }, fieldDefOf)).toBe(
      false
    );
  });
});
