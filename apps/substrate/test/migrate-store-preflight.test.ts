/**
 * migrate-store source inspection (pg-gated) and the pure preflight refusals.
 * The pg suite is skipped unless POSTGRES_URL is set.
 */

import { randomBytes } from 'node:crypto';
import { runMigrations } from '@mnmal-ai/substrate-dataset-pg';
import { pgTestSchemaName, pgTestSchemaUrl } from '@mnmal-ai/substrate-dataset-pg/testing';
import postgres, { type Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type PreflightOptions,
  preflight,
  type TargetFacts
} from '../src/admin/migrate-store/preflight.js';
import { inspectSource, type SourceInventory } from '../src/admin/migrate-store/source.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('inspectSource (pg)', () => {
  let schema: string;
  let sql: Sql;

  beforeEach(async () => {
    const name = `apps/substrate-migrate-src-${randomBytes(4).toString('hex')}`;
    schema = pgTestSchemaName(name);
    sql = postgres(pgTestSchemaUrl(POSTGRES_URL as string, name), { max: 1, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await runMigrations(sql, { layout: 'legacy' });
    await sql.unsafe(`
      INSERT INTO rows (namespace, type, id, body, deleted_at) VALUES
        ('a', 'T1', '11111111-1111-4111-8111-111111111111', '{}', NULL),
        ('a', 'T1', '22222222-2222-4222-8222-222222222222', '{}', now()),
        ('a', 'T2', '33333333-3333-4333-8333-333333333333', '{}', NULL);
      CREATE TABLE foo (x int)`);
  });

  afterEach(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await sql.end({ timeout: 5 });
  });

  const counters = async () => {
    await sql`SELECT pg_stat_force_next_flush()`;
    return sql`SELECT relname, n_tup_ins, n_tup_upd, n_tup_del FROM pg_stat_user_tables
               WHERE schemaname = current_schema() ORDER BY relname`;
  };

  it('inventories a legacy source without writing to it', async () => {
    const before = await counters();
    const rels = async () =>
      (
        await sql`SELECT relname FROM pg_class WHERE relnamespace = current_schema()::regnamespace ORDER BY relname`
      ).map((r) => r.relname);
    const relsBefore = await rels();
    const inv = await inspectSource(sql);
    expect(inv.layout).toBe('legacy');
    expect(inv.serverVersionNum).toBeGreaterThanOrEqual(170000);
    expect(inv.hasSeq).toBe(true);
    expect(inv.hasVisibleSeqs).toBe(true);
    expect(inv.appliedMigrations).toContain('0004_visible_seq');
    expect(inv.types.map((t) => [t.namespace, t.type, t.live, t.deleted])).toEqual([
      ['a', 'T1', 1, 1],
      ['a', 'T2', 1, 0]
    ]);
    expect(inv.tables).toContain('foo');
    expect(inv.columns.rows).toContain('body');
    expect(inv.nonUuidIds).toEqual([]);
    expect(inv.vectorDims).toBeNull();
    expect(await counters()).toEqual(before);
    expect(await rels()).toEqual(relsBefore);
  });

  it('accepts an alpha.9-level source', async () => {
    await sql.unsafe(`
      ALTER TABLE rows DROP COLUMN seq;
      DROP TABLE visible_seqs;
      DELETE FROM migrations WHERE version = '0004_visible_seq'`);
    const inv = await inspectSource(sql);
    expect(inv.hasSeq).toBe(false);
    expect(inv.hasVisibleSeqs).toBe(false);
    const res = preflight(inv, target(), { ...opts, skipTables: ['foo'] });
    expect(res.refusals).toEqual([]);
  });

  it('reads the recall dimension from the embedding column', async () => {
    await sql.unsafe('CREATE TABLE embeddings (id int, embedding vector(768))');
    expect((await inspectSource(sql)).vectorDims).toBe(768);
  });

  it('finds a non-UUID edge to_id and refuses it under the UUID check', async () => {
    await sql.unsafe(`INSERT INTO edges (id, from_ns, from_type, from_id, to_ns, to_type, to_id, field_name, policy, created_at)
      VALUES ('44444444-4444-4444-8444-444444444444', 'a', 'T1', '11111111-1111-4111-8111-111111111111', 'a', 'T2', 'bad-to', 'f', 'orphan', now())`);
    const inv = await inspectSource(sql);
    expect(inv.nonUuidIds).toEqual([
      { table: 'edges', column: 'to_id', namespace: 'a', type: 'T2', id: 'bad-to' }
    ]);
    const res = preflight(inv, target({ enforceUuidCheck: true }), {
      ...opts,
      skipTables: ['foo']
    });
    expect(res.refusals.join()).toContain('edges.to_id=bad-to');
  });

  it('lists non-UUID ids', async () => {
    await sql.unsafe(
      `INSERT INTO rows (namespace, type, id, body) VALUES ('a', 'T1', 'not-a-uuid', '{}')`
    );
    expect((await inspectSource(sql)).nonUuidIds).toEqual([
      { table: 'rows', column: 'id', namespace: 'a', type: 'T1', id: 'not-a-uuid' }
    ]);
  });
});

const opts: PreflightOptions = { skipTables: [], pluginTables: [], dryRun: false };

function target(over: Partial<TargetFacts> = {}): TargetFacts {
  return {
    serverVersionNum: 180000,
    empty: true,
    createdByUs: false,
    enforceUuidCheck: false,
    recallDims: null,
    extensions: { vector: '0.8.0' },
    freeBytes: null,
    ...over
  };
}

function source(over: Partial<SourceInventory> = {}): SourceInventory {
  return {
    serverVersionNum: 170000,
    layout: 'legacy',
    appliedMigrations: ['0001_baseline', '0003_safe_casts', '0004_visible_seq'],
    hasSeq: true,
    hasVisibleSeqs: true,
    types: [],
    tables: ['rows', 'edges', 'short_ids', 'migrations'],
    columns: { rows: ['namespace', 'type', 'id', 'body'], edges: ['id'], short_ids: ['namespace'] },
    tableBytes: { rows: 100, edges: 10, short_ids: 10 },
    nonUuidIds: [],
    vectorDims: null,
    extensions: {},
    otherSessions: 0,
    ...over
  };
}

describe.skipIf(!POSTGRES_URL)('inspectSource, partitioned source (pg)', () => {
  let schema: string;
  let sql: Sql;

  beforeEach(async () => {
    const name = `apps/substrate-migrate-psrc-${randomBytes(4).toString('hex')}`;
    schema = pgTestSchemaName(name);
    sql = postgres(pgTestSchemaUrl(POSTGRES_URL as string, name), { max: 1, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await runMigrations(sql, { layout: 'partitioned' });
    await sql.unsafe(`
      INSERT INTO rows (namespace, type, id, body, deleted_at) VALUES
        ('a', 'T1', '11111111-1111-4111-8111-111111111111', '{}', NULL),
        ('a', 'T1', '22222222-2222-4222-8222-222222222222', '{}', now()),
        ('a', 'T2', '33333333-3333-4333-8333-333333333333', '{}', NULL),
        ('_system', 'Key', '55555555-5555-4555-8555-555555555555', '{"kid":"k"}', NULL),
        ('retired', 'Old', '66666666-6666-4666-8666-666666666666', '{}', NULL)`);
  });

  afterEach(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await sql.end({ timeout: 5 });
  });

  it('inventories partitions as part of rows and passes preflight', async () => {
    const inv = await inspectSource(sql);
    expect(inv.layout).toBe('partitioned');
    expect(inv.tables.filter((t) => t.startsWith('rows__'))).toEqual([]);
    expect(inv.tables).toContain('rows');
    expect(inv.tableBytes.rows).toBeGreaterThan(0);
    expect(inv.appliedMigrations).toContain('0001p_partitioned_baseline');
    expect(inv.types.map((t) => [t.namespace, t.type, t.live, t.deleted]).sort()).toEqual([
      ['_system', 'Key', 1, 0],
      ['a', 'T1', 1, 1],
      ['a', 'T2', 1, 0],
      ['retired', 'Old', 1, 0]
    ]);
    expect(preflight(inv, target(), opts).refusals).toEqual([]);
  });
});

describe('preflight', () => {
  it('ignores derived ledger versions', () => {
    const src = source({ appliedMigrations: ['0001_baseline', 'list-gin:a:T:f'] });
    expect(preflight(src, target(), opts).refusals).toEqual([]);
  });

  it('refuses a ledger baseline that disagrees with the detected layout', () => {
    const src = source({ layout: 'partitioned' });
    expect(preflight(src, target(), opts).refusals.join()).toContain('rows is partitioned');
  });

  it('passes a clean source and plans engine tables in order with columns', () => {
    const res = preflight(source(), target(), opts);
    expect(res.refusals).toEqual([]);
    expect(res.plan.tables.map((t) => t.name)).toEqual(['rows', 'short_ids', 'edges']);
    expect(res.plan.tables[0]?.columns).toEqual(['namespace', 'type', 'id', 'body']);
  });

  it('refuses a non-empty target not created by us, but allows our own', () => {
    expect(preflight(source(), target({ empty: false }), opts).refusals).toHaveLength(1);
    expect(preflight(source(), target({ empty: false, createdByUs: true }), opts).refusals).toEqual(
      []
    );
  });

  it('refuses an unknown table until --skip-table names it', () => {
    const src = source({ tables: ['rows', 'foo'] });
    expect(preflight(src, target(), opts).refusals.join()).toContain('"foo"');
    const res = preflight(src, target(), { ...opts, skipTables: ['foo'] });
    expect(res.refusals).toEqual([]);
    expect(res.plan.skipped).toEqual(['foo']);
  });

  it('accepts a plugin-declared table and copies it after the engine tables', () => {
    const res = preflight(source({ tables: ['rows', 'embeddings'] }), target(), {
      ...opts,
      pluginTables: ['embeddings']
    });
    expect(res.refusals).toEqual([]);
    expect(res.plan.tables.map((t) => t.name)).toEqual(['rows', 'embeddings']);
  });

  it('refuses non-UUID ids only when the check is on', () => {
    const src = source({
      nonUuidIds: [{ table: 'rows', column: 'id', namespace: 'a', type: 'T', id: 'x' }]
    });
    expect(preflight(src, target(), opts).refusals).toEqual([]);
    expect(preflight(src, target({ enforceUuidCheck: true }), opts).refusals.join()).toContain(
      'rows.id=x'
    );
  });

  it('refuses differing recall dimensions naming both', () => {
    const msg = preflight(
      source({ vectorDims: 768 }),
      target({ recallDims: 384 }),
      opts
    ).refusals.join();
    expect(msg).toContain('768');
    expect(msg).toContain('384');
  });

  it('refuses a source below PG 17 and a target below PG 18', () => {
    expect(
      preflight(source({ serverVersionNum: 160000 }), target(), opts).refusals.join()
    ).toContain('160000');
    expect(
      preflight(source(), target({ serverVersionNum: 170000 }), opts).refusals.join()
    ).toContain('target');
  });

  it('refuses an unknown ledger entry or a missing baseline', () => {
    expect(
      preflight(
        source({ appliedMigrations: ['0001_baseline', '9999_x'] }),
        target(),
        opts
      ).refusals.join()
    ).toContain('9999_x');
    expect(
      preflight(source({ appliedMigrations: ['0003_safe_casts'] }), target(), opts).refusals.join()
    ).toContain('lacks');
  });

  it('refuses a copied table whose extension is not installed in the target database', () => {
    // pg_available_extensions listing it is not enough: the target role cannot CREATE EXTENSION.
    const res = preflight(source({ tables: ['rows', 'embeddings'] }), target({ extensions: {} }), {
      ...opts,
      pluginTables: ['embeddings']
    });
    expect(res.refusals.join()).toContain(
      'run CREATE EXTENSION vector; in the target database as a superuser'
    );
  });

  it("warns, naming both versions, when a copied table's extension differs in version", () => {
    const tables = { tables: ['rows', 'embeddings'] };
    const o = { ...opts, pluginTables: ['embeddings'] };
    const res = preflight(
      source({ ...tables, extensions: { vector: '0.7.4' } }),
      target({ extensions: { vector: '0.8.0' } }),
      o
    );
    expect(res.refusals).toEqual([]);
    expect(res.warnings.join()).toMatch(
      /"vector" is version 0\.7\.4 on the source and 0\.8\.0 on the target.*embeddings/
    );
    const same = { extensions: { vector: '0.8.0' } };
    expect(preflight(source({ ...tables, ...same }), target(same), o).warnings).toEqual([]);
  });

  it('treats a disk shortfall as a refusal in a real run and a warning in a dry run', () => {
    const t = target({ freeBytes: 1 });
    expect(preflight(source(), t, opts).refusals.join()).toContain('free disk');
    const dry = preflight(source(), t, { ...opts, dryRun: true });
    expect(dry.refusals).toEqual([]);
    expect(dry.warnings.join()).toContain('free disk');
  });

  it('warns about other sessions', () => {
    expect(preflight(source({ otherSessions: 2 }), target(), opts).warnings.join()).toContain(
      '2 other'
    );
  });
});
