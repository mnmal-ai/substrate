/**
 * migrate-store's copy (pg-gated): a legacy or partitioned source copied into
 * a partitioned target that `bootStore` prepares, with the built-in recall and
 * proposals plugins loaded from a plugin dir as serve loads them. The source
 * gets recall's tables from recall's own migrations.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PgShortIdStore, runMigrations, type StorageLayout } from '@mnmal-ai/substrate-dataset-pg';
import { pgTestSchemaName, pgTestSchemaUrl } from '@mnmal-ai/substrate-dataset-pg/testing';
import {
  embeddingsMigration,
  lexicalMigration,
  recallClustersMigration
} from '@mnmal-ai/substrate-recall';
import type { KernelMigrationContext } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CopyOptions,
  type CopyResult,
  copyStore,
  MigrateStoreColumnError,
  PHASE1_ROWS
} from '../src/admin/migrate-store/copy.js';
import { type CopyPlan, preflight } from '../src/admin/migrate-store/preflight.js';
import { type ProgressEvent, RowCounter } from '../src/admin/migrate-store/progress.js';
import { inspectSource } from '../src/admin/migrate-store/source.js';
import { type BootedStore, bootStore } from '../src/serve/boot-store.js';
import { parseEnv } from '../src/serve/config.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const RECALL_TABLES = ['embeddings', 'lexical', 'recall_clusters', 'recall_cluster_members'];
const STORE_PROFILE_ID = '5703e000-0000-4000-8000-000000000001';
/** Recall's default, which the target's recall (no embedder configured) keeps. */
const DIM = 768;

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
/** A DIM-long vector literal with a 1 at `i`. */
const vec = (i: number) =>
  `[${Array.from({ length: DIM }, (_, j) => (j === i ? 1 : 0)).join(',')}]`;

async function applyRecall(sql: Sql, layout: StorageLayout): Promise<void> {
  const ctx = { sql, layout, metric: () => undefined } as KernelMigrationContext;
  for (const m of [embeddingsMigration(), recallClustersMigration(), lexicalMigration()]) {
    await m.apply(ctx);
  }
}

/** A plugin dir that loads this package's built-in plugins, recall and proposals. */
async function makePluginDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'substrate-migrate-plugins-'));
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ dependencies: { '@mnmal-ai/substrate': '*' } })
  );
  await mkdir(join(dir, 'node_modules', '@mnmal-ai'), { recursive: true });
  await symlink(resolve('.'), join(dir, 'node_modules', '@mnmal-ai', 'substrate'));
  return dir;
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
    let pluginDir: string;
    let boot: () => Promise<BootedStore>;
    let targets: BootedStore[];
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

      pluginDir = await makePluginDir();
      targets = [];
      boot = () =>
        bootStore({
          config: parseEnv({ SUBSTRATE_DATABASE_URL: tgtUrl, SUBSTRATE_SYSTEM_ACTOR: 'copy-test' }),
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
      for (const t of targets) await t.close();
      await rm(pluginDir, { recursive: true, force: true });
      await srcSql.unsafe(`DROP SCHEMA IF EXISTS ${srcSchema} CASCADE`);
      await tgtSql.unsafe(`DROP SCHEMA IF EXISTS ${tgtSchema} CASCADE`);
      await srcSql.end({ timeout: 5 });
      await tgtSql.end({ timeout: 5 });
    });

    const copy = async (o: CopyOptions = opts) => {
      const result = await copyStore(srcSql, boot, plan, o);
      targets.push(result.target);
      return result;
    };

    const expectVerbatim = async (result: CopyResult) => {
      const seedIds = result.keptSeeds.map((s) => s.id);
      expect(await dump(tgtSql, plan, seedIds)).toEqual(await dump(srcSql, plan));
    };

    it('copies every row, shortId, edge and recall row verbatim', async () => {
      const result = await copy();
      expect(plan.tables.map((t) => t.name)).toEqual([
        'rows',
        'short_ids',
        'edges',
        'visible_seqs',
        ...RECALL_TABLES
      ]);
      await expectVerbatim(result);
      expect(result.tables.find((t) => t.name === 'rows')?.rows).toBe(11);
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
      await copy();
      const ids = new PgShortIdStore(tgtSql);
      expect(await ids.allocateUnbound('_system', 'Key')).toBe(8);
      expect(await ids.allocateUnbound('retired', 'Old')).toBe(3);
      const [c] = await tgtSql<{ short_id: string }[]>`
        INSERT INTO recall_clusters (id, centroid, cohesion, label, labelled_by, provenance)
        VALUES ('c9', ${vec(3)}, 0.5, 'nine', 'test', '{}') RETURNING short_id`;
      expect(Number(c?.short_id)).toBe(4);
      const [m] = await tgtSql<{ short_id: string }[]>`
        INSERT INTO recall_cluster_members (id, cluster_id, member_ns, member_type, member_id, origin, similarity)
        VALUES ('m9', 'c9', '_system', 'Key', ${uuid(1)}, 'formed', 0.5) RETURNING short_id`;
      expect(Number(m?.short_id)).toBe(3);
    });

    it('replays copied proposals before the rest, so proposed types get their own partitions', async () => {
      const result = await copy();
      const parts = await tgtSql<{ type: string; part: string }[]>`
        SELECT DISTINCT type, tableoid::regclass::text AS part FROM rows WHERE namespace = 'prop' ORDER BY type`;
      expect(parts.map((p) => p.type)).toEqual(['Note', 'TypeProposal']);
      for (const p of parts) expect(p.part).not.toMatch(/default/);
      expect(result.defaulted.filter((d) => d.namespace === 'prop')).toEqual([]);
      expect(result.target.engine.registryFor('prop')?.get('Note')?.kind).toBe('type');
    });

    it('splits rows and shortIds between the phases with no row in both or neither', async () => {
      for (const table of ['rows', 'short_ids']) {
        const [c] = await srcSql.unsafe(`
          SELECT count(*) FILTER (WHERE ${PHASE1_ROWS})::int AS p1,
                 count(*) FILTER (WHERE NOT (${PHASE1_ROWS}))::int AS p2,
                 count(*)::int AS total FROM ${table}`);
        expect(c?.p1).toBeGreaterThan(0);
        expect(c?.p2).toBeGreaterThan(0);
        expect(c?.p1 + c?.p2).toBe(c?.total);
      }
      const result = await copy();
      const [src] = await srcSql<{ n: number }[]>`SELECT count(*)::int AS n FROM rows`;
      expect(result.tables.find((t) => t.name === 'rows')?.rows).toBe(src?.n);
    });

    it('lands an undeclared namespace in rows__default and reports it', async () => {
      const result = await copy();
      expect(result.defaulted).toEqual([{ namespace: 'retired', type: 'Old' }]);
      const [last] = await tgtSql<{ step: string }[]>`
        SELECT step FROM substrate_migrate_store_progress WHERE step LIKE 'copy:phase%' ORDER BY step DESC LIMIT 1`;
      expect(last?.step).toBe('copy:phase2');
      const [row] = await tgtSql<{ part: string }[]>`
        SELECT tableoid::regclass::text AS part FROM rows WHERE namespace = 'retired'`;
      expect(row?.part).toBe('rows__default');
    });

    it('replaces a seeded row with the source row of the same id and keeps seeds the source lacks', async () => {
      await srcSql`INSERT INTO rows (namespace, type, id, body) VALUES ('_system', 'StoreProfile', ${STORE_PROFILE_ID}, '{"profile":"source"}')`;
      await tgtSql`INSERT INTO rows (namespace, type, id, body) VALUES ('_system', 'AdvisorState', ${uuid(20)}, '{}')`;
      const result = await copy();
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
      const err = await copy().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MigrateStoreColumnError);
      expect(err).toMatchObject({ table: 'lexical', column: 'extra' });
      expect(await tgtSql`SELECT id FROM rows`).toEqual([{ id: STORE_PROFILE_ID }]);
    });

    it('fails loudly, naming the table and key, when the target rejects a row', async () => {
      await tgtSql`INSERT INTO edges (id, from_ns, from_type, from_id, to_ns, to_type, to_id, field_name, policy, created_at)
        VALUES (${uuid(10)}, 'a', 'T', 'x', 'a', 'T', 'y', 'f', 'orphan', now())`;
      await expect(copy()).rejects.toThrow(/copying edges failed: .*duplicate key.*\(id\)=/);
    });

    it('a close after a re-boot returns promptly and leaves no index build running', async () => {
      await tgtSql`
        INSERT INTO rows (namespace, type, id, body) VALUES
          ('_system_proposals', 'NamespaceProposal', ${uuid(40)},
           ${tgtSql.json({ ns: 'prop', applied: true, archived: false, proposedBy: 'op', proposedReason: 'test' })}),
          ('prop', 'TypeProposal', ${uuid(41)},
           ${tgtSql.json({ typeName: 'Note', fieldsJson: JSON.stringify({ title: { kind: 'scalar', type: 'string' } }), applied: true, archived: false, supersededByCode: false })})`;
      const running = () => tgtSql<{ query: string }[]>`
        SELECT query FROM pg_stat_activity
        WHERE pid <> pg_backend_pid() AND state <> 'idle' AND query ILIKE '%prop%note%'
          AND (query ILIKE '%CREATE INDEX CONCURRENTLY%' OR query ILIKE '%COMMENT ON INDEX%')`;
      // An open transaction blocks the replay's background builds (CONCURRENTLY waits for it).
      const blocker = await srcSql.reserve();
      try {
        await blocker`BEGIN`;
        await blocker`SELECT txid_current()`;
        const booted = await boot();
        await vi.waitFor(async () => expect(await running()).not.toEqual([]), { timeout: 10_000 });
        const start = performance.now();
        await booted.close();
        // Stop aborts the blocked build instead of waiting on it.
        expect(performance.now() - start).toBeLessThan(5_000);
        for (let i = 0; i < 10; i++) {
          expect(await running()).toEqual([]);
          await new Promise((r) => setTimeout(r, 100));
        }
      } finally {
        await blocker`ROLLBACK`;
        blocker.release();
      }
      // A later reconcile rebuilds what the abort left INVALID or unbuilt.
      const again = await boot();
      await again.datasets.get('prop')?.ensureTypeStorage?.('Note');
      await again.close();
      const built = await tgtSql<{ name: string; valid: boolean }[]>`
        SELECT c.relname AS name, i.indisvalid AS valid
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname LIKE 'rows_prop_note_%' ORDER BY 1`;
      expect(built.map((b) => b.name.replace(/_[0-9a-f]{8}_base$/, ''))).toEqual([
        'rows_prop_note_created_at',
        'rows_prop_note_deleted_at',
        'rows_prop_note_updated_at'
      ]);
      expect(built.every((b) => b.valid)).toBe(true);
    });

    it('fails loudly on a source duplicate under a unique index instead of defaulting it', async () => {
      // Proposed indexes are never unique, so the duplicate is two live _system Keys with one kid.
      await srcSql`DROP INDEX substrate_key_live_kid_uniq`;
      await srcSql`UPDATE rows SET deleted_at = NULL WHERE id = ${uuid(2)}`;
      await srcSql`UPDATE rows SET body = ${srcSql.json({ kid: 'a@h', grants: ['x'] })} WHERE id = ${uuid(2)}`;
      await expect(copy()).rejects.toThrow(
        /copying rows failed: .*duplicate key.*\(\(body ->> 'kid'::text\)\)=\(a@h\)/
      );
    });

    it('fails the copy, naming the type, when storage for a registered type cannot be prepared', async () => {
      let boots = 0;
      const failing = async () => {
        const b = await boot();
        if (++boots === 2) {
          const ds = b.datasets.get('prop') as { ensureTypeStorage?: unknown };
          ds.ensureTypeStorage = async () => {
            throw new Error('lock wait timed out');
          };
        }
        return b;
      };
      await expect(copyStore(srcSql, failing, plan, opts)).rejects.toThrow(
        /preparing storage for prop\/Note failed: lock wait timed out/
      );
    });

    it('refuses a re-boot that writes rows, naming them and what to do', async () => {
      await srcSql`DELETE FROM rows WHERE id = ${uuid(7)}`;
      const err = await copy().catch((e: unknown) => e as Error);
      expect(await tgtSql`SELECT to_regclass('substrate_migrate_store_reboot_rows') AS r`).toEqual([
        { r: null }
      ]);
      expect((err as Error).message).toMatch(/added: _system\/AuditEvent\/[0-9a-f-]+/);
      expect((err as Error).message).toContain('substrate serve');
    });

    it('a rerun after a crash between the phases gives a verbatim result', async () => {
      let boots = 0;
      const crashing = async () => {
        if (++boots === 2) throw new Error('crashed between phases');
        return boot();
      };
      await expect(copyStore(srcSql, crashing, plan, opts)).rejects.toThrow(
        'crashed between phases'
      );
      const result = await copy();
      expect(result.keptSeeds).toEqual([
        { namespace: '_system', type: 'StoreProfile', id: STORE_PROFILE_ID }
      ]);
      await expectVerbatim(result);
    });

    it('a rerun after an interrupted copy restarts cleanly', async () => {
      const abort = {
        batchRows: 2,
        onProgress: (e: ProgressEvent) => {
          if (e.table === 'rows' && e.done) throw new Error('interrupted');
        }
      };
      await expect(copy(abort)).rejects.toThrow('interrupted');
      expect(Number((await tgtSql`SELECT count(*) AS n FROM rows`)[0]?.n)).toBe(12);

      const result = await copy();
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

describe('RowCounter', () => {
  it('refuses a batchRows that is not a positive integer', () => {
    for (const n of [0, 1.5]) {
      expect(() => new RowCounter('rows', n, () => undefined)).toThrow(/positive integer/);
    }
  });
});
