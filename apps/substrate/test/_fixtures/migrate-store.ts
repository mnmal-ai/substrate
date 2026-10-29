/**
 * Shared fixture for the migrate-store pg suites: a source schema in either
 * layout seeded with rows, edges and recall data, and a target schema that
 * `bootStore` has already prepared, with the plan preflight derives.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runMigrations, type StorageLayout } from '@mnmal-ai/substrate-dataset-pg';
import { pgTestSchemaName, pgTestSchemaUrl } from '@mnmal-ai/substrate-dataset-pg/testing';
import {
  embeddingsMigration,
  lexicalMigration,
  recallClustersMigration
} from '@mnmal-ai/substrate-recall';
import type { KernelMigrationContext } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { type CopyPlan, preflight } from '../../src/admin/migrate-store/preflight.js';
import { inspectSource } from '../../src/admin/migrate-store/source.js';
import { type BootedStore, bootStore } from '../../src/serve/boot-store.js';
import { parseEnv } from '../../src/serve/config.js';

export const POSTGRES_URL = process.env.POSTGRES_URL;
export const RECALL_TABLES = ['embeddings', 'lexical', 'recall_clusters', 'recall_cluster_members'];
export const STORE_PROFILE_ID = '5703e000-0000-4000-8000-000000000001';
/** Recall's default, which the target's recall (no embedder configured) keeps. */
export const DIM = 768;

export const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
/** A DIM-long vector literal with a 1 at `i`. */
export const vec = (i: number) =>
  `[${Array.from({ length: DIM }, (_, j) => (j === i ? 1 : 0)).join(',')}]`;

export async function applyRecall(sql: Sql, layout: StorageLayout): Promise<void> {
  const ctx = { sql, layout, metric: () => undefined } as KernelMigrationContext;
  for (const m of [embeddingsMigration(), recallClustersMigration(), lexicalMigration()]) {
    await m.apply(ctx);
  }
}

/** A plugin dir that loads this package's built-in plugins, recall and proposals. */
export async function makePluginDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'substrate-migrate-plugins-'));
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ dependencies: { '@mnmal-ai/substrate': '*' } })
  );
  await mkdir(join(dir, 'node_modules', '@mnmal-ai'), { recursive: true });
  await symlink(resolve('.'), join(dir, 'node_modules', '@mnmal-ai', 'substrate'));
  return dir;
}

export async function seedSource(sql: Sql): Promise<void> {
  await sql.unsafe(`
    INSERT INTO rows (namespace, type, id, body, deleted_at, created_at, updated_at,
                      created_by_kind, created_by_id, updated_by_kind, updated_by_id, seq) VALUES
      ('_system', 'Key', '${uuid(1)}', '{"kid":"a@h","grants":["*"]}', NULL, now(), now(), 'system', 's', 'agent', 'a@h', NULL),
      ('_system', 'Key', '${uuid(2)}', '{"kid":"b@h","grants":["x"]}', now(), now(), now(), 'system', 's', 'system', 's', NULL),
      ('_system', 'Invite', '${uuid(3)}', '{"code":"c"}', NULL, now(), now(), 'user', 'u', 'user', 'u', NULL),
      ('_system', 'AuditEvent', '${uuid(4)}', '{"kind":"k1"}', NULL, now(), now(), 'system', 's', 'system', 's', 1),
      ('_system', 'AuditEvent', '${uuid(5)}', '{"kind":"k2"}', now(), now(), now(), 'system', 's', 'system', 's', 2),
      ('_system', 'AuditEvent', '${uuid(7)}', '{"kind":"bootstrap","actorKid":"bootstrap"}', NULL, now(), now(), 'system', 'bootstrap', 'system', 'bootstrap', 3),
      ('retired', 'Old', '${uuid(6)}', '{"x":1}', NULL, now(), now(), NULL, NULL, NULL, NULL, NULL);
    INSERT INTO short_ids (namespace, type, short_id, row_id) VALUES
      ('_system', 'Key', 1, '${uuid(1)}'), ('_system', 'Key', 7, '${uuid(2)}'),
      ('_system', 'AuditEvent', 3, '${uuid(4)}'), ('retired', 'Old', 2, '${uuid(6)}');
    INSERT INTO visible_seqs (namespace, type, last_seq) VALUES ('_system', 'AuditEvent', 5);
    INSERT INTO edges (id, from_ns, from_type, from_id, to_ns, to_type, to_id, field_name, policy, created_at, deleted_at) VALUES
      ('${uuid(10)}', '_system', 'Key', '${uuid(1)}', '_system', 'Invite', '${uuid(3)}', 'invite', 'orphan', now(), NULL),
      ('${uuid(11)}', '_system', 'Key', '${uuid(2)}', '_system', 'Invite', '${uuid(3)}', 'invite', 'orphan', now(), now());
    INSERT INTO embeddings (row_namespace, row_type, row_id, embedding, model, salience)
      VALUES ('_system', 'Invite', '${uuid(3)}', '${vec(0)}', 'm', 0.5);
    INSERT INTO lexical (row_namespace, row_type, row_id, content)
      VALUES ('_system', 'Invite', '${uuid(3)}', 'hello world');
    INSERT INTO recall_clusters (id, centroid, cohesion, label, labelled_by, provenance)
      VALUES ('c1', '${vec(0)}', 0.9, 'one', 'test', '{}'), ('c2', '${vec(1)}', 0.8, 'two', 'test', '{}'),
             ('c3', '${vec(2)}', 0.7, 'three', 'test', '{}');
    DELETE FROM recall_clusters WHERE id = 'c1';
    INSERT INTO recall_cluster_members (id, cluster_id, member_ns, member_type, member_id, origin, similarity)
      VALUES ('m1', 'c2', '_system', 'Invite', '${uuid(3)}', 'formed', 0.95),
             ('m2', 'c3', '_system', 'Key', '${uuid(1)}', 'formed', 0.9);`);
  // A proposed namespace and an applied TypeProposal in it, with rows of the type.
  await sql`
    INSERT INTO rows (namespace, type, id, body) VALUES
      ('_system_proposals', 'NamespaceProposal', ${uuid(30)},
       ${sql.json({ ns: 'prop', applied: true, archived: false, proposedBy: 'op', proposedReason: 'test' })}),
      ('prop', 'TypeProposal', ${uuid(31)},
       ${sql.json({ typeName: 'Note', fieldsJson: JSON.stringify({ title: { kind: 'scalar', type: 'string' } }), applied: true, archived: false, supersededByCode: false })}),
      ('prop', 'Note', ${uuid(32)}, ${sql.json({ title: 'a' })}),
      ('prop', 'Note', ${uuid(33)}, ${sql.json({ title: 'b' })})`;
  await sql`INSERT INTO short_ids (namespace, type, short_id, row_id) VALUES
    ('prop', 'Note', 1, ${uuid(32)}), ('prop', 'Note', 2, ${uuid(33)}), ('prop', 'TypeProposal', 1, ${uuid(31)})`;
}

export interface Pair {
  srcSql: Sql;
  tgtSql: Sql;
  pluginDir: string;
  boot: () => Promise<BootedStore>;
  plan: CopyPlan;
  /** Drops both schemas and closes both connections. */
  close(): Promise<void>;
}

export interface Schemas {
  srcSql: Sql;
  tgtSql: Sql;
  srcSchema: string;
  tgtSchema: string;
  tgtUrl: string;
  pluginDir: string;
  /** Drops both schemas and closes both connections. */
  close(): Promise<void>;
}

/** A seeded source schema in `sourceLayout` beside an empty target schema, nothing prepared. */
export async function openSchemas(
  sourceLayout: StorageLayout,
  /** Session TimeZone per side, to prove a comparison does not depend on it. */
  zones: { src?: string; tgt?: string } = {}
): Promise<Schemas> {
  const tag = randomBytes(4).toString('hex');
  const srcName = `apps/substrate-copy-src-${tag}`;
  const tgtName = `apps/substrate-copy-tgt-${tag}`;
  const srcSchema = pgTestSchemaName(srcName);
  const tgtSchema = pgTestSchemaName(tgtName);
  const tgtUrl = pgTestSchemaUrl(POSTGRES_URL as string, tgtName);
  const srcSql = postgres(pgTestSchemaUrl(POSTGRES_URL as string, srcName), {
    max: 1,
    onnotice: () => {},
    ...(zones.src ? { connection: { TimeZone: zones.src } } : {})
  });
  const tgtSql = postgres(tgtUrl, {
    max: 1,
    onnotice: () => {},
    ...(zones.tgt ? { connection: { TimeZone: zones.tgt } } : {})
  });
  await srcSql.unsafe(`CREATE SCHEMA ${srcSchema}`);
  await tgtSql.unsafe(`CREATE SCHEMA ${tgtSchema}`);
  await runMigrations(srcSql, { layout: sourceLayout });
  await applyRecall(srcSql, sourceLayout);
  await seedSource(srcSql);
  const pluginDir = await makePluginDir();
  return {
    srcSql,
    tgtSql,
    srcSchema,
    tgtSchema,
    tgtUrl,
    pluginDir,
    async close() {
      await rm(pluginDir, { recursive: true, force: true });
      await srcSql.unsafe(`DROP SCHEMA IF EXISTS ${srcSchema} CASCADE`);
      await tgtSql.unsafe(`DROP SCHEMA IF EXISTS ${tgtSchema} CASCADE`);
      await srcSql.end({ timeout: 5 });
      await tgtSql.end({ timeout: 5 });
    }
  };
}

/** A seeded source in `sourceLayout` beside a prepared, empty partitioned target. */
export async function openPair(
  sourceLayout: StorageLayout,
  /** Session TimeZone per side, to prove a comparison does not depend on it. */
  zones: { src?: string; tgt?: string } = {}
): Promise<Pair> {
  const { srcSql, tgtSql, tgtUrl, pluginDir, close } = await openSchemas(sourceLayout, zones);
  const boot = () =>
    bootStore({
      config: parseEnv({
        SUBSTRATE_DATABASE_URL: tgtUrl,
        SUBSTRATE_SYSTEM_ACTOR: 'copy-test',
        SUBSTRATE_INDEX_DISK_PATH: 'off'
      }),
      pluginDir,
      layout: 'partitioned',
      allowMigrating: true
    });
  // Prepare once, so a test can write into the target before the copy boots it again.
  await (await boot()).close();

  const pre = preflight(
    await inspectSource(srcSql),
    {
      serverVersionNum: 180000,
      empty: true,
      createdByUs: false,
      enforceUuidCheck: false,
      recallDims: DIM,
      extensions: { vector: '0.8.0' },
      freeBytes: null
    },
    { skipTables: [], pluginTables: RECALL_TABLES, dryRun: false }
  );
  if (pre.refusals.length > 0)
    throw new Error(`fixture preflight refused: ${pre.refusals.join('; ')}`);
  return { srcSql, tgtSql, pluginDir, boot, plan: pre.plan, close };
}
