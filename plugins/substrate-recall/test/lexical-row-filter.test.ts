/**
 * The lexical stores scope by row fields INSIDE the search, so a filtered
 * search fills k from matching rows instead of spending it on rows a caller
 * would drop.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryLexicalStore } from '../src/in-memory-lexical-store.js';
import type { LexicalStore } from '../src/lexical-store.js';
import { lexicalMigration } from '../src/migrations/0003_lexical.js';
import { PgLexicalStore } from '../src/pg-lexical-store.js';
import { ensureRows } from './_pg-rows.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = 'lexfilter';

/**
 * 40 alpha rows rank above 3 beta rows for "sweden" (they repeat the term and
 * sort first by id). "fjord trip" matches every term only on alpha rows, so a
 * beta-scoped search for it finds nothing in the strict pass.
 */
const ROWS = [
  ...Array.from({ length: 40 }, (_, i) => ({
    id: `a${String(i).padStart(2, '0')}`,
    project: 'alpha' as string | null,
    text: 'sweden sweden sweden fjord trip'
  })),
  ...Array.from({ length: 3 }, (_, i) => ({
    id: `b${i}`,
    project: 'beta' as string | null,
    text: 'sweden trip'
  })),
  { id: 'n0', project: null as string | null, text: 'sweden trip' }
];

function suite(name: string, make: () => Promise<LexicalStore>) {
  describe(name, () => {
    let store: LexicalStore;
    beforeAll(async () => {
      store = await make();
    });
    const search = (query: string, k: number, rowFilter?: Record<string, unknown>) =>
      store.search({
        namespace: NS,
        type: 'Doc',
        query,
        k,
        ...(rowFilter !== undefined ? { rowFilter: rowFilter as never } : {})
      });

    it('without a filter, the higher-ranked project crowds the other out', async () => {
      const hits = await search('sweden', 3);
      expect(hits.every((h) => h.row.project === 'alpha')).toBe(true);
    });

    it('a filter fills k from the matching rows', async () => {
      const hits = await search('sweden', 3, { project: { eq: 'beta' } });
      expect(hits.map((h) => h.rowId)).toEqual(['b0', 'b1', 'b2']);
    });

    it('`in` with null admits the project-less row and not the other project', async () => {
      const hits = await search('sweden', 10, { project: { in: ['beta', null] } });
      expect(hits.map((h) => h.rowId).sort()).toEqual(['b0', 'b1', 'b2', 'n0']);
    });

    it('the OR fallback is filtered too, and fires when no in-scope row matches every term', async () => {
      const hits = await search('fjord trip', 3, { project: { eq: 'beta' } });
      expect(hits.map((h) => h.rowId)).toEqual(['b0', 'b1', 'b2']);
    });
  });
}

suite('in-memory lexical store', async () => {
  const ds = new MemoryDataset({ namespace: NS });
  await ds.write(
    'Doc',
    ROWS.map(({ id, project }) => (project === null ? { id } : { id, project }))
  );
  const store = new InMemoryLexicalStore({ datasetFor: () => ds });
  for (const r of ROWS) {
    await store.upsert({ rowNamespace: NS, rowType: 'Doc', rowId: r.id, text: r.text });
  }
  return store;
});

describe('in-memory lexical store with no row resolver', () => {
  it('matches no row under a filter, since no row can be read', async () => {
    const store = new InMemoryLexicalStore();
    await store.upsert({ rowNamespace: NS, rowType: 'Doc', rowId: 'x', text: 'sweden' });
    const hits = await store.search({
      namespace: NS,
      type: 'Doc',
      query: 'sweden',
      k: 5,
      rowFilter: { project: { eq: null } }
    });
    expect(hits).toEqual([]);
  });
});

describe.skipIf(POSTGRES_URL === undefined)('pg', () => {
  let sql: ReturnType<typeof postgres>;
  afterAll(async () => {
    await sql`DELETE FROM lexical WHERE row_namespace = ${NS}`;
    await sql`DELETE FROM rows WHERE namespace = ${NS}`;
    await sql.end();
  });
  suite('pg lexical store', async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await ensureRows(sql);
    const lex = lexicalMigration();
    await lex.apply({ sql } as unknown as Parameters<typeof lex.apply>[0]);
    await sql`DELETE FROM lexical WHERE row_namespace = ${NS}`;
    await sql`DELETE FROM rows WHERE namespace = ${NS}`;
    const store = new PgLexicalStore(sql);
    for (const r of ROWS) {
      const body = r.project === null ? { id: r.id } : { id: r.id, project: r.project };
      await sql`INSERT INTO rows (namespace, type, id, body)
        VALUES (${NS}, 'Doc', ${r.id}, ${sql.json(body)})`;
      await store.upsert({ rowNamespace: NS, rowType: 'Doc', rowId: r.id, text: r.text });
    }
    return store;
  });
});
