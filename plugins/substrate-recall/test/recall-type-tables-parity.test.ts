/**
 * The pg recall stores read rows through type tables on the `tables` layout:
 * every row a hit carries equals `dataset.read`'s row on the same store, the
 * row filter compares what that row reads, and `purgeOrphans` reaps entries of
 * rows and types that are gone. On the old layouts, the recall SQL is
 * unchanged, which a snapshot of every statement proves.
 */

import { randomBytes } from 'node:crypto';
import { PgDataset } from '@mnmal-ai/substrate-dataset-pg';
import type { FieldDef, Row } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type KnnRowFilter, matchesRowFilter } from '../src/embeddings-store.js';
import { embeddingsMigration } from '../src/migrations/0001_embeddings.js';
import { lexicalMigration } from '../src/migrations/0003_lexical.js';
import { PgEmbeddingsStore } from '../src/pg-embeddings-store.js';
import { PgLexicalStore } from '../src/pg-lexical-store.js';
import { TABLES } from './_pg-rows.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const DIM = 768;
const MODEL = 'm:768';
const PREFIX = `rtt_${randomBytes(4).toString('hex')}`;
/** A namespace per test, so no test reads a table descriptor another one cached. */
let NS = PREFIX;
let run = 0;
const query = Float32Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : 0));
const near = (t: number) =>
  Float32Array.from({ length: DIM }, (_, i) => (i === 0 ? 1 : i === 1 ? t : 0));

const str: FieldDef = { kind: 'scalar', type: 'string' };
const num: FieldDef = { kind: 'scalar', type: 'number' };
const DOC: Record<string, FieldDef> = {
  title: str,
  n: num,
  due: { kind: 'scalar', type: 'date' },
  done: { kind: 'scalar', type: 'boolean' },
  status: { kind: 'scalar', type: 'string', enum: ['open', 'closed'] },
  owner: { kind: 'crossRef', ns: PREFIX, type: 'Person', onDelete: 'set_null', indexed: true },
  meta: { kind: 'scalar', type: 'json', indexed: false }
};

const defs: Record<string, { fields: Record<string, FieldDef> }> = {};
function resetDefs(): void {
  for (const k of Object.keys(defs)) delete defs[k];
  Object.assign(defs, {
    Doc: { fields: DOC },
    Gone: { fields: { keep: str, drop: num } },
    Pend: { fields: { a: str } },
    Other: { fields: { a: str } }
  });
}
resetDefs();
const typeDefLookup = (type: string) => defs[type];
const fieldDefLookup = (type: string, f: string) => defs[type]?.fields[f];

const DOCS = [
  {
    id: 'd1',
    title: 'alpha',
    n: 0.1 + 0.2,
    // Microseconds the column keeps and a read does not: shielded under `$raw`.
    due: '2026-01-02T03:04:05.123456Z',
    done: true,
    status: 'open',
    owner: 'p1',
    meta: { a: 1, b: null },
    project: 'alpha',
    loose: null
  },
  // Explicit null on a column field reads absent; a date-only text and a numeric id are `$raw`.
  { id: 'd2', title: null, n: 1e21, due: '2026-01-02', owner: 42, project: 'beta' },
  { id: 'd3', title: 'gamma', n: 5e-324, due: '2026-06-01T00:00:00.000Z', done: false }
];

const byId = (rows: Row[]) =>
  Object.fromEntries(
    rows.map(({ _metadata: _m, ...r }) => [String(r.id), r as Record<string, unknown>])
  );

describe.skipIf(!POSTGRES_URL || !TABLES)('recall rows on type tables equal dataset.read', () => {
  let sql: Sql;
  let ds: PgDataset;
  let emb: PgEmbeddingsStore;
  let lex: PgLexicalStore;

  /** Embeds and indexes `ids` of `type`, the i-th nearest the query. */
  async function index(type: string, ids: string[]): Promise<void> {
    for (const [i, id] of ids.entries()) {
      const at = { rowNamespace: NS, rowType: type, rowId: id };
      await emb.upsert({ ...at, vector: near(0.01 * (i + 1)), model: MODEL });
      await lex.upsert({ ...at, text: `common word ${id}` });
    }
  }

  async function datasetRows(type: string, ids: string[]) {
    return byId((await ds.read(type, { ids })).rows);
  }

  async function knnRows(type: string, rowFilter?: KnnRowFilter) {
    const hits = await emb.knnSearch({
      namespace: NS,
      type,
      model: MODEL,
      vector: query,
      k: 50,
      ...(rowFilter ? { rowFilter } : {})
    });
    return Object.fromEntries(hits.map((h) => [String(h.row.id), h.row]));
  }

  async function lexRows(type: string, rowFilter?: KnnRowFilter) {
    const hits = await lex.search({
      namespace: NS,
      type,
      query: 'common',
      k: 50,
      ...(rowFilter ? { rowFilter } : {})
    });
    return Object.fromEntries(hits.map((h) => [h.rowId, h.row]));
  }

  async function clear(): Promise<void> {
    await sql`DELETE FROM embeddings WHERE starts_with(row_namespace, ${PREFIX})`;
    await sql`DELETE FROM lexical WHERE starts_with(row_namespace, ${PREFIX})`;
    const tables = await sql<Array<{ table_name: string }>>`
      SELECT table_name FROM substrate_type_tables WHERE starts_with(namespace, ${PREFIX})`;
    for (const t of tables) await sql.unsafe(`DROP TABLE IF EXISTS "${t.table_name}"`);
    await sql`DELETE FROM substrate_type_fields WHERE starts_with(namespace, ${PREFIX})`;
    await sql`DELETE FROM substrate_type_tables WHERE starts_with(namespace, ${PREFIX})`;
    await sql`DELETE FROM row_ids WHERE starts_with(namespace, ${PREFIX})`;
  }

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await embeddingsMigration().apply({ sql, metric: () => {}, layout: null });
    const lexical = lexicalMigration();
    await lexical.apply({ sql } as unknown as Parameters<typeof lexical.apply>[0]);
    emb = new PgEmbeddingsStore({ sql });
    lex = new PgLexicalStore(sql);
  });

  beforeEach(async () => {
    resetDefs();
    NS = `${PREFIX}_${run++}`;
    ds = new PgDataset({ namespace: NS, sql, fieldDefLookup, typeDefLookup });
  });

  afterAll(async () => {
    await clear();
    await sql.end({ timeout: 5 });
  });

  it('knn hit row equals dataset.read row (dates with $raw, explicit null absent)', async () => {
    await ds.write('Doc', DOCS);
    await index(
      'Doc',
      DOCS.map((d) => d.id)
    );
    const want = await datasetRows(
      'Doc',
      DOCS.map((d) => d.id)
    );
    expect(Object.keys(want)).toHaveLength(3);
    expect(want.d2).not.toHaveProperty('title');
    expect(want.d1?.due).toBe('2026-01-02T03:04:05.123456Z');
    expect(await knnRows('Doc')).toEqual(want);
    // The batch reads build the same row.
    const fetched = await emb.fetchEmbeddings(
      DOCS.map((d) => ({ namespace: NS, type: 'Doc', id: d.id })),
      MODEL
    );
    expect(Object.fromEntries(fetched.map((f) => [f.id, f.row]))).toEqual(want);
    const candidates = await emb.selectCandidates(
      { scopes: [{ namespace: NS, type: 'Doc' }], excludeTextPrefixes: [], limit: 10 },
      MODEL
    );
    expect(Object.fromEntries(candidates.map((c) => [c.id, c.row]))).toEqual(want);
  });

  it('lexical search equals dataset.read row', async () => {
    await ds.write('Doc', DOCS);
    await index(
      'Doc',
      DOCS.map((d) => d.id)
    );
    const want = await datasetRows(
      'Doc',
      DOCS.map((d) => d.id)
    );
    expect(await lexRows('Doc')).toEqual(want);
    expect(await lex.countIndexed(NS, 'Doc')).toBe(3);
  });

  it('promoting field with a stale extra key: knn and lexical rows equal dataset.read (F13)', async () => {
    await ds.write('Gone', [
      { id: 'g1', keep: 'k', drop: 5 },
      { id: 'g2', drop: 5 },
      { id: 'g3', keep: 'k3' }
    ]);
    defs.Gone = { fields: { keep: str } };
    await ds.ensureTypeStorage('Gone');
    // Written while orphaned, these land in `extra`; g2's null stays there.
    await ds.write('Gone', [
      { id: 'g1', drop: 6 },
      { id: 'g2', drop: null }
    ]);
    defs.Gone = { fields: { keep: str, drop: num } };
    await ds.ensureTypeStorage('Gone');
    const ids = ['g1', 'g2', 'g3'];
    await index('Gone', ids);
    const want = await datasetRows('Gone', ids);
    // The stale extra key wins over the column; a null there reads absent, column and all.
    expect(want.g1?.drop).toBe(6);
    expect(want.g2).not.toHaveProperty('drop');
    expect(await knnRows('Gone')).toEqual(want);
    expect(await lexRows('Gone')).toEqual(want);
  });

  it('orphaned column value appears in the recall row as in dataset.read (F35)', async () => {
    await ds.write('Gone', [
      { id: 'g1', keep: 'k', drop: 5 },
      { id: 'g2', drop: 7 }
    ]);
    defs.Gone = { fields: { keep: str } };
    await ds.ensureTypeStorage('Gone');
    await ds.write('Gone', [{ id: 'g2', drop: null }]);
    await index('Gone', ['g1', 'g2']);
    const want = await datasetRows('Gone', ['g1', 'g2']);
    expect(want.g1?.drop).toBe(5);
    expect(want.g2).toHaveProperty('drop', null);
    expect(await knnRows('Gone')).toEqual(want);
    expect(await lexRows('Gone')).toEqual(want);
  });

  it('pending field values ride in extra, explicit null absent', async () => {
    // Undeclared when written, y's null sits in `extra`, where a pending `b` reads it absent.
    await ds.write('Pend', [{ id: 'y', a: 'y', b: null }]);
    defs.Pend = { fields: { a: str, b: num } };
    expect(await ds.ensureTypeStorage('Pend', { newFields: 'pending' })).toEqual({
      pending: ['b']
    });
    await ds.write('Pend', [{ id: 'x', a: 'a', b: 2 }]);
    await index('Pend', ['x', 'y']);
    const want = await datasetRows('Pend', ['x', 'y']);
    expect(want.y).not.toHaveProperty('b');
    expect(await knnRows('Pend')).toEqual(want);
    expect(await lexRows('Pend')).toEqual(want);
  });

  it('a type with more columns than one jsonb_build_object takes reads whole', async () => {
    const names = Array.from({ length: 60 }, (_, i) => `c${i}`);
    defs.Wide = { fields: Object.fromEntries(names.map((n) => [n, str])) };
    await ds.write('Wide', [{ id: 'w1', ...Object.fromEntries(names.map((n) => [n, n])) }]);
    await index('Wide', ['w1']);
    const want = await datasetRows('Wide', ['w1']);
    expect(Object.keys(want.w1 ?? {})).toHaveLength(61);
    expect(await knnRows('Wide')).toEqual(want);
  });

  it('row filter on a column and on an extra field matches', async () => {
    await ds.write('Doc', DOCS);
    await index(
      'Doc',
      DOCS.map((d) => d.id)
    );
    const all = await datasetRows(
      'Doc',
      DOCS.map((d) => d.id)
    );
    const filters: KnnRowFilter[] = [
      { title: { eq: 'alpha' } },
      { title: { eq: null } },
      { title: { in: ['gamma', null] } },
      { project: { eq: 'beta' } },
      { project: { eq: null } },
      { done: { eq: false } },
      { status: { in: ['open'] } },
      { owner: { eq: '42' } },
      { due: { eq: '2026-01-02' } },
      { due: { eq: '2026-06-01T00:00:00.000Z' } },
      { title: { eq: 'alpha' }, project: { eq: 'alpha' } }
    ];
    for (const filter of filters) {
      const want = Object.keys(all)
        .filter((id) => matchesRowFilter(all[id] as Record<string, unknown>, filter))
        .sort();
      expect(want.length, JSON.stringify(filter)).toBeGreaterThan(0);
      expect(Object.keys(await knnRows('Doc', filter)).sort(), JSON.stringify(filter)).toEqual(
        want
      );
      expect(Object.keys(await lexRows('Doc', filter)).sort(), JSON.stringify(filter)).toEqual(
        want
      );
    }
  });

  it('purgeOrphans removes entries of tombstoned and purged rows and of a dropped type', async () => {
    await ds.write('Doc', [{ id: 'live' }, { id: 'tomb' }, { id: 'gone' }]);
    await ds.write('Other', [{ id: 'o1', a: 'x' }]);
    await index('Doc', ['live', 'tomb', 'gone']);
    await index('Other', ['o1']);
    // A type that never had a table.
    await index('Never', ['n1']);
    await ds.tombstone('Doc', ['tomb']);
    await ds.purge('Doc', ['gone']);
    await ds.dropType('Other');

    // Store-wide: other suites' orphans may go too.
    expect(await emb.purgeOrphans()).toBeGreaterThanOrEqual(4);
    expect(await lex.purgeOrphans()).toBeGreaterThanOrEqual(4);
    for (const table of ['embeddings', 'lexical']) {
      const left = await sql<Array<{ t: string; id: string }>>`
        SELECT row_type AS t, row_id AS id FROM ${sql(table)} WHERE row_namespace = ${NS}`;
      expect(left).toEqual([{ t: 'Doc', id: 'live' }]);
    }
    expect(await emb.purgeOrphans()).toBe(0);
    expect(await lex.purgeOrphans()).toBe(0);
  });
});

/**
 * Every statement the pg recall stores send on an old layout, against a
 * snapshot taken from the code before type tables: `legacy` writes it, and
 * `partitioned` must match it, so neither layout's recall SQL changed. The
 * layout probe a store now makes first is left out, as it is not recall SQL.
 */
describe.skipIf(!POSTGRES_URL || TABLES)('recall SQL on the old layouts', () => {
  const SNS = 'rtt_snapshot';
  let sql: Sql;
  const statements: string[] = [];

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, {
      onnotice: () => {},
      debug: (_c, q) => {
        statements.push(q);
      }
    });
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    await embeddingsMigration().apply({ sql, metric: () => {}, layout: null });
    const lexical = lexicalMigration();
    await lexical.apply({ sql } as unknown as Parameters<typeof lexical.apply>[0]);
    await sql`DELETE FROM embeddings WHERE row_namespace = ${SNS}`;
    await sql`DELETE FROM lexical WHERE row_namespace = ${SNS}`;
    await sql`DELETE FROM rows WHERE namespace = ${SNS}`;
    await sql`INSERT INTO rows (namespace, type, id, body)
      VALUES (${SNS}, 'Doc', 'd1', ${sql.json({ id: 'd1', project: 'p' })})`;
  });

  afterAll(async () => {
    await sql`DELETE FROM embeddings WHERE row_namespace = ${SNS}`;
    await sql`DELETE FROM lexical WHERE row_namespace = ${SNS}`;
    await sql`DELETE FROM rows WHERE namespace = ${SNS}`;
    await sql.end({ timeout: 5 });
  });

  it('is the statements recall sent before type tables', async () => {
    const emb = new PgEmbeddingsStore({ sql });
    const lex = new PgLexicalStore(sql);
    const at = { rowNamespace: SNS, rowType: 'Doc', rowId: 'd1' };
    await emb.upsert({ ...at, vector: near(0.1), model: MODEL });
    await lex.upsert({ ...at, text: 'hello world' });
    statements.length = 0;

    const knn = { namespace: SNS, type: 'Doc', model: MODEL, vector: query, k: 5 };
    expect(await emb.knnSearch(knn)).toHaveLength(1);
    expect(
      await emb.knnSearch({ ...knn, rowFilter: { project: { in: ['p', null] } } })
    ).toHaveLength(1);
    expect(
      await emb.fetchEmbeddings([{ namespace: SNS, type: 'Doc', id: 'd1' }], MODEL)
    ).toHaveLength(1);
    expect(
      await emb.selectCandidates(
        {
          scopes: [{ namespace: SNS, type: 'Doc' }],
          excludeTextPrefixes: [{ field: 'project', prefix: 'x' }],
          limit: 5
        },
        MODEL
      )
    ).toHaveLength(1);
    expect(await emb.staleRowIds({ namespace: SNS, type: 'Doc', afterId: '', limit: 5 })).toEqual(
      []
    );
    await emb.purgeOrphans();
    const lexical = { namespace: SNS, type: 'Doc', k: 5 };
    expect(await lex.search({ ...lexical, query: 'hello' })).toHaveLength(1);
    expect(
      await lex.search({ ...lexical, query: 'hello nothing', rowFilter: { project: { eq: 'p' } } })
    ).toHaveLength(1);
    expect(await lex.countIndexed(SNS, 'Doc')).toBe(1);
    await lex.purgeOrphans();

    const recallSql = statements.filter((s) => !s.includes('pg_class'));
    expect(recallSql).toMatchSnapshot();
  });
});
