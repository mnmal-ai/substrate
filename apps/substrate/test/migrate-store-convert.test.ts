/**
 * migrate-store's conversion into the `tables` layout (pg-gated): a legacy or
 * partitioned source, built from the frozen old-layout DDL, holding typed
 * fields, misfits, explicit nulls, offset and date-only dates, tombstones,
 * shortIds, `seq`, edges, an undeclared type and a body with its own `$raw`,
 * converted into type tables and verified.
 */

import { type PgDataset, typeTableRef } from '@mnmal-ai/substrate-dataset-pg';
import type { Row } from '@mnmal-ai/substrate-types';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { targetFacts } from '../src/admin/commands/migrate-store.js';
import { type CopyResult, copyStore } from '../src/admin/migrate-store/copy.js';
import { preflight } from '../src/admin/migrate-store/preflight.js';
import type { ProgressEvent } from '../src/admin/migrate-store/progress.js';
import { inspectSource } from '../src/admin/migrate-store/source.js';
import {
  missingIndexes,
  type VerifyOptions,
  verifyStore
} from '../src/admin/migrate-store/verify.js';
import { buildDeferredIndexes } from '../src/serve/wiring.js';
import {
  CHECKPOINT_INDEX,
  CONV,
  MIGRATE_PG,
  openPair,
  openSchemas,
  type Pair,
  RECALL_TABLES,
  uuid
} from './_fixtures/migrate-store.js';
import { buildOldLayout } from './_fixtures/old-layouts.js';

const T = (n: number) => uuid(100 + n);

/** `conv/Typed` bodies by id, each a case the conversion must keep. */
const TYPED: Record<string, Record<string, unknown>> = {
  // Every declared kind, well-typed, plus an undeclared key.
  [T(1)]: {
    title: 'a',
    count: 3.5,
    when: '2026-01-02T03:04:05.123Z',
    flag: true,
    status: 'open',
    ref: T(2),
    meta: { x: [1, 2] },
    note: 'n'
  },
  // Misfits: a value of the wrong kind on every column kind.
  [T(2)]: { title: 5, count: 'three', when: 'not a date', flag: 'yes', status: 'closed', ref: 7 },
  // Explicit nulls: declared columns read absent, json and undeclared keep null.
  [T(3)]: { title: null, count: null, meta: null, nope: null },
  // An offset date and a date alone: the instant in the column, the written text under $raw.
  [T(4)]: { when: '2026-01-02T05:04:05+02:00' },
  [T(5)]: { when: '2026-01-02' },
  // Tombstoned, with seq and shortId.
  [T(6)]: { title: 'gone', count: 1 },
  // The body's own $raw key, which a write would refuse.
  [T(7)]: { $raw: { title: 'x' }, title: 'y' }
};

/**
 * `conv/Typed` bodies whose numbers a JS double would change, as jsonb text
 * (inserted as text: `sql.json` would round them in JS first).
 */
const N = (n: number) => uuid(180 + n);
const NUMERIC: Record<string, string> = {
  // Beyond double precision on the number column, in a json field, and in extra; `1.0` and
  // `1e400` in extra.
  [N(1)]:
    '{"count": 12345678901234567890, "meta": {"big": 12345678901234567890, "p": 0.10000000000000000555}, "big": 12345678901234567890, "one": 1.0, "huge": 1e400}',
  // `1.0` on the number column: the double holds its value exactly, so the column takes it, and
  // `$raw` keeps the text jsonb would render as `1`.
  [N(2)]: '{"count": 1.0}',
  // An integer a double holds exactly but jsonb renders as 1152921504606847000.
  [N(3)]: '{"count": 1152921504606846976}'
};

async function seedConv(sql: Sql): Promise<void> {
  for (const [id, text] of Object.entries(NUMERIC)) {
    await sql`INSERT INTO rows (namespace, type, id, body) VALUES (${CONV}, 'Typed', ${id}, ${text}::text::jsonb)`;
  }
  for (const [id, body] of Object.entries(TYPED)) {
    const n = Number(id.slice(0, 8));
    await sql`
      INSERT INTO rows (namespace, type, id, body, deleted_at, created_at, updated_at,
                        created_by_kind, created_by_id, updated_by_kind, updated_by_id, seq)
      VALUES (${CONV}, 'Typed', ${id}, ${sql.json(body as never)},
              ${n === 106 ? '2026-05-06 07:08:09.654321+00' : null},
              ${`2026-03-04 05:06:07.${String(n).padStart(6, '0')}+00`}, '2026-03-05 00:00:00.000001+00',
              'agent', 'creator@h', 'user', 'editor', ${n === 106 ? 42 : null})`;
  }
  await sql`INSERT INTO short_ids (namespace, type, short_id, row_id) VALUES
    (${CONV}, 'Typed', 1, ${T(1)}), (${CONV}, 'Typed', 6, ${T(6)})`;
  await sql`INSERT INTO edges (id, from_ns, from_type, from_id, to_ns, to_type, to_id, field_name, policy, created_at)
    VALUES (${uuid(150)}, ${CONV}, 'Typed', ${T(1)}, ${CONV}, 'Typed', ${T(2)}, 'ref', 'set_null', now())`;
  // A live and a tombstoned checkpoint with one key: the unique index is over live rows only.
  await sql`INSERT INTO rows (namespace, type, id, body, deleted_at) VALUES
    (${CONV}, 'ExecutionCheckpoint', ${uuid(160)}, ${sql.json({ task: T(1), revision: 1 })}, NULL),
    (${CONV}, 'ExecutionCheckpoint', ${uuid(161)}, ${sql.json({ task: T(1), revision: 1 })}, now())`;
  // A namespace no definition declares.
  await sql`INSERT INTO rows (namespace, type, id, body) VALUES
    ('ghost', 'Thing', ${uuid(170)}, ${sql.json({ a: 1, b: 'x', c: null })})`;
}

/** Reads as the dataset returns them: id, metadata, tombstone and shortId dropped. */
const bodies = (rows: Row[]) =>
  Object.fromEntries(
    rows.map((r) => {
      const { id, _metadata, _deletedAt, shortId, ...body } = r;
      return [id, body];
    })
  );

/** Every source table's content and the schema's catalog, as one string per table. */
async function fingerprintSchema(sql: Sql): Promise<Record<string, string>> {
  const tables = await sql<{ name: string }[]>`
    SELECT relname AS name FROM pg_class
    WHERE relnamespace = current_schema()::regnamespace AND relkind IN ('r', 'p') ORDER BY 1`;
  const out: Record<string, string> = {};
  for (const { name } of tables) {
    const [r] = await sql.unsafe<{ h: string }[]>(
      `SELECT md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text), '')) AS h FROM "${name}" t`
    );
    out[name] = r?.h ?? '';
  }
  const [catalog] = await sql<{ h: string }[]>`
    SELECT md5(string_agg(c.relname || ':' || c.relkind::text, ',' ORDER BY c.relname)) AS h
    FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace`;
  out['(catalog)'] = catalog?.h ?? '';
  return out;
}

const verifyOpts = (pair: Pair, result: CopyResult, o: Partial<VerifyOptions> = {}) =>
  ({
    keptSeeds: result.keptSeeds,
    tables: pair.plan.tables.map((t) => t.name),
    fullChecksum: true,
    sampleRows: 1000,
    partitionBudget: 500,
    storageReport: (r) => (result.target.dataset as PgDataset).storageReport(r),
    missingIndexes: () => missingIndexes(result.target, false),
    ...o
  }) satisfies VerifyOptions;

const opts = { batchRows: 2, onProgress: () => {} };

for (const sourceLayout of ['legacy', 'partitioned'] as const) {
  describe.skipIf(!MIGRATE_PG)(`converting a ${sourceLayout} source into tables (pg)`, () => {
    let pair: Pair;
    let result: CopyResult;
    let before: Record<string, string>;
    const misfitsBefore: string[] = [];

    beforeAll(async () => {
      pair = await openPair(sourceLayout);
      await seedConv(pair.srcSql);
      // The seed added types: plan again.
      pair.plan = preflight(
        await inspectSource(pair.srcSql),
        {
          serverVersionNum: 180000,
          layout: 'absent',
          empty: true,
          createdByUs: false,
          enforceUuidCheck: false,
          recallDims: 768,
          extensions: { vector: '0.8.0' },
          freeBytes: null
        },
        { skipTables: [], pluginTables: RECALL_TABLES, dryRun: false }
      ).plan;
      before = await fingerprintSchema(pair.srcSql);
      misfitsBefore.length = 0;
      result = await copyStore(pair.srcSql, pair.boot, pair.plan, opts);
      await buildDeferredIndexes(result.target.engine, result.target.datasets);
    }, 240_000);

    afterAll(async () => {
      await result?.target.close();
      await pair?.close();
    });

    const conv = () => result.target.datasets.get(CONV) as PgDataset;

    it('target reads equal source bodies under the read rules (explicit null on a declared scalar absent, everything else identical)', async () => {
      const { rows: all } = await conv().read('Typed', { includeDeleted: true, limit: 100 });
      const rows = all.filter((r) => Object.hasOwn(TYPED, r.id));
      const expected = Object.fromEntries(
        Object.entries(TYPED).map(([id, body]) => {
          const b = { ...body };
          // title, count: declared columns; meta is json and nope undeclared, so their nulls stay.
          if (id === T(3)) {
            delete b.title;
            delete b.count;
          }
          return [id, b];
        })
      );
      expect(bodies(rows)).toEqual(expected);
      // The read path in SQL (recall's) agrees with decodeRow.
      const ref = await typeTableRef(pair.tgtSql, CONV, 'Typed');
      const viaSql = await pair.tgtSql.unsafe<{ id: string; row: Record<string, unknown> }[]>(
        `SELECT x.id, ${ref?.rowJson('x')} AS row FROM ${ref?.from} x`
      );
      expect(
        Object.fromEntries(
          viaSql.filter((r) => Object.hasOwn(TYPED, r.id)).map((r) => [r.id, r.row])
        )
      ).toEqual(expected);
      // Well-typed values sit in their columns; the offset date's instant too.
      const [t1] = await pair.tgtSql.unsafe<Record<string, unknown>[]>(
        `SELECT f_title, f_count, f_flag, f_status, f_ref, extra FROM ${ref?.from} WHERE id = $1`,
        [T(1)]
      );
      expect(t1).toEqual({
        f_title: 'a',
        f_count: 3.5,
        f_flag: true,
        f_status: 'open',
        f_ref: T(2),
        extra: { meta: { x: [1, 2] }, note: 'n' }
      });
      const [t4] = await pair.tgtSql.unsafe<{ instant: string }[]>(
        `SELECT to_char(f_when AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS instant FROM ${ref?.from} WHERE id = $1`,
        [T(4)]
      );
      expect(t4?.instant).toBe('2026-01-02T03:04:05');
    });

    it('misfits reported by type and field, values returned unchanged', async () => {
      const misfits = [
        { id: T(2), field: 'title' },
        { id: T(2), field: 'count' },
        { id: T(2), field: 'when' },
        { id: T(2), field: 'flag' },
        { id: T(2), field: 'status' },
        { id: T(7), field: '$raw' },
        { id: N(1), field: 'count' }
      ];
      expect(result.misfits[`${CONV}/Typed`]?.count).toBe(misfits.length);
      expect(result.misfits[`${CONV}/Typed`]?.first).toEqual(expect.arrayContaining(misfits));
      // A crossRef written as a number is no misfit: its column holds the id, and `$raw` the number.
      const { rows } = await conv().read('Typed', { where: { id: { eq: T(2) } } as never });
      expect(bodies(rows)[T(2)]).toEqual(TYPED[T(2)]);
      expect(Object.keys(result.misfits).sort()).toEqual([`${CONV}/Typed`]);
    });

    it('numbers keep their exact source text in extra, json fields and $raw; a number column takes only an exact value', async () => {
      const ref = await typeTableRef(pair.tgtSql, CONV, 'Typed');
      const stored = async (id: string) => {
        const [r] = await pair.tgtSql.unsafe<
          { count: number | null; extra: string; raw: string | null }[]
        >(
          `SELECT f_count AS count, (extra - '$raw')::text AS extra, (extra -> '$raw')::text AS raw
           FROM ${ref?.from} WHERE id = $1`,
          [id]
        );
        return r;
      };
      const source = async (id: string, without: string) => {
        const [r] = await pair.srcSql<{ rest: string; count: string | null }[]>`
          SELECT (body - ${without}::text)::text AS rest, (body -> 'count')::text AS count
          FROM rows WHERE id = ${id}`;
        return r;
      };
      // Beyond double precision on the column: NULL, the exact text under $raw, a misfit.
      const big = await stored(N(1));
      expect(big?.count).toBeNull();
      expect(big?.raw).toBe('{"count": 12345678901234567890}');
      // extra holds every other key with its exact text, the json field and 1.0 and 1e400 included.
      expect(big?.extra).toBe((await source(N(1), 'count'))?.rest);
      // jsonb prints 1e400 in full, and the copy keeps every digit of it.
      expect(big?.extra).toBe(
        `{"big": 12345678901234567890, "one": 1.0, "huge": 1${'0'.repeat(400)}, "meta": {"p": 0.10000000000000000555, "big": 12345678901234567890}}`
      );
      // 1.0 on the column: the column holds 1, $raw keeps "1.0", no misfit.
      const one = await stored(N(2));
      expect(one).toEqual({ count: 1, extra: '{}', raw: '{"count": 1.0}' });
      // 2^60: the column holds it exactly; $raw keeps the text jsonb would render otherwise.
      const pow = await stored(N(3));
      expect(pow).toEqual({ count: 2 ** 60, extra: '{}', raw: '{"count": 1152921504606846976}' });
      for (const id of [N(2), N(3)]) {
        expect(result.misfits[`${CONV}/Typed`]?.first).not.toContainEqual({ id, field: 'count' });
      }
      // The row as stored jsonb text equals the source body, number for number.
      for (const id of Object.keys(NUMERIC)) {
        const [t] = await pair.tgtSql.unsafe<{ row: string }[]>(
          `SELECT ${ref?.rowJson('x')}::text AS row FROM ${ref?.from} x WHERE x.id = $1`,
          [id]
        );
        const [s] = await pair.srcSql<
          { row: string }[]
        >`SELECT body::text AS row FROM rows WHERE id = ${id}`;
        expect(t?.row).toBe(s?.row);
      }
    });

    it('tombstones, metadata, shortIds and seq preserved', async () => {
      const ref = await typeTableRef(pair.tgtSql, CONV, 'Typed');
      const cols = `id, deleted_at::text, created_at::text, updated_at::text, created_by_kind, created_by_id, updated_by_kind, updated_by_id, seq::text`;
      const read = async (sql: Sql, from: string, where: string) => {
        await sql`SET TimeZone = 'UTC'`;
        return sql.unsafe(`SELECT ${cols} FROM ${from} WHERE ${where} ORDER BY id`);
      };
      expect(await read(pair.tgtSql, ref?.from as string, 'true')).toEqual(
        await read(pair.srcSql, 'rows', `namespace = '${CONV}' AND type = 'Typed'`)
      );
      const shorts = (sql: Sql) =>
        sql`SELECT short_id::int, row_id FROM short_ids WHERE namespace = ${CONV} ORDER BY 1`;
      expect(await shorts(pair.tgtSql)).toEqual(await shorts(pair.srcSql));
      expect(await shorts(pair.tgtSql)).toEqual([
        { short_id: 1, row_id: T(1) },
        { short_id: 6, row_id: T(6) }
      ]);
      const edges = (sql: Sql) =>
        sql`SELECT id, from_id, to_id, field_name FROM edges WHERE from_ns = ${CONV} ORDER BY id`;
      expect(await edges(pair.tgtSql)).toEqual(await edges(pair.srcSql));
      const { rows } = await conv().read('Typed', { includeDeleted: true, limit: 100 });
      const t6 = rows.find((r) => r.id === T(6));
      expect(t6?._metadata).toMatchObject({
        createdBy: { kind: 'agent', id: 'creator@h' },
        updatedBy: { kind: 'user', id: 'editor' }
      });
      // Every id is registered for its type, once.
      const [ids] = await pair.tgtSql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM row_ids WHERE namespace = ${CONV} AND type = 'Typed'`;
      expect(ids?.n).toBe(Object.keys(TYPED).length + Object.keys(NUMERIC).length);
    });

    it('verify passes; per-type counts equal', async () => {
      const counts = async (sql: Sql, from: (ns: string, ty: string) => Promise<string>) => {
        const out: Record<string, number> = {};
        for (const ty of ['Typed', 'ExecutionCheckpoint']) {
          const [r] = await sql.unsafe<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM ${await from(CONV, ty)}`
          );
          out[ty] = r?.n ?? -1;
        }
        return out;
      };
      expect(
        await counts(pair.tgtSql, async (ns, ty) => {
          const ref = await typeTableRef(pair.tgtSql, ns, ty);
          return ref?.from as string;
        })
      ).toEqual(
        await counts(
          pair.srcSql,
          async (ns, ty) => `(SELECT 1 FROM rows WHERE namespace = '${ns}' AND type = '${ty}') s`
        )
      );
      // Every declared field landed in its column: nothing pending or promoting, proposed types included.
      const unsettled = await pair.tgtSql`
        SELECT namespace, type, field, state FROM substrate_type_fields WHERE state <> 'column'`;
      expect(unsettled).toEqual([]);
      expect(await verifyStore(pair.srcSql, pair.tgtSql, verifyOpts(pair, result))).toEqual({
        ok: true,
        mismatches: [],
        missingIndexes: []
      });
    });

    it('source untouched (fingerprint before = after)', async () => {
      expect(await fingerprintSchema(pair.srcSql)).toEqual(before);
    });

    it('undeclared source type reported under defaulted; its fields read back from extra', async () => {
      expect(result.defaulted).toEqual(['ghost/Thing', 'retired/Old']);
      const ghost = (result.target.dataset as PgDataset).forNamespace('ghost');
      const { rows } = await ghost.read('Thing', {});
      expect(bodies(rows)).toEqual({ [uuid(170)]: { a: 1, b: 'x', c: null } });
      const ref = await typeTableRef(pair.tgtSql, 'ghost', 'Thing');
      const [stored] = await pair.tgtSql.unsafe<{ extra: unknown }[]>(
        `SELECT extra FROM ${ref?.from}`
      );
      expect(stored?.extra).toEqual({ a: 1, b: 'x', c: null });
    });

    it('source body with a $raw key → misfit on $raw, copy completes, value preserved', async () => {
      expect(result.misfits[`${CONV}/Typed`]?.first).toContainEqual({ id: T(7), field: '$raw' });
      const { rows } = await conv().read('Typed', { where: { id: { eq: T(7) } } as never });
      expect(bodies(rows)[T(7)]).toEqual({ $raw: { title: 'x' }, title: 'y' });
    });

    it('verify fails naming a declared unique partial index missing on the target; passes once it exists', async () => {
      await pair.tgtSql.unsafe(`DROP INDEX "${CHECKPOINT_INDEX}"`);
      // The marker stays until a verification passes, so this one leaves it.
      const failed = await verifyStore(pair.srcSql, pair.tgtSql, verifyOpts(pair, result));
      expect(failed.ok).toBe(false);
      expect(failed.missingIndexes).toEqual([
        { type: `${CONV}/ExecutionCheckpoint`, index: CHECKPOINT_INDEX }
      ]);
      await conv().ensureTypeStorage?.('ExecutionCheckpoint');
      const passed = await verifyStore(pair.srcSql, pair.tgtSql, verifyOpts(pair, result));
      expect(passed).toEqual({ ok: true, mismatches: [], missingIndexes: [] });
    });
  });

  describe.skipIf(!MIGRATE_PG)(`converting a ${sourceLayout} source: failures (pg)`, () => {
    let pair: Pair;

    beforeAll(async () => {
      pair = await openPair(sourceLayout);
      await seedConv(pair.srcSql);
    }, 120_000);

    afterAll(async () => {
      await pair?.close();
    });

    const replan = async () => {
      pair.plan = preflight(
        await inspectSource(pair.srcSql),
        {
          serverVersionNum: 180000,
          layout: 'absent',
          empty: true,
          createdByUs: false,
          enforceUuidCheck: false,
          recallDims: 768,
          extensions: { vector: '0.8.0' },
          freeBytes: null
        },
        { skipTables: [], pluginTables: RECALL_TABLES, dryRun: false }
      ).plan;
    };

    it('rerun after interruption restarts cleanly', async () => {
      await replan();
      const interrupt = {
        batchRows: 2,
        onProgress: (e: ProgressEvent) => {
          if (e.table === 'rows' && e.rows >= 4) throw new Error('interrupted');
        }
      };
      await expect(copyStore(pair.srcSql, pair.boot, pair.plan, interrupt)).rejects.toThrow(
        'interrupted'
      );
      const result = await copyStore(pair.srcSql, pair.boot, pair.plan, opts);
      try {
        await buildDeferredIndexes(result.target.engine, result.target.datasets);
        expect(await verifyStore(pair.srcSql, pair.tgtSql, verifyOpts(pair, result))).toEqual({
          ok: true,
          mismatches: [],
          missingIndexes: []
        });
      } finally {
        await result.target.close();
      }
    }, 240_000);

    it('a source duplicate under a declared unique index fails loudly, naming the type, index and key; a rerun after the fix restarts cleanly', async () => {
      // Over the verified copy of the test before: a copy into a target it made starts again.
      await pair.srcSql`UPDATE rows SET deleted_at = NULL WHERE id = ${uuid(161)}`;
      const err = (await copyStore(pair.srcSql, pair.boot, pair.plan, opts).catch(
        (e: unknown) => e
      )) as Error;
      expect(err.message).toContain(`${CONV}/ExecutionCheckpoint`);
      expect(err.message).toContain(CHECKPOINT_INDEX);
      expect(err.message).toContain(T(1));
      // The index is intact, and the target keeps its in-progress marker.
      const [idx] = await pair.tgtSql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ${CHECKPOINT_INDEX}`;
      expect(idx?.n).toBe(1);
      expect(
        (await pair.tgtSql`SELECT to_regclass('substrate_migrate_store_progress') AS r`)[0]?.r
      ).not.toBeNull();

      await pair.srcSql`UPDATE rows SET deleted_at = now() WHERE id = ${uuid(161)}`;
      const result = await copyStore(pair.srcSql, pair.boot, pair.plan, opts);
      try {
        await buildDeferredIndexes(result.target.engine, result.target.datasets);
        expect(await verifyStore(pair.srcSql, pair.tgtSql, verifyOpts(pair, result))).toEqual({
          ok: true,
          mismatches: [],
          missingIndexes: []
        });
      } finally {
        await result.target.close();
      }
    }, 240_000);

    it('target in legacy/partitioned refused by preflight', async () => {
      const schemas = await openSchemas(sourceLayout);
      try {
        await buildOldLayout(schemas.tgtSql, sourceLayout);
        const facts = await targetFacts(schemas.tgtSql, {} as never, 'off');
        expect(facts.layout).toBe(sourceLayout);
        const { refusals } = preflight(await inspectSource(schemas.srcSql), facts, {
          skipTables: [],
          pluginTables: RECALL_TABLES,
          dryRun: false
        });
        expect(refusals).toContainEqual(
          expect.stringMatching(new RegExp(`^target is a ${sourceLayout} store`))
        );
      } finally {
        await schemas.close();
      }
    }, 60_000);
  });
}

for (const sourceLayout of ['legacy', 'partitioned'] as const) {
  describe.skipIf(!MIGRATE_PG)(
    `a plugin column mirroring a body field, ${sourceLayout} source (pg)`,
    () => {
      let pair: Pair;
      let result: CopyResult;
      const M = (n: number) => uuid(190 + n);

      beforeAll(async () => {
        pair = await openPair(sourceLayout);
        // As cortext's 0001 did: a mirror column whose default old filters read for a body lacking the key.
        await pair.srcSql`ALTER TABLE rows ADD COLUMN flag boolean NOT NULL DEFAULT false, ADD COLUMN title text NULL`;
        await pair.srcSql`INSERT INTO rows (namespace, type, id, body, flag, title) VALUES
        (${CONV}, 'Typed', ${M(1)}, '{}'::jsonb, false, NULL),
        (${CONV}, 'Typed', ${M(2)}, '{"flag": true}'::jsonb, true, NULL),
        (${CONV}, 'Typed', ${M(3)}, '{"title": "body wins"}'::jsonb, true, 'column'),
        (${CONV}, 'ExecutionCheckpoint', ${M(4)}, '{"revision": 1}'::jsonb, false, NULL)`;
        pair.plan = preflight(
          { ...(await inspectSource(pair.srcSql)), otherSessions: 0 },
          {
            serverVersionNum: 180000,
            layout: 'absent',
            empty: true,
            createdByUs: false,
            enforceUuidCheck: false,
            recallDims: 768,
            extensions: { vector: '0.8.0' },
            freeBytes: null
          },
          { skipTables: [], pluginTables: RECALL_TABLES, dryRun: false }
        ).plan;
        result = await copyStore(pair.srcSql, pair.boot, pair.plan, opts);
        await buildDeferredIndexes(result.target.engine, result.target.datasets);
      }, 240_000);

      afterAll(async () => {
        await result?.target.close();
        await pair?.close();
      });

      it('fills a declared field the body lacks from its non-null mirror column; the body wins where it has the key', async () => {
        const ds = result.target.datasets.get(CONV) as PgDataset;
        const { rows: typed } = await ds.read('Typed', { limit: 100 });
        expect(bodies(typed)).toEqual({
          [M(1)]: { flag: false },
          [M(2)]: { flag: true },
          [M(3)]: { title: 'body wins', flag: true }
        });
        // A type that does not declare the field gets nothing from the column.
        const { rows: checkpoints } = await ds.read('ExecutionCheckpoint', { limit: 100 });
        expect(bodies(checkpoints)).toEqual({ [M(4)]: { revision: 1 } });
        // The filter a cold start runs finds the row whose body lacked the key.
        const { rows: unflagged } = await ds.read('Typed', {
          where: { flag: { eq: false } },
          limit: 100
        });
        expect(unflagged.map((r) => r.id)).toEqual([M(1)]);
      });

      it('verify reads the source the same way and passes', async () => {
        expect(await verifyStore(pair.srcSql, pair.tgtSql, verifyOpts(pair, result))).toEqual({
          ok: true,
          mismatches: [],
          missingIndexes: []
        });
      });
    }
  );
}
