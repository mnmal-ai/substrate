/**
 * One accepted set of date strings: every value the write validator accepts
 * reads to the same instant in the memory evaluator and in pg's
 * `substrate_ts`, and every value it rejects is NULL in both. No offset is
 * UTC, a date alone is midnight UTC, fraction digits past 6 are truncated.
 *
 * pg reads under a non-UTC TimeZone and a non-ISO DateStyle, which must not
 * matter. The pg column is skipped when POSTGRES_URL isn't set.
 */

import { asSortValue, evaluateWhere } from '@mnmal-ai/substrate-filter';
import { type FieldDef, isIsoTimestamp } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

/** [input, the instant as UTC microseconds ISO, or null when rejected]. */
const CASES: Array<[string, string | null]> = [
  // Offsets.
  ['2026-10-24T10:00:00Z', '2026-10-24T10:00:00.000000Z'],
  ['2026-10-24T15:30:00+05:30', '2026-10-24T10:00:00.000000Z'],
  ['2026-10-24T15:30:00+0530', '2026-10-24T10:00:00.000000Z'],
  ['2026-10-24T15:00:00+05', '2026-10-24T10:00:00.000000Z'],
  ['2026-10-24T05:00:00-05:00', '2026-10-24T10:00:00.000000Z'],
  // No offset: UTC.
  ['2026-10-24T10:00:00', '2026-10-24T10:00:00.000000Z'],
  ['2026-10-24T10:00', '2026-10-24T10:00:00.000000Z'],
  ['2026-10-24 10:00', '2026-10-24T10:00:00.000000Z'],
  // Date only: midnight UTC, or midnight at its offset.
  ['2026-10-24', '2026-10-24T00:00:00.000000Z'],
  ['2026-10-24Z', '2026-10-24T00:00:00.000000Z'],
  ['2026-10-24+05', '2026-10-23T19:00:00.000000Z'],
  ['2024-02-29', '2024-02-29T00:00:00.000000Z'],
  ['0001-01-01', '0001-01-01T00:00:00.000000Z'],
  // Fraction digits: 3, 6, 7 and 9, truncated (never rounded) to 6.
  ['2026-10-24T10:00:00.123Z', '2026-10-24T10:00:00.123000Z'],
  ['2026-10-24T10:00:00.123456Z', '2026-10-24T10:00:00.123456Z'],
  ['2026-10-24T10:00:00.1234567Z', '2026-10-24T10:00:00.123456Z'],
  ['2026-10-24T10:00:00.123456789+01:00', '2026-10-24T09:00:00.123456Z'],
  ['2026-10-24T10:00:00.9999999', '2026-10-24T10:00:00.999999Z'],
  // Rejected: out of range or outside the grammar.
  ['2026-02-30', null],
  ['2026-02-30T00:00:00Z', null],
  ['2100-02-29', null],
  ['2026-13-01T00:00:00Z', null],
  ['0000-01-01T00:00:00Z', null],
  ['2026-10-24T24:00:00Z', null],
  ['2026-10-24T10:00:60Z', null],
  ['2026-10-24T10:00:00+16:00', null],
  ['2026-10-24T10:00:00.1234567890Z', null],
  ['2026-10-24T10Z', null],
  ['Oct 24 2026', null],
  ['2026-10-24T10:00:00 Z', null]
];

const def: FieldDef = { kind: 'scalar', type: 'date' };
const fieldDefOf = (f: string) => (f === 'at' ? def : undefined);

/** The memory evaluator's instant: the one operand `eq` matches, or null when nothing reads it. */
function memoryInstant(input: string, expected: string | null): string | null {
  const row = { id: 'r', at: input };
  if (asSortValue('at', input, fieldDefOf) === null) return null;
  const probe = expected ?? '1970-01-01T00:00:00.000000Z';
  return evaluateWhere(row, { at: { eq: probe } }, fieldDefOf) ? probe : `not ${probe}`;
}

describe('ISO timestamp parity: validator, memory and pg agree', () => {
  let sql: Sql | undefined;

  beforeAll(async () => {
    if (!POSTGRES_URL) return;
    sql = postgres(POSTGRES_URL, { onnotice: () => {} });
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  const pgInstant = async (db: Sql, input: string): Promise<string | null> =>
    db.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL TimeZone = 'America/Chicago'`);
      await tx.unsafe(`SET LOCAL DateStyle = 'SQL, DMY'`);
      const [r] = await tx`
        SELECT to_char(substrate_ts(${JSON.stringify(input)}::text::jsonb) AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS v`;
      return (r?.v ?? null) as string | null;
    });

  for (const [input, expected] of CASES) {
    it(`${input} -> ${expected ?? 'rejected'}`, async () => {
      expect(isIsoTimestamp(input)).toBe(expected !== null);
      expect(memoryInstant(input, expected)).toBe(expected);
      if (sql !== undefined) expect(await pgInstant(sql, input)).toBe(expected);
    });
  }
});
