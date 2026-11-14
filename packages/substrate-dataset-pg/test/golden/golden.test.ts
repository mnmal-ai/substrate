/**
 * Golden evals (Decision #627, Todo #1859): every read in `cases.ts` runs on
 * Postgres and its answer must equal the one recorded in `expected.json`,
 * value for value. The memory store answers the same reads against the same
 * expectations as a fast local mode, except the cases marked `memory`.
 *
 *   pnpm golden:record   re-records expected.json from pg (a deliberate change)
 *
 * Without GOLDEN_RECORD, any difference fails, and so does a case with no
 * recorded answer or a recorded answer with no case.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { Dataset, FieldDef, ReadParams, ReadResult } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../../src/index.js';
import { dropNamespace } from '../_layout.js';
import { CASES, type GoldenCase, NS, REF_FIELDS, SCHEMA, SEED, SEED_TOMBSTONED } from './cases.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const RECORD = process.env.GOLDEN_RECORD === '1';
const EXPECTED_FILE = new URL('./expected.json', import.meta.url);

const fieldDefLookup = (type: string, f: string): FieldDef | undefined =>
  Object.hasOwn(SCHEMA, type) && Object.hasOwn(SCHEMA[type] ?? {}, f)
    ? SCHEMA[type]?.[f]
    : undefined;
const typeDefLookup = (type: string) =>
  Object.hasOwn(SCHEMA, type) ? { fields: SCHEMA[type] ?? {} } : undefined;

/** A stable uuid per fixture name, since pg ids must be uuids; `names` maps back. */
const names = new Map<string, string>();
function u(name: string): string {
  const h = createHash('sha1').update(name).digest('hex');
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  names.set(id, name);
  return id;
}
/** A crossRef or id filter value: every string in it is a fixture name. */
const toIds = (v: unknown): unknown => {
  if (typeof v === 'string') return u(v);
  if (Array.isArray(v)) return v.map(toIds);
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toIds(x)]));
  return v;
};
/** Params with fixture names under `id`/`ids` and crossRef filters turned into uuids. */
function idParams(params: ReadParams): ReadParams {
  const out: Record<string, unknown> = { ...params };
  if (typeof params.id === 'string') out.id = u(params.id);
  if (params.where) out.where = mapRefs(params.where);
  return out as ReadParams;
}
function mapRefs(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(mapRefs);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => [k, REF_FIELDS.has(k) ? toIds(x) : mapRefs(x)])
  );
}

const isInt64 = (type: string, f: string) => {
  const def = fieldDefLookup(type, f);
  return def?.kind === 'scalar' && def.type === 'int64';
};

async function seed(ds: Dataset): Promise<void> {
  for (const [type, rows] of Object.entries(SEED)) {
    await ds.write(
      type,
      rows.map((r) =>
        Object.fromEntries(
          Object.entries(r).map(([k, v]) => [
            k,
            REF_FIELDS.has(k) && typeof v === 'string'
              ? u(v)
              : // The engine's write path hands a dataset int64 values as bigints.
                isInt64(type, k) && (typeof v === 'string' || typeof v === 'number')
                ? BigInt(v)
                : v
          ])
        )
      ) as never
    );
  }
  for (const [type, ids] of Object.entries(SEED_TOMBSTONED)) await ds.tombstone(type, ids.map(u));
}

/**
 * A JSON-safe, store-independent form: ids back to fixture names, int64 as
 * `{ $int64 }`, non-integers to 12 significant digits (float aggregates may
 * differ in the last bits), and the keys only one store fills dropped.
 */
function norm(v: unknown, row = false): unknown {
  if (typeof v === 'bigint') return { $int64: v.toString() };
  if (typeof v === 'number') return Number.isInteger(v) ? v : Number(v.toPrecision(12));
  if (typeof v === 'string') return names.get(v) ?? v;
  if (Array.isArray(v)) return v.map((x) => norm(x, row));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (row && (k === '_metadata' || k === 'shortId')) continue;
      out[k] = norm(x, k === 'rows' || Array.isArray(x));
    }
    return out;
  }
  return v;
}

/** One read's answer. Rows from a read with no defined order are sorted by id. */
function outcome(c: GoldenCase, r: ReadResult): Record<string, unknown> {
  let rows = norm(r.rows, true) as Array<{ id: string }>;
  if (c.params.orderBy === undefined) rows = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  return {
    rows,
    hasMore: r.hasMore,
    ...(r.nextCursor === undefined ? {} : { nextCursor: true }),
    ...(r.count === undefined ? {} : { count: r.count }),
    ...(r.groups === undefined ? {} : { groups: norm(r.groups) }),
    ...(r.truncated === undefined ? {} : { truncated: r.truncated })
  };
}

async function answer(ds: Dataset, c: GoldenCase): Promise<unknown> {
  const params = idParams(c.params);
  try {
    if (!c.pages) return outcome(c, await ds.read(c.type, params));
    const pages: unknown[] = [];
    let cursor: string | undefined;
    do {
      const r = await ds.read(c.type, { ...params, ...(cursor ? { cursor } : {}) });
      pages.push(outcome(c, r));
      cursor = r.nextCursor;
    } while (cursor !== undefined && pages.length < 20);
    return { pages };
  } catch (e) {
    const err = e as { code?: string; name?: string };
    return { error: err.code ?? err.name ?? 'Error' };
  }
}

const loadExpected = (): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(EXPECTED_FILE, 'utf8'));
  } catch {
    return {};
  }
};
const expected = loadExpected();

describe('golden evals: the set itself', () => {
  it('every case has a unique name and a recorded answer, and every answer a case', () => {
    const caseNames = CASES.map((c) => c.name);
    expect(new Set(caseNames).size).toBe(caseNames.length);
    if (RECORD) return;
    expect(
      Object.keys(expected).sort(),
      'run `pnpm golden:record` after adding or removing a case'
    ).toEqual([...caseNames].sort());
  });
});

describe('golden evals on memory (fast local mode)', () => {
  let mem: MemoryDataset;
  beforeAll(async () => {
    mem = new MemoryDataset({ namespace: NS, fieldDefLookup, typeDefLookup, walkReference: true });
    await seed(mem);
  });
  for (const c of CASES) {
    it.skipIf(RECORD || c.memory !== undefined)(c.name, async () => {
      expect(await answer(mem, c)).toEqual(expected[c.name]);
    });
  }
});

describe.skipIf(!POSTGRES_URL && !RECORD)('golden evals on pg', () => {
  let sql: Sql;
  let pg: PgDataset;
  const recorded: Record<string, unknown> = {};

  beforeAll(async () => {
    if (!POSTGRES_URL) throw new Error('GOLDEN_RECORD=1 records from pg: set POSTGRES_URL');
    sql = postgres(POSTGRES_URL, { onnotice: () => {} });
    await dropNamespace(sql, NS);
    pg = new PgDataset({ namespace: NS, sql, fieldDefLookup, typeDefLookup });
    for (const type of Object.keys(SCHEMA)) await pg.ensureTypeStorage(type);
    await seed(pg);
  });

  afterAll(async () => {
    if (RECORD) {
      const ordered = Object.fromEntries(CASES.map((c) => [c.name, recorded[c.name]]));
      writeFileSync(EXPECTED_FILE, `${JSON.stringify(ordered, null, 2)}\n`);
    }
    if (sql === undefined) return;
    await dropNamespace(sql, NS);
    await sql.end({ timeout: 5 });
  });

  for (const c of CASES) {
    it(c.name, async () => {
      const got = await answer(pg, c);
      if (RECORD) recorded[c.name] = got;
      else expect(got).toEqual(expected[c.name]);
    });
  }
});
