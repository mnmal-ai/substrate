import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recallClustersMigration } from '../src/migrations/0002_recall_clusters.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const isPgGated = POSTGRES_URL !== undefined;

const drop = async (sql: ReturnType<typeof postgres>): Promise<void> => {
  await sql`DROP TABLE IF EXISTS recall_cluster_members CASCADE`;
  await sql`DROP TABLE IF EXISTS recall_clusters CASCADE`;
};

describe.skipIf(!isPgGated)('recallClustersMigration', () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await drop(sql);
  });

  afterAll(async () => {
    await drop(sql);
    await sql.end();
  });

  it('apply creates both tables and their indexes', async () => {
    await recallClustersMigration({ dimension: 8 }).apply({ sql, metric: () => {}, layout: null });

    const tables = await sql<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name IN ('recall_clusters', 'recall_cluster_members')
      ORDER BY table_name
    `;
    expect(tables.map((r) => r.table_name)).toEqual(['recall_cluster_members', 'recall_clusters']);

    const indexes = await sql<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename IN ('recall_clusters', 'recall_cluster_members')
    `;
    const names = indexes.map((r) => r.indexname);
    expect(names).toContain('recall_clusters_live');
    expect(names).toContain('recall_cluster_members_unique');
    expect(names).toContain('recall_cluster_members_member');
  });

  it('apply is idempotent', async () => {
    await recallClustersMigration({ dimension: 8 }).apply({ sql, metric: () => {}, layout: null });
    await recallClustersMigration({ dimension: 8 }).apply({ sql, metric: () => {}, layout: null });
    const tables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'recall_clusters'
    `;
    expect(tables.length).toBe(1);
  });

  it('deleting a cluster cascades to its members', async () => {
    await recallClustersMigration({ dimension: 8 }).apply({ sql, metric: () => {}, layout: null });
    await sql`
      INSERT INTO recall_clusters (id, centroid, cohesion, label, labelled_by, provenance)
      VALUES ('c1', ${'[1,0,0,0,0,0,0,0]'}::vector, 0.9, 'l', 'medoid', ${sql.json({})})
    `;
    await sql`
      INSERT INTO recall_cluster_members
        (id, cluster_id, member_ns, member_type, member_id, origin, similarity)
      VALUES ('m1', 'c1', 'cortext', 'Decision', 'd1', 'formation', 0.8)
    `;
    await sql`DELETE FROM recall_clusters WHERE id = 'c1'`;
    const left = await sql`SELECT id FROM recall_cluster_members WHERE id = 'm1'`;
    expect(left.length).toBe(0);
  });

  it('refuses a duplicate (cluster, member) pair', async () => {
    await recallClustersMigration({ dimension: 8 }).apply({ sql, metric: () => {}, layout: null });
    await sql`
      INSERT INTO recall_clusters (id, centroid, cohesion, label, labelled_by, provenance)
      VALUES ('c2', ${'[1,0,0,0,0,0,0,0]'}::vector, 0.9, 'l', 'medoid', ${sql.json({})})
      ON CONFLICT (id) DO NOTHING
    `;
    const insert = async (): Promise<unknown> => sql`
      INSERT INTO recall_cluster_members
        (id, cluster_id, member_ns, member_type, member_id, origin, similarity)
      VALUES (${`m-${Math.random()}`}, 'c2', 'cortext', 'Decision', 'dup', 'formation', 0.8)
    `;
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key/i);
  });

  it('rollback drops both tables', async () => {
    await recallClustersMigration({ dimension: 8 }).apply({ sql, metric: () => {}, layout: null });
    await recallClustersMigration({ dimension: 8 }).rollback?.({
      sql,
      metric: () => {},
      layout: null
    });
    const tables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name IN ('recall_clusters', 'recall_cluster_members')
    `;
    expect(tables.length).toBe(0);
  });

  it('is a no-op in memory mode (sql === null)', async () => {
    await expect(
      recallClustersMigration().apply({ sql: null, metric: () => {}, layout: null })
    ).resolves.toBeUndefined();
  });
});
