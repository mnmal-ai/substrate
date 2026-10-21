/**
 * `PgDatasetOptions.promotedColumns` — promoting a host's own hot field.
 *
 * There is no default map: a field is promoted only when the host declares
 * it. What these tests pin is that a declared entry reaches every path —
 * write-mirror, single-field materialization, predicate, ORDER BY and the
 * keyset cursor — while reads still return the body. Five paths; a change that wires four of them is the failure
 * mode worth catching, because the fifth degrades silently rather than
 * erroring.
 *
 * The column is created here the way a host's own migration would, since the
 * substrate deliberately does not manage this DDL.
 */

import type { Row } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, runMigrations } from '../src/index.js';
import type { PromotedBodyColumnMap } from '../src/pg-sql.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

/** Host-supplied map promoting one field of its own. */
const WITH_SEVERITY: PromotedBodyColumnMap = {
  severity: { column: 'severity', kind: 'text' }
};

describe.skipIf(!POSTGRES_URL)('PgDatasetOptions.promotedColumns', () => {
  let sql: Sql;
  let ds: PgDataset;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    await runMigrations(sql);
    // The host's migration. Column first, ALWAYS — reads route to the column
    // and only the column, so wiring the option against a column that does not
    // exist fails loudly and against one that is not backfilled fails silently.
    await sql`ALTER TABLE rows ADD COLUMN IF NOT EXISTS severity text`;
  });

  afterAll(async () => {
    await sql`ALTER TABLE rows DROP COLUMN IF EXISTS severity`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`TRUNCATE TABLE rows, short_ids`;
    ds = new PgDataset({
      namespace: 'promoted_opt',
      sql,
      promotedColumns: WITH_SEVERITY
    });
  });

  it('mirrors a custom promoted key from the body into its column on write', async () => {
    await ds.write('Alert', [{ id: 'a1', severity: 'high', note: 'x' }]);

    const [row] = await sql`SELECT severity, body ->> 'severity' AS body_val
                            FROM rows WHERE id = 'a1'`;
    // Both, not either: the column is what reads use, the body is what
    // materialization and projection return.
    expect(row?.severity).toBe('high');
    expect(row?.body_val).toBe('high');
  });

  it('mirrors a custom promoted key on a single-field update', async () => {
    await ds.write('Alert', [{ id: 'a2', severity: 'low' }]);
    await ds.updateField({ type: 'Alert', id: 'a2' }, 'severity', 'critical');

    const [row] = await sql`SELECT severity, body ->> 'severity' AS body_val
                            FROM rows WHERE id = 'a2'`;
    expect(row?.severity).toBe('critical');
    expect(row?.body_val).toBe('critical');
  });

  it('routes a filter on the custom key to the column', async () => {
    await ds.write('Alert', [
      { id: 'f1', severity: 'high' },
      { id: 'f2', severity: 'low' }
    ]);
    // Prove it is the COLUMN being read, not the body: blank the column on one
    // row and it must stop matching even though the body still says 'high'.
    await sql`UPDATE rows SET severity = NULL WHERE id = 'f1'`;

    const res = await ds.read('Alert', { where: { severity: { eq: 'high' } } });
    expect(res.rows.map((r) => r.id)).toEqual([]);
  });

  it('reads return the body, not the column', async () => {
    await ds.write('Alert', [
      { id: 'b1', severity: 'high' },
      { id: 'b2', note: 'no severity' }
    ]);
    await sql`UPDATE rows SET severity = 'low' WHERE id = 'b1'`;

    const res = await ds.read('Alert', { orderBy: [{ id: 'asc' }] });
    // The column disagrees with the body for b1; the read returns the body.
    // b2 never had the key and gains no phantom one.
    expect(res.rows.map(({ _metadata, ...row }) => row)).toEqual([
      { id: 'b1', severity: 'high' },
      { id: 'b2', note: 'no severity' }
    ]);
  });

  it('sorts and pages the custom key from the same expression', async () => {
    const rows: Row[] = [
      { id: 's1', severity: 'aaa' },
      { id: 's2', severity: 'bbb' },
      { id: 's3', severity: 'ccc' },
      { id: 's4', severity: 'ddd' }
    ];
    await ds.write('Alert', rows);
    await sql`UPDATE rows SET severity = NULL WHERE id IN ('s2','s3')`;

    const full = await ds.read('Alert', { orderBy: [{ severity: 'asc' }] });

    const paged: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await ds.read('Alert', {
        orderBy: [{ severity: 'asc' }],
        limit: 2,
        ...(cursor === undefined ? {} : { cursor })
      });
      paged.push(...res.rows.map((r) => String(r.id)));
      const next = (res as { nextCursor?: string | null }).nextCursor;
      if (next === undefined || next === null || res.rows.length === 0) break;
      cursor = next;
    }

    expect(paged).toEqual(full.rows.map((r) => String(r.id)));
    expect(paged).toHaveLength(4);
  });

  it('leaves a field out of the column path when the map omits it', async () => {
    // The control for every case above: with no map, `severity` is an
    // ordinary body key, so the same write must not touch the column. Without
    // this, a bug that promoted everything would pass the whole suite.
    const plain = new PgDataset({ namespace: 'promoted_opt', sql });
    await plain.write('Alert', [{ id: 'p1', severity: 'high' }]);

    const [row] = await sql`SELECT severity, body ->> 'severity' AS body_val
                            FROM rows WHERE id = 'p1'`;
    expect(row?.severity).toBeNull();
    expect(row?.body_val).toBe('high');
    // And it still filters, via body extraction.
    const res = await plain.read('Alert', { where: { severity: { eq: 'high' } } });
    expect(res.rows.map((r) => r.id)).toEqual(['p1']);
  });

  it('carries the map into tx-bound clones', async () => {
    // A clone that reverted to the default map would silently stop mirroring
    // mid-transaction — the column and body would disagree for exactly the
    // writes that matter most.
    await ds.withTransaction(async (tx) => {
      await tx.write('Alert', [{ id: 't1', severity: 'high' }]);
    });

    const [row] = await sql`SELECT severity FROM rows WHERE id = 't1'`;
    expect(row?.severity).toBe('high');
  });
});

describe('promotedColumns validation', () => {
  // No database needed: the refusal happens in the constructor, before any SQL.
  const sqlStub = (() => undefined) as unknown as Sql;

  it('refuses a qualified column name, naming the bare form', () => {
    expect(
      () =>
        new PgDataset({
          namespace: 'v',
          sql: sqlStub,
          promotedColumns: { severity: { column: 'r.severity', kind: 'text' } }
        })
    ).toThrow(/not a bare identifier/);
  });

  it('refuses an injection-shaped column name', () => {
    // The reason the validation exists. `column` is interpolated as a SQL
    // identifier via `sql.unsafe`, which is only sound while the value comes
    // from a closed map — and making the map an option is precisely what opens
    // it.
    expect(
      () =>
        new PgDataset({
          namespace: 'v',
          sql: sqlStub,
          promotedColumns: {
            severity: { column: 'severity; DROP TABLE rows--', kind: 'text' }
          }
        })
    ).toThrow(/not a bare identifier/);
  });

  it('names the offending field so a large map is debuggable', () => {
    expect(
      () =>
        new PgDataset({
          namespace: 'v',
          sql: sqlStub,
          promotedColumns: {
            good: { column: 'good', kind: 'text' },
            bad: { column: 'Bad-Name', kind: 'text' }
          }
        })
    ).toThrow(/promotedColumns\['bad'\]/);
  });

  it('accepts an ordinary bare identifier', () => {
    expect(
      () =>
        new PgDataset({
          namespace: 'v',
          sql: sqlStub,
          promotedColumns: { severity: { column: 'severity_level_2', kind: 'text' } }
        })
    ).not.toThrow();
  });
});
