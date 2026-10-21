import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { embeddingsMigration } from '../src/migrations/0001_embeddings.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const isPgGated = POSTGRES_URL !== undefined;

type Sql = ReturnType<typeof postgres>;

/**
 * Does the table the migration manages exist? Resolved through the
 * connection's search_path — the same way the migration's own unqualified
 * `CREATE TABLE embeddings` resolves it, so the assertion and the thing
 * asserted on agree by construction. An unqualified catalog query would also
 * count same-named tables in every other schema of the database.
 */
const tableExists = async (sql: Sql): Promise<boolean> => {
  const rows = await sql<Array<{ reg: string | null }>>`
    SELECT to_regclass('embeddings')::text AS reg
  `;
  return rows[0]?.reg != null;
};

/** Index names on that table, scoped to the schema this connection writes to. */
const indexNames = async (sql: Sql): Promise<string[]> => {
  const rows = await sql<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'embeddings'
  `;
  return rows.map((r) => r.indexname);
};

describe.skipIf(!isPgGated)('embeddingsMigration', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await sql`DROP TABLE IF EXISTS embeddings CASCADE`;
  });

  afterAll(async () => {
    await sql`DROP TABLE IF EXISTS embeddings CASCADE`;
    await sql.end();
  });

  it('apply creates the embeddings table + hnsw index', async () => {
    await embeddingsMigration().apply({ sql, metric: () => {} });
    expect(await tableExists(sql)).toBe(true);
    expect(await indexNames(sql)).toContain('embeddings_hnsw');
  });

  it('apply creates the salience columns with their defaults', async () => {
    await embeddingsMigration().apply({ sql, metric: () => {} });
    const cols = await sql<Array<{ column_name: string; column_default: string | null }>>`
      SELECT column_name, column_default FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'embeddings'
        AND column_name IN ('salience', 'salience_updated_at')
      ORDER BY column_name
    `;
    expect(cols.map((c) => c.column_name)).toEqual(['salience', 'salience_updated_at']);
    expect(cols[0]?.column_default).toBe('0');
    expect(cols[1]?.column_default).toBe('now()');
  });

  it('apply is idempotent — re-applying after creation is a no-op', async () => {
    await embeddingsMigration().apply({ sql, metric: () => {} });
    await embeddingsMigration().apply({ sql, metric: () => {} });
    expect(await tableExists(sql)).toBe(true);
  });

  it('rollback drops the table + indexes', async () => {
    await embeddingsMigration().apply({ sql, metric: () => {} });
    await embeddingsMigration().rollback?.({ sql, metric: () => {} });
    expect(await tableExists(sql)).toBe(false);
  });

  it('honors custom dimension + HNSW build params', async () => {
    await sql`DROP TABLE IF EXISTS embeddings CASCADE`;
    await embeddingsMigration({
      dimension: 1024,
      hnswM: 24,
      hnswEfConstruction: 200
    }).apply({ sql, metric: () => {} });

    // format_type renders the column as `vector(N)` regardless of the
    // underlying atttypmod encoding — the most portable way to assert dim.
    const cols = await sql<Array<{ coltype: string }>>`
      SELECT format_type(atttypid, atttypmod) AS coltype
      FROM pg_attribute
      WHERE attrelid = 'embeddings'::regclass AND attname = 'embedding'
    `;
    expect(cols[0]?.coltype).toBe('vector(1024)');

    // Index def quoting differs across pg versions (m=24 vs m='24'); strip
    // quotes before asserting.
    const defs = await sql<Array<{ def: string }>>`
      SELECT pg_get_indexdef('embeddings_hnsw'::regclass) AS def
    `;
    const def = (defs[0]?.def ?? '').replace(/'/g, '');
    expect(def).toMatch(/m\s*=\s*24/);
    expect(def).toMatch(/ef_construction\s*=\s*200/);
  });

  it('rejects non-positive build params at construction time', () => {
    expect(() => embeddingsMigration({ dimension: 0 })).toThrow();
    expect(() => embeddingsMigration({ hnswM: -1 })).toThrow();
    expect(() => embeddingsMigration({ hnswEfConstruction: 1.5 })).toThrow();
  });
});
