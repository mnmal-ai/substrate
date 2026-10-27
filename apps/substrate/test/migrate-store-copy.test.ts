/**
 * migrate-store's copy (pg-gated): a legacy or partitioned source copied into
 * a partitioned target that `bootStore` prepares, with the built-in recall and
 * proposals plugins loaded from a plugin dir as serve loads them. The source
 * gets recall's tables from recall's own migrations.
 */

import { PgShortIdStore } from '@mnmal-ai/substrate-dataset-pg';
import type { Sql } from 'postgres';
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
import type { BootedStore } from '../src/serve/boot-store.js';
import {
  DIM,
  openPair,
  type Pair,
  POSTGRES_URL,
  RECALL_TABLES,
  STORE_PROFILE_ID,
  uuid,
  vec
} from './_fixtures/migrate-store.js';

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
    let pair: Pair;
    let srcSql: Sql;
    let tgtSql: Sql;
    let boot: () => Promise<BootedStore>;
    let targets: BootedStore[];
    let plan: CopyPlan;
    const events: ProgressEvent[] = [];
    const opts = { batchRows: 2, onProgress: (e: ProgressEvent) => void events.push(e) };

    beforeEach(async () => {
      pair = await openPair(sourceLayout);
      ({ srcSql, tgtSql, boot, plan } = pair);
      targets = [];
      events.length = 0;
    });

    afterEach(async () => {
      for (const t of targets) await t.close();
      await pair.close();
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
