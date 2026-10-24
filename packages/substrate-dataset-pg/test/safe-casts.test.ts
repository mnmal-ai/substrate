/**
 * substrate_num / substrate_ts: IMMUTABLE safe casts from jsonb. Wrong-shaped
 * input yields NULL rather than an error, and the functions are usable in
 * index expressions.
 *
 * Skipped when POSTGRES_URL isn't set.
 */

import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('safe-cast functions', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  const num = async (j: string) =>
    (await sql`SELECT substrate_num(${j}::text::jsonb)::text AS v`)[0]?.v as string | null;
  const ts = async (j: string) =>
    (await sql`SELECT extract(epoch FROM substrate_ts(${j}::text::jsonb))::text AS v`)[0]?.v as
      | string
      | null;

  it('substrate_num returns numbers only', async () => {
    expect(await num('1.5')).toBe('1.5');
    expect(await num('"1.5"')).toBeNull();
    expect(await num('null')).toBeNull();
    expect(await num('true')).toBeNull();
  });

  it('substrate_ts parses ISO strings with an explicit offset', async () => {
    const [{ e }] =
      (await sql`SELECT extract(epoch FROM '2026-10-24T10:00:00Z'::timestamptz)::text AS e`) as unknown as [
        { e: string }
      ];
    expect(await ts('"2026-10-24T10:00:00Z"')).toBe(e);
    expect(await ts('"2026-10-24T05:00:00-05:00"')).toBe(e);
  });

  it('substrate_ts yields NULL for other shapes', async () => {
    expect(await ts('"2026-10-24 10:00"')).toBeNull();
    expect(await ts('"yesterday"')).toBeNull();
    expect(await ts('42')).toBeNull();
    expect(await ts('"2026-13-45T00:00:00Z"')).toBeNull();
    expect(await ts('"2026-02-30T00:00:00Z"')).toBeNull();
  });

  it('substrate_ts ignores the session TimeZone', async () => {
    const at = async (tz: string) =>
      sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL TimeZone='${tz}'`);
        return (await tx`SELECT substrate_ts('"2026-10-24T10:00:00Z"'::jsonb)::text AS v`)[0]
          ?.v as string;
      });
    const [a, b] = [await at('America/Chicago'), await at('UTC')];
    const norm = async (v: string) =>
      (await sql`SELECT extract(epoch FROM ${v}::timestamptz)::text AS v`)[0]?.v;
    expect(await norm(a)).toBe(await norm(b));
  });

  it('substrate_ts parses inside a parallel plan of a writing statement', async () => {
    // A temp table is never scanned in parallel, so this one is real and dropped after.
    await sql.unsafe('DROP TABLE IF EXISTS sc_par_src, sc_par_out');
    try {
      await sql.unsafe(`CREATE TABLE sc_par_src AS
        SELECT jsonb_build_object('d', '2026-10-24T10:00:00Z') AS body FROM generate_series(1, 2000)`);
      const nulls = await sql.begin(async (tx) => {
        await tx.unsafe('SET LOCAL debug_parallel_query = on');
        await tx.unsafe('SET LOCAL parallel_setup_cost = 0');
        await tx.unsafe('SET LOCAL parallel_tuple_cost = 0');
        await tx.unsafe('SET LOCAL min_parallel_table_scan_size = 0');
        await tx.unsafe(
          "CREATE TABLE sc_par_out AS SELECT substrate_ts(body->'d') AS d FROM sc_par_src"
        );
        return (await tx`SELECT count(*)::int AS c FROM sc_par_out WHERE d IS NULL`)[0]?.c;
      });
      expect(nulls).toBe(0);
    } finally {
      await sql.unsafe('DROP TABLE IF EXISTS sc_par_src, sc_par_out');
    }
  });

  it('is IMMUTABLE: usable in an index expression', async () => {
    await sql.begin(async (tx) => {
      await tx.unsafe('CREATE TEMP TABLE sc_t (body jsonb)');
      await tx.unsafe("CREATE INDEX sc_t_d ON sc_t ((substrate_ts(body->'d')))");
      await tx.unsafe("CREATE INDEX sc_t_n ON sc_t ((substrate_num(body->'n')))");
      await tx.unsafe(`INSERT INTO sc_t VALUES ('{"d":"2026-13-45T00:00:00Z"}')`);
    });
  });
});
