/**
 * migrate-store's copy (pg-gated): a legacy or partitioned source copied into
 * a partitioned target that `bootStore` prepared. Recall's tables come from
 * recall's own migrations at a small dimension, applied to both sides.
 */

import { randomBytes } from 'node:crypto';
import { PgShortIdStore, runMigrations, type StorageLayout } from '@mnmal-ai/substrate-dataset-pg';
import { pgTestSchemaName, pgTestSchemaUrl } from '@mnmal-ai/substrate-dataset-pg/testing';
import {
  embeddingsMigration,
  lexicalMigration,
  recallClustersMigration
} from '@mnmal-ai/substrate-recall';
import type { KernelMigrationContext } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CopyResult,
  copyStore,
  MigrateStoreColumnError
} from '../src/admin/migrate-store/copy.js';
import { type CopyPlan, preflight } from '../src/admin/migrate-store/preflight.js';
import type { ProgressEvent } from '../src/admin/migrate-store/progress.js';
import { inspectSource } from '../src/admin/migrate-store/source.js';
import { type BootedStore, bootStore } from '../src/serve/boot-store.js';
import { parseEnv } from '../src/serve/config.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const RECALL_TABLES = ['embeddings', 'lexical', 'recall_clusters', 'recall_cluster_members'];
const STORE_PROFILE_ID = '5703e000-0000-4000-8000-000000000001';
const DIM = 3;

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

async function applyRecall(sql: Sql, layout: StorageLayout): Promise<void> {
  const ctx = { sql, layout, metric: () => undefined } as KernelMigrationContext;
  for (const m of [
    embeddingsMigration({ dimension: DIM }),
    recallClustersMigration({ dimension: DIM }),
    lexicalMigration()
  ]) {
    await m.apply(ctx);
  }
}

async function seedSource(sql: Sql): Promise<void> {
  await sql.unsafe(`
    INSERT INTO rows (namespace, type, id, body, deleted_at, created_at, updated_at,
                      created_by_kind, created_by_id, updated_by_kind, updated_by_id, seq) VALUES
      ('_system', 'Key', '${uuid(1)}', '{"kid":"a@h","grants":["*"]}', NULL, now(), now(), 'system', 's', 'agent', 'a@h', NULL),
      ('_system', 'Key', '${uuid(2)}', '{"kid":"b@h","grants":["x"]}', now(), now(), now(), 'system', 's', 'system', 's', NULL),
      ('_system', 'Invite', '${uuid(3)}', '{"code":"c"}', NULL, now(), now(), 'user', 'u', 'user', 'u', NULL),
      ('_system', 'AuditEvent', '${uuid(4)}', '{"kind":"k1"}', NULL, now(), now(), 'system', 's', 'system', 's', 1),
      ('_system', 'AuditEvent', '${uuid(5)}', '{"kind":"k2"}', now(), now(), now(), 'system', 's', 'system', 's', 2),
      ('retired', 'Old', '${uuid(6)}', '{"x":1}', NULL, now(), now(), NULL, NULL, NULL, NULL, NULL);
    INSERT INTO short_ids (namespace, type, short_id, row_id) VALUES
      ('_system', 'Key', 1, '${uuid(1)}'), ('_system', 'Key', 7, '${uuid(2)}'),
      ('_system', 'AuditEvent', 3, '${uuid(4)}'), ('retired', 'Old', 2, '${uuid(6)}');
    INSERT INTO visible_seqs (namespace, type, last_seq) VALUES ('_system', 'AuditEvent', 5);
    INSERT INTO edges (id, from_ns, from_type, from_id, to_ns, to_type, to_id, field_name, policy, created_at, deleted_at) VALUES
      ('${uuid(10)}', '_system', 'Key', '${uuid(1)}', '_system', 'Invite', '${uuid(3)}', 'invite', 'orphan', now(), NULL),
      ('${uuid(11)}', '_system', 'Key', '${uuid(2)}', '_system', 'Invite', '${uuid(3)}', 'invite', 'orphan', now(), now());
    INSERT INTO embeddings (row_namespace, row_type, row_id, embedding, model, salience)
      VALUES ('_system', 'Invite', '${uuid(3)}', '[1,2,3]', 'm', 0.5);
    INSERT INTO lexical (row_namespace, row_type, row_id, content)
      VALUES ('_system', 'Invite', '${uuid(3)}', 'hello world');
    INSERT INTO recall_clusters (id, centroid, cohesion, label, labelled_by, provenance)
      VALUES ('c1', '[1,0,0]', 0.9, 'one', 'test', '{}'), ('c2', '[0,1,0]', 0.8, 'two', 'test', '{}'),
             ('c3', '[0,0,1]', 0.7, 'three', 'test', '{}');
    DELETE FROM recall_clusters WHERE id = 'c1';
    INSERT INTO recall_cluster_members (id, cluster_id, member_ns, member_type, member_id, origin, similarity)
      VALUES ('m1', 'c2', '_system', 'Invite', '${uuid(3)}', 'formed', 0.95),
             ('m2', 'c3', '_system', 'Key', '${uuid(1)}', 'formed', 0.9);`);
}

const ORDER: Record<string, string> = {
  rows: 'namespace, type, id',
  short_ids: 'namespace, type, short_id',
  edges: 'id',
  visible_seqs: 'namespace, type',
  embeddings: 'row_namespace, row_type, row_id',
  lexical: 'row_namespace, row_type, row_id',
  recall_clusters: 'id',
  recall_cluster_members: 'id'
};

async function dump(sql: Sql, plan: CopyPlan, skipRows: string[] = []) {
  const out: Record<string, unknown[]> = {};
  for (const t of plan.tables) {
    const rows = await sql.unsafe(
      `SELECT ${t.columns.map((c) => `"${c}"`).join(', ')}, to_jsonb(t)::text AS j FROM "${t.name}" t ORDER BY ${ORDER[t.name]}`
    );
    out[t.name] = rows
      .filter((r) => !(t.name === 'rows' && skipRows.includes(r.id)))
      .map((r) => r.j)
      .map((j) => {
        const o = JSON.parse(j as string);
        delete o.tsv;
        return o;
      });
  }
  return out;
}

for (const sourceLayout of ['legacy', 'partitioned'] as const) {
  describe.skipIf(!POSTGRES_URL)(`copyStore from a ${sourceLayout} source (pg)`, () => {
    let srcSchema: string;
    let tgtSchema: string;
    let srcUrl: string;
    let srcSql: Sql;
    let tgtSql: Sql;
    let booted: BootedStore;
    let plan: CopyPlan;
    const events: ProgressEvent[] = [];
    const opts = { batchRows: 2, onProgress: (e: ProgressEvent) => void events.push(e) };

    beforeEach(async () => {
      const tag = randomBytes(4).toString('hex');
      const srcName = `apps/substrate-copy-src-${tag}`;
      const tgtName = `apps/substrate-copy-tgt-${tag}`;
      srcSchema = pgTestSchemaName(srcName);
      tgtSchema = pgTestSchemaName(tgtName);
      srcUrl = pgTestSchemaUrl(POSTGRES_URL as string, srcName);
      const tgtUrl = pgTestSchemaUrl(POSTGRES_URL as string, tgtName);
      srcSql = postgres(srcUrl, { max: 1, onnotice: () => {} });
      tgtSql = postgres(tgtUrl, { max: 1, onnotice: () => {} });
      await srcSql.unsafe(`CREATE SCHEMA ${srcSchema}`);
      await tgtSql.unsafe(`CREATE SCHEMA ${tgtSchema}`);
      await runMigrations(srcSql, { layout: sourceLayout });
      await applyRecall(srcSql, sourceLayout);
      await seedSource(srcSql);

      booted = await bootStore({
        config: parseEnv({ SUBSTRATE_DATABASE_URL: tgtUrl, SUBSTRATE_SYSTEM_ACTOR: 'copy-test' }),
        pluginDir: null,
        layout: 'partitioned',
        allowMigrating: true
      });
      await applyRecall(tgtSql, 'partitioned');

      const pre = preflight(
        await inspectSource(srcSql),
        {
          serverVersionNum: 180000,
          empty: true,
          createdByUs: false,
          enforceUuidCheck: false,
          recallDims: DIM,
          extensionsAvailable: ['vector'],
          freeBytes: null
        },
        { skipTables: [], pluginTables: RECALL_TABLES, dryRun: false }
      );
      expect(pre.refusals).toEqual([]);
      plan = pre.plan;
      events.length = 0;
    });

    afterEach(async () => {
      await booted.close();
      await srcSql.unsafe(`DROP SCHEMA IF EXISTS ${srcSchema} CASCADE`);
      await tgtSql.unsafe(`DROP SCHEMA IF EXISTS ${tgtSchema} CASCADE`);
      await srcSql.end({ timeout: 5 });
      await tgtSql.end({ timeout: 5 });
    });

    const expectVerbatim = async (result: CopyResult) => {
      const seedIds = result.keptSeeds.map((s) => s.id);
      expect(await dump(tgtSql, plan, seedIds)).toEqual(await dump(srcSql, plan));
    };

    it('copies every row, shortId, edge and recall row verbatim', async () => {
      const result = await copyStore(srcSql, booted, plan, opts);
      expect(plan.tables.map((t) => t.name)).toEqual([
        'rows',
        'short_ids',
        'edges',
        'visible_seqs',
        ...RECALL_TABLES
      ]);
      await expectVerbatim(result);
      expect(result.tables.find((t) => t.name === 'rows')?.rows).toBe(6);
      expect(events.filter((e) => e.done).map((e) => e.table)).toEqual(
        plan.tables.map((t) => t.name)
      );
      expect(events.some((e) => e.table === 'rows' && !e.done && e.rows === 2)).toBe(true);
      // Declared types land in their own partitions.
      const [key] = await tgtSql<{ part: string }[]>`
        SELECT tableoid::regclass::text AS part FROM rows WHERE type = 'Key' LIMIT 1`;
      expect(key?.part).not.toMatch(/default/);
      // Nothing was written to the source.
      expect(await srcSql`SELECT to_regclass('substrate_migrate_store_progress') AS r`).toEqual([
        { r: null }
      ]);
    });

    it('advances shortId and recall identity sequences past the copied maximum', async () => {
      await copyStore(srcSql, booted, plan, opts);
      const ids = new PgShortIdStore(tgtSql);
      expect(await ids.allocateUnbound('_system', 'Key')).toBe(8);
      expect(await ids.allocateUnbound('retired', 'Old')).toBe(3);
      const [c] = await tgtSql<{ short_id: string }[]>`
        INSERT INTO recall_clusters (id, centroid, cohesion, label, labelled_by, provenance)
        VALUES ('c9', '[1,1,1]', 0.5, 'nine', 'test', '{}') RETURNING short_id`;
      expect(Number(c?.short_id)).toBe(4);
      const [m] = await tgtSql<{ short_id: string }[]>`
        INSERT INTO recall_cluster_members (id, cluster_id, member_ns, member_type, member_id, origin, similarity)
        VALUES ('m9', 'c9', '_system', 'Key', ${uuid(1)}, 'formed', 0.5) RETURNING short_id`;
      expect(Number(m?.short_id)).toBe(3);
    });

    it('lands an undeclared namespace in rows__default and reports it', async () => {
      const result = await copyStore(srcSql, booted, plan, opts);
      expect(result.defaulted).toEqual([{ namespace: 'retired', type: 'Old' }]);
      const [row] = await tgtSql<{ part: string }[]>`
        SELECT tableoid::regclass::text AS part FROM rows WHERE namespace = 'retired'`;
      expect(row?.part).toBe('rows__default');
    });

    it('replaces a seeded row with the source row of the same id and keeps seeds the source lacks', async () => {
      await srcSql`INSERT INTO rows (namespace, type, id, body) VALUES ('_system', 'StoreProfile', ${STORE_PROFILE_ID}, '{"profile":"source"}')`;
      await tgtSql`INSERT INTO rows (namespace, type, id, body) VALUES ('_system', 'AdvisorState', ${uuid(20)}, '{}')`;
      const result = await copyStore(srcSql, booted, plan, opts);
      expect(result.keptSeeds).toEqual([
        { namespace: '_system', type: 'AdvisorState', id: uuid(20) }
      ]);
      const [profile] = await tgtSql<{ body: { profile: string } }[]>`
        SELECT body FROM rows WHERE id = ${STORE_PROFILE_ID}`;
      expect(profile?.body.profile).toBe('source');
      await expectVerbatim(result);
    });

    it('refuses a source column the target lacks before any data moves', async () => {
      await srcSql`ALTER TABLE lexical ADD COLUMN extra text`;
      plan = preflight(
        await inspectSource(srcSql),
        {
          serverVersionNum: 180000,
          empty: true,
          createdByUs: false,
          enforceUuidCheck: false,
          recallDims: DIM,
          extensionsAvailable: ['vector'],
          freeBytes: null
        },
        { skipTables: [], pluginTables: RECALL_TABLES, dryRun: false }
      ).plan;
      const err = await copyStore(srcSql, booted, plan, opts).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MigrateStoreColumnError);
      expect(err).toMatchObject({ table: 'lexical', column: 'extra' });
      expect(await tgtSql`SELECT id FROM rows`).toEqual([{ id: STORE_PROFILE_ID }]);
    });

    it('fails loudly, naming the table and key, when the target rejects a row', async () => {
      await tgtSql`INSERT INTO edges (id, from_ns, from_type, from_id, to_ns, to_type, to_id, field_name, policy, created_at)
        VALUES (${uuid(10)}, 'a', 'T', 'x', 'a', 'T', 'y', 'f', 'orphan', now())`;
      await expect(copyStore(srcSql, booted, plan, opts)).rejects.toThrow(
        /copying edges failed: .*duplicate key.*\(id\)=/
      );
    });

    it('a rerun after an interrupted copy restarts cleanly', async () => {
      const abort = {
        batchRows: 2,
        onProgress: (e: ProgressEvent) => {
          if (e.table === 'rows' && e.done) throw new Error('interrupted');
        }
      };
      await expect(copyStore(srcSql, booted, plan, abort)).rejects.toThrow('interrupted');
      expect(Number((await tgtSql`SELECT count(*) AS n FROM rows`)[0]?.n)).toBe(7);

      const result = await copyStore(srcSql, booted, plan, opts);
      expect(result.keptSeeds).toEqual([
        { namespace: '_system', type: 'StoreProfile', id: STORE_PROFILE_ID }
      ]);
      await expectVerbatim(result);
      const steps = await tgtSql<{ step: string }[]>`
        SELECT step FROM substrate_migrate_store_progress ORDER BY step`;
      expect(steps.map((s) => s.step)).toContain('copy:done');
    });
  });
}
