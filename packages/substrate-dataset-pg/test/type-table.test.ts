/**
 * The `tables` layout's skeleton: its baseline, the type catalog, and the DDL
 * `ensureTypeTable` runs. The name and kind checks need no database.
 */

import { randomBytes } from 'node:crypto';
import { field, RESERVED_AUTOCRUD_FIELDS } from '@mnmal-ai/substrate-sdk';
import { type FieldDef, isColumnField } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectLayout, runMigrations, UUID_CHECK_MIGRATION, UUID_REGEX } from '../src/index.js';
import { columnName, MAX_IDENTIFIER, typeTableName } from '../src/layout.js';
import {
  columnKindOf,
  ensureTypeTable,
  FieldKindChangedError,
  loadTypeTable
} from '../src/type-table.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = `tt_${randomBytes(4).toString('hex')}`;

const EVERY_KIND: Record<string, FieldDef> = {
  text: field.string(),
  enum: field.enum(['a', 'b']),
  number: field.number(),
  date: field.date(),
  boolean: field.boolean(),
  crossRef: field.crossRef(NS, 'Other'),
  json: field.json(),
  list: field.list(field.string()),
  struct: field.struct({ street: field.string() }),
  readonlyNumber: field.number({ readonly: true }),
  shortId: RESERVED_AUTOCRUD_FIELDS.shortId as FieldDef
};

describe('columnKindOf', () => {
  it('columnKindOf and isColumnField agree on every FieldDef kind, shortId included', () => {
    for (const [name, def] of Object.entries(EVERY_KIND)) {
      expect(columnKindOf(def) !== undefined, name).toBe(isColumnField(def));
    }
    expect(columnKindOf(EVERY_KIND.shortId as FieldDef)).toBeUndefined();
    expect(
      Object.fromEntries(Object.entries(EVERY_KIND).map(([k, d]) => [k, columnKindOf(d)]))
    ).toEqual({
      text: 'text',
      enum: 'enum',
      number: 'number',
      date: 'date',
      boolean: 'boolean',
      crossRef: 'crossRef',
      json: undefined,
      list: undefined,
      struct: undefined,
      readonlyNumber: undefined,
      shortId: undefined
    });
  });
});

describe('type table names', () => {
  it('names fold and hash', () => {
    expect(typeTableName('cortext', 'todo')).toBe('t__cortext__todo');
    const weird = typeTableName('ns', 'Weird-Name');
    expect(weird).toMatch(/^t__ns__weird_name_[0-9a-f]{8}$/);
    expect(weird).not.toBe(typeTableName('ns', 'weird_name'));
    expect(weird).not.toBe(typeTableName('ns', 'Weird_Name'));
    const long = typeTableName('n'.repeat(60), 't'.repeat(60));
    expect(long.length).toBeLessThanOrEqual(MAX_IDENTIFIER);
    expect(long).not.toBe(typeTableName('n'.repeat(60), 'u'.repeat(60)));
    expect(columnName('title')).toBe('f_title');
    expect(columnName('observedAt')).toMatch(/^f_observedat_[0-9a-f]{8}$/);
    expect(columnName('observedAt')).not.toBe(columnName('observedat'));
  });

  it('UUID_REGEX and UUID_CHECK_MIGRATION are still exported from the package root', () => {
    expect(UUID_REGEX).toBe('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
    expect(UUID_CHECK_MIGRATION).toBe('0002_uuid_format_check');
  });
});

/** A throwaway schema on one connection, so a `SET search_path` reaches every query. */
async function withFreshSchema(fn: (sql: Sql) => Promise<void>): Promise<void> {
  const schema = `substrate_tt_${randomBytes(4).toString('hex')}`;
  const sql = postgres(POSTGRES_URL as string, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.unsafe(`SET search_path TO ${schema}`);
    await fn(sql);
  } finally {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await sql.end({ timeout: 5 });
  }
}

describe.skipIf(!POSTGRES_URL)('tables layout', () => {
  let sql: Sql;
  let seq = 0;
  /** A type name no other test uses. */
  const freshType = (): string => `T${++seq}`;

  beforeAll(() => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  const ensure = (
    type: string,
    fields: Record<string, FieldDef>,
    newFields: 'column' | 'pending' = 'column',
    handle: Parameters<typeof ensureTypeTable>[0] = sql
  ) => ensureTypeTable(handle, { namespace: NS, type, fields, newFields, enforceUuidCheck: false });

  async function tableOf(type: string, ns = NS): Promise<string> {
    const [row] = await sql<Array<{ table_name: string }>>`
      SELECT table_name FROM substrate_type_tables WHERE namespace = ${ns} AND type = ${type}`;
    if (row === undefined) throw new Error(`no type table for ${type}`);
    return row.table_name;
  }

  async function columnsOf(
    type: string
  ): Promise<Record<string, { type: string; collation: string | null }>> {
    const rows = await sql<
      Array<{ column_name: string; data_type: string; collation_name: string | null }>
    >`
      SELECT column_name, data_type, collation_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ${await tableOf(type)}`;
    return Object.fromEntries(
      rows.map((r) => [r.column_name, { type: r.data_type, collation: r.collation_name }])
    );
  }

  /** A second session holding ACCESS SHARE on `type`'s table until `release` runs. */
  async function holdAccessShare(type: string): Promise<() => Promise<void>> {
    const other = postgres(POSTGRES_URL as string, { max: 1, onnotice: () => {} });
    const conn = await other.reserve();
    await conn.unsafe('BEGIN');
    await conn.unsafe(`LOCK TABLE "${await tableOf(type)}" IN ACCESS SHARE MODE`);
    return async () => {
      await conn.unsafe('ROLLBACK');
      conn.release();
      await other.end({ timeout: 5 });
    };
  }

  it('fresh store gets the tables baseline and no rows', async () => {
    await withFreshSchema(async (s) => {
      await runMigrations(s);
      expect(await detectLayout(s)).toBe('tables');
      const versions = await s<Array<{ version: string }>>`SELECT version FROM migrations`;
      expect(versions.map((v) => v.version)).toEqual([
        '0001t_tables_baseline',
        '0003t_type_table_version',
        '0004t_field_error_version'
      ]);
      const [present] = await s<Array<Record<string, boolean>>>`
        SELECT to_regclass('rows') IS NOT NULL AS rows,
          to_regclass('row_ids') IS NOT NULL AS row_ids,
          to_regclass('short_ids') IS NOT NULL AS short_ids,
          to_regclass('edges') IS NOT NULL AS edges,
          to_regclass('idempotency') IS NOT NULL AS idempotency,
          to_regclass('visible_seqs') IS NOT NULL AS visible_seqs,
          to_regclass('substrate_type_tables') IS NOT NULL AS type_tables,
          to_regclass('substrate_type_fields') IS NOT NULL AS type_fields,
          to_regprocedure('substrate_num(jsonb)') IS NOT NULL AS num,
          to_regprocedure('substrate_ts(jsonb)') IS NOT NULL AS ts`;
      expect(present).toEqual({
        rows: false,
        row_ids: true,
        short_ids: true,
        edges: true,
        idempotency: true,
        visible_seqs: true,
        type_tables: true,
        type_fields: true,
        num: true,
        ts: true
      });
      // short_ids reference row_ids and cascade.
      await s`INSERT INTO row_ids (namespace, type, id) VALUES ('n', 'T', 'r1')`;
      await s`INSERT INTO short_ids (namespace, type, short_id, row_id) VALUES ('n', 'T', 1, 'r1')`;
      await expect(
        s`INSERT INTO short_ids (namespace, type, short_id, row_id) VALUES ('n', 'T', 2, 'nope')`
      ).rejects.toMatchObject({ code: '23503' });
      await s`DELETE FROM row_ids WHERE id = 'r1'`;
      expect(await s`SELECT 1 FROM short_ids`).toHaveLength(0);
    });
  });

  const UUID = '00000000-0000-4000-8000-000000000001';

  /** Asserts the UUID CHECKs reject a non-UUID id in row_ids, short_ids and edges. */
  async function expectUuidChecks(s: Sql): Promise<void> {
    await s`INSERT INTO row_ids (namespace, type, id) VALUES ('n', 'T', ${UUID})`;
    await expect(
      s`INSERT INTO row_ids (namespace, type, id) VALUES ('n', 'T', 'not-a-uuid')`
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      s`INSERT INTO short_ids (namespace, type, short_id, row_id) VALUES ('n', 'T', 1, 'not-a-uuid')`
    ).rejects.toMatchObject({ code: '23514' });
    const edge = (from: string, to: string) => s`
      INSERT INTO edges (id, from_ns, from_type, from_id, to_ns, to_type, to_id, field_name, policy, created_at)
      VALUES (gen_random_uuid(), 'n', 'T', ${from}, 'n', 'T', ${to}, 'f', 'orphan', now())`;
    await expect(edge('not-a-uuid', UUID)).rejects.toMatchObject({ code: '23514' });
    await expect(edge(UUID, 'not-a-uuid')).rejects.toMatchObject({ code: '23514' });
    await edge(UUID, UUID);
  }

  const ledger = async (s: Sql) =>
    (await s<Array<{ version: string }>>`SELECT version FROM migrations ORDER BY version`).map(
      (v) => v.version
    );

  it('enforceUuidCheck: the tables layout rejects a non-UUID id in row_ids, short_ids and edges', async () => {
    await withFreshSchema(async (s) => {
      await runMigrations(s, { enforceUuidCheck: true });
      expect(await ledger(s)).toEqual([
        '0001t_tables_baseline',
        UUID_CHECK_MIGRATION,
        '0003t_type_table_version',
        '0004t_field_error_version'
      ]);
      await expectUuidChecks(s);
    });
  });

  it('enforceUuidCheck turned on later: the CHECKs reach row_ids, short_ids, edges and existing type tables, and reboots rehash nothing', async () => {
    await withFreshSchema(async (s) => {
      await runMigrations(s, { enforceUuidCheck: false });
      const args = {
        namespace: 'n',
        fields: { title: field.string() },
        newFields: 'column' as const
      };
      await ensureTypeTable(s, { ...args, type: 'Before', enforceUuidCheck: false });
      expect(await ledger(s)).toEqual([
        '0001t_tables_baseline',
        '0003t_type_table_version',
        '0004t_field_error_version'
      ]);

      await runMigrations(s, { enforceUuidCheck: true });
      expect(await ledger(s)).toEqual([
        '0001t_tables_baseline',
        UUID_CHECK_MIGRATION,
        '0003t_type_table_version',
        '0004t_field_error_version'
      ]);
      await expectUuidChecks(s);
      const [before] = await s<Array<{ table_name: string }>>`
        SELECT table_name FROM substrate_type_tables WHERE type = 'Before'`;
      await expect(
        s.unsafe(`INSERT INTO "${before?.table_name}" (id) VALUES ('not-a-uuid')`)
      ).rejects.toMatchObject({ code: '23514' });

      // As on the old layouts, the gate going off again keeps the CHECKs and rehashes nothing.
      await runMigrations(s, { enforceUuidCheck: true });
      await runMigrations(s, { enforceUuidCheck: false });
      expect(await s`SELECT 1 FROM migrations_audit`).toHaveLength(0);
    });
  });

  it("enforceUuidCheck: a type table's id gets the UUID CHECK", async () => {
    const type = freshType();
    await ensureTypeTable(sql, {
      namespace: NS,
      type,
      fields: { title: field.string() },
      newFields: 'column',
      enforceUuidCheck: true
    });
    const table = await tableOf(type);
    await sql.unsafe(`INSERT INTO "${table}" (id) VALUES ('${UUID}')`);
    await expect(
      sql.unsafe(`INSERT INTO "${table}" (id) VALUES ('not-a-uuid')`)
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('ensureTypeTable creates one column per scalar/crossRef with the mapped pg types', async () => {
    const type = freshType();
    const notified: string[] = [];
    const listener = await sql.listen('substrate_catalog', (p) => notified.push(p));
    const change = await ensure(type, {
      title: field.string(),
      status: field.enum(['open', 'closed']),
      price: field.number(),
      observedAt: field.date(),
      done: field.boolean(),
      ref: field.crossRef(NS, 'Other')
    });
    expect(change).toEqual({ created: true, added: [], pending: [], orphaned: [] });

    const cols = await columnsOf(type);
    const text = { type: 'text', collation: 'C' };
    expect(cols[columnName('title')]).toEqual(text);
    expect(cols[columnName('status')]).toEqual(text);
    // A crossRef column has `id`'s collation, so a walk joins the two bare.
    expect(cols[columnName('ref')]).toEqual(cols.id);
    expect(cols.id?.collation).not.toBe('C');
    expect(cols[columnName('price')]).toEqual({ type: 'double precision', collation: null });
    expect(cols[columnName('observedAt')]).toEqual({
      type: 'timestamp with time zone',
      collation: null
    });
    expect(cols[columnName('done')]).toEqual({ type: 'boolean', collation: null });
    expect(cols.extra).toEqual({ type: 'jsonb', collation: null });
    expect(cols.seq).toEqual({ type: 'bigint', collation: null });
    for (const meta of ['id', 'deleted_at', 'created_at', 'updated_at', 'created_by_kind']) {
      expect(cols[meta], meta).toBeDefined();
    }
    expect(Object.keys(cols)).toHaveLength(16);

    const table = await tableOf(type);
    await expect(
      sql.unsafe(`INSERT INTO "${table}" (id, "${columnName('status')}") VALUES ('x', 'bogus')`)
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql.unsafe(`INSERT INTO "${table}" (id, created_by_kind) VALUES ('x', 'robot')`)
    ).rejects.toMatchObject({ code: '23514' });

    const loaded = await loadTypeTable(sql, NS, type);
    expect(loaded?.from).toBe(`"${table}"`);
    expect(loaded?.jsonb).toBe('extra');
    expect(loaded?.column('status')).toEqual({
      field: 'status',
      column: columnName('status'),
      kind: 'enum',
      state: 'column',
      vocab: ['open', 'closed']
    });
    expect(loaded?.columns().map((c) => c.field)).toHaveLength(6);
    expect(loaded?.pending).toEqual([]);
    await listener.unlisten();
    expect(notified).toContain(`${NS}/${type}`);
  });

  it('json/list/struct/shortId get no column', async () => {
    const type = freshType();
    await ensure(type, {
      title: field.string(),
      meta: field.json(),
      tags: field.list(field.string()),
      addr: field.struct({ street: field.string() }),
      shortId: RESERVED_AUTOCRUD_FIELDS.shortId as FieldDef
    });
    const cols = Object.keys(await columnsOf(type));
    expect(cols.filter((c) => c.startsWith('f_'))).toEqual([columnName('title')]);
    expect((await loadTypeTable(sql, NS, type))?.columns().map((c) => c.field)).toEqual(['title']);
  });

  it("newFields:'pending' records pending, no column", async () => {
    const type = freshType();
    await ensure(type, { title: field.string() });
    const change = await ensure(type, { title: field.string(), n: field.number() }, 'pending');
    expect(change).toEqual({ created: false, added: [], pending: ['n'], orphaned: [] });
    expect((await columnsOf(type))[columnName('n')]).toBeUndefined();
    const loaded = await loadTypeTable(sql, NS, type);
    expect(loaded?.pending).toEqual(['n']);
    expect(loaded?.column('n')).toBeUndefined();
    // A second boot with the same fields changes nothing.
    expect(await ensure(type, { title: field.string(), n: field.number() }, 'pending')).toEqual({
      created: false,
      added: [],
      pending: [],
      orphaned: []
    });
  });

  it('createOnly creates a missing table, and changes nothing on an existing one', async () => {
    const type = freshType();
    const only = (fields: Record<string, FieldDef>) =>
      ensureTypeTable(sql, {
        namespace: NS,
        type,
        fields,
        newFields: 'column',
        enforceUuidCheck: false,
        createOnly: true
      });
    expect((await only({})).created).toBe(true);
    await ensure(type, { title: field.string() });
    expect(await only({})).toEqual({ created: false, added: [], pending: [], orphaned: [] });
    // Added after the CREATE, so promoting; createOnly left it so, not orphaned.
    expect((await loadTypeTable(sql, NS, type))?.column('title')?.state).toBe('promoting');
  });

  it("newFields:'column' adds the column, recorded promoting even on an empty table", async () => {
    const type = freshType();
    await ensure(type, { title: field.string() });
    const change = await ensure(type, { title: field.string(), n: field.number() });
    expect(change).toEqual({ created: false, added: ['n'], pending: [], orphaned: [] });
    expect((await columnsOf(type))[columnName('n')]).toEqual({
      type: 'double precision',
      collation: null
    });
    // A writer whose cached table predates the column puts `n` in `extra`;
    // promoting keeps it readable until the sweep (Task 13).
    expect((await loadTypeTable(sql, NS, type))?.column('n')?.state).toBe('promoting');
  });

  it('a field declared on a table that has rows starts promoting too', async () => {
    const type = freshType();
    await ensure(type, { title: field.string() });
    await sql.unsafe(`INSERT INTO "${await tableOf(type)}" (id, extra) VALUES ('a', '{"n": 2}')`);
    await ensure(type, { title: field.string(), n: field.number() });
    expect((await loadTypeTable(sql, NS, type))?.column('n')?.state).toBe('promoting');
  });

  it('held ACCESS SHARE lock: ADD COLUMN gives up within 4 s and records pending', async () => {
    const type = freshType();
    await ensure(type, { title: field.string() });
    // Released only after the assertions, so a hang still fails the test.
    const release = await holdAccessShare(type);
    try {
      const started = Date.now();
      const change = await ensure(type, { title: field.string(), late: field.boolean() });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(4000);
      expect(change).toEqual({ created: false, added: [], pending: ['late'], orphaned: [] });
    } finally {
      await release();
    }
    expect((await columnsOf(type))[columnName('late')]).toBeUndefined();
    expect((await loadTypeTable(sql, NS, type))?.pending).toEqual(['late']);
  });

  it("removed field → orphaned, column kept; the TypedColumn has state 'orphaned'", async () => {
    const type = freshType();
    await ensure(type, { a: field.string(), b: field.number() });
    const change = await ensure(type, { a: field.string() });
    expect(change).toEqual({ created: false, added: [], pending: [], orphaned: ['b'] });
    expect((await columnsOf(type))[columnName('b')]).toBeDefined();
    const loaded = await loadTypeTable(sql, NS, type);
    expect(loaded?.orphaned).toEqual(['b']);
    expect(loaded?.column('b')).toEqual({
      field: 'b',
      column: columnName('b'),
      kind: 'number',
      state: 'orphaned'
    });
  });

  it("ADD COLUMN timing out inside a caller's transaction: falls back to pending, the caller's transaction commits, and lock_timeout reads back as before", async () => {
    const type = freshType();
    await ensure(type, { title: field.string() });
    const release = await holdAccessShare(type);
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '7s'`;
        await tx`INSERT INTO row_ids (namespace, type, id) VALUES (${NS}, ${type}, 'before')`;
        const change = await ensure(
          type,
          { title: field.string(), late: field.date() },
          'column',
          tx
        );
        expect(change.pending).toEqual(['late']);
        const [setting] = await tx<
          Array<{ v: string }>
        >`SELECT current_setting('lock_timeout') AS v`;
        expect(setting?.v).toBe('7s');
        await tx`INSERT INTO row_ids (namespace, type, id) VALUES (${NS}, ${type}, 'after')`;
      });
    } finally {
      await release();
    }
    const ids = await sql<Array<{ id: string }>>`
      SELECT id FROM row_ids WHERE namespace = ${NS} AND type = ${type} ORDER BY id`;
    expect(ids.map((r) => r.id)).toEqual(['after', 'before']);
    expect((await loadTypeTable(sql, NS, type))?.pending).toEqual(['late']);
  });

  it("ADD COLUMN succeeding inside a caller's transaction: lock_timeout reads back as before", async () => {
    const type = freshType();
    await ensure(type, { title: field.string() });
    await sql.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '7s'`;
      const change = await ensure(type, { title: field.string(), n: field.number() }, 'column', tx);
      expect(change.added).toEqual(['n']);
      const [setting] = await tx<Array<{ v: string }>>`SELECT current_setting('lock_timeout') AS v`;
      expect(setting?.v).toBe('7s');
    });
    expect((await columnsOf(type))[columnName('n')]).toBeDefined();
  });

  it("an orphaned field declared again becomes 'promoting'", async () => {
    const type = freshType();
    await ensure(type, { a: field.string(), b: field.number() });
    await ensure(type, { a: field.string() });
    await ensure(type, { a: field.string(), b: field.number() });
    const loaded = await loadTypeTable(sql, NS, type);
    expect(loaded?.column('b')?.state).toBe('promoting');
    expect(loaded?.orphaned).toEqual([]);
  });

  it('an undeclared pending field has its catalog row deleted', async () => {
    const type = freshType();
    await ensure(type, { a: field.string() });
    await ensure(type, { a: field.string(), p: field.number() }, 'pending');
    const change = await ensure(type, { a: field.string() });
    expect(change).toEqual({ created: false, added: [], pending: [], orphaned: [] });
    const rows = await sql`
      SELECT 1 FROM substrate_type_fields WHERE namespace = ${NS} AND type = ${type} AND field = 'p'`;
    expect(rows).toHaveLength(0);
    const loaded = await loadTypeTable(sql, NS, type);
    expect(loaded?.pending).toEqual([]);
    expect(loaded?.orphaned).toEqual([]);
  });

  it('number→string kind change throws FieldKindChangedError naming the field', async () => {
    const type = freshType();
    await ensure(type, { amount: field.number() });
    const err = await ensure(type, { amount: field.string() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FieldKindChangedError);
    expect(err).toMatchObject({ namespace: NS, type, field: 'amount', from: 'number', to: 'text' });
    expect((err as Error).message).toMatch(/amount/);
    expect((err as Error).message).toMatch(/migration/);
  });

  it('a changed enum vocabulary replaces the CHECK', async () => {
    const type = freshType();
    await ensure(type, { status: field.enum(['open']) });
    await ensure(type, { status: field.enum(['open', 'done']) });
    const table = await tableOf(type);
    await sql.unsafe(`INSERT INTO "${table}" (id, "${columnName('status')}") VALUES ('a', 'done')`);
    await expect(
      sql.unsafe(`INSERT INTO "${table}" (id, "${columnName('status')}") VALUES ('b', 'bogus')`)
    ).rejects.toMatchObject({ code: '23514' });
    expect((await loadTypeTable(sql, NS, type))?.column('status')?.vocab).toEqual(['open', 'done']);
  });

  it('a narrowed enum vocabulary keeps the recorded values and the CHECK, so old rows still update', async () => {
    const type = freshType();
    await ensure(type, { status: field.enum(['open', 'done']), note: field.string() });
    const table = await tableOf(type);
    await sql.unsafe(`INSERT INTO "${table}" (id, "${columnName('status')}") VALUES ('a', 'done')`);
    const change = await ensure(type, { status: field.enum(['open']), note: field.string() });
    expect(change).toEqual({ created: false, added: [], pending: [], orphaned: [] });
    expect((await loadTypeTable(sql, NS, type))?.column('status')?.vocab).toEqual(['open', 'done']);
    // pg re-checks a CHECK on every UPDATE; a narrowed one would refuse this.
    await sql.unsafe(`UPDATE "${table}" SET "${columnName('note')}" = 'x' WHERE id = 'a'`);
    // Widening again appends to what is recorded.
    await ensure(type, { status: field.enum(['open', 'new']), note: field.string() });
    expect((await loadTypeTable(sql, NS, type))?.column('status')?.vocab).toEqual([
      'open',
      'done',
      'new'
    ]);
  });

  it('a reordered enum vocabulary is no change', async () => {
    const type = freshType();
    await ensure(type, { status: field.enum(['open', 'done']) });
    const change = await ensure(type, { status: field.enum(['done', 'open']) });
    expect(change).toEqual({ created: false, added: [], pending: [], orphaned: [] });
    // Unchanged, so the catalog keeps the first declared order.
    expect((await loadTypeTable(sql, NS, type))?.column('status')?.vocab).toEqual(['open', 'done']);
  });

  it('a vocabulary change hitting a lock timeout keeps the old vocabulary', async () => {
    const type = freshType();
    await ensure(type, { status: field.enum(['open']) });
    const release = await holdAccessShare(type);
    try {
      await ensure(type, { status: field.enum(['open', 'done']) });
    } finally {
      await release();
    }
    expect((await loadTypeTable(sql, NS, type))?.column('status')?.vocab).toEqual(['open']);
    await expect(
      sql.unsafe(
        `INSERT INTO "${await tableOf(type)}" (id, "${columnName('status')}") VALUES ('a', 'done')`
      )
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('two concurrent ensureTypeTable calls create one table', async () => {
    const type = freshType();
    const fields = { title: field.string() };
    const changes = await Promise.all([ensure(type, fields), ensure(type, fields)]);
    expect(changes.filter((c) => c.created)).toHaveLength(1);
    const [count] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM substrate_type_fields WHERE namespace = ${NS} AND type = ${type}`;
    expect(count?.n).toBe(1);
  });

  it('names fold and hash: Weird-Name gets a valid, distinct t__ table', async () => {
    await ensure('Weird-Name', { title: field.string() });
    await ensure('weird_name', { title: field.string() });
    const weird = await tableOf('Weird-Name');
    expect(weird).toBe(typeTableName(NS, 'Weird-Name'));
    expect(weird).toMatch(/^t__tt_[0-9a-f]{8}__weird_name_[0-9a-f]{8}$/);
    expect(await tableOf('weird_name')).not.toBe(weird);
  });

  it('two types folding to one clean name, created concurrently, get distinct tables', async () => {
    // `<ns>a__b`/`c` and `<ns>a`/`b__c` both fold to `t__<ns>a__b__c` with no hash.
    const left = { ns: `${NS}a__b`, type: 'c' };
    const right = { ns: `${NS}a`, type: 'b__c' };
    expect(typeTableName(left.ns, left.type)).toBe(typeTableName(right.ns, right.type));
    const fields = { title: field.string() };
    const make = (t: { ns: string; type: string }) =>
      ensureTypeTable(sql, {
        namespace: t.ns,
        type: t.type,
        fields,
        newFields: 'column',
        enforceUuidCheck: false
      });
    await Promise.all([make(left), make(right)]);
    const names = [await tableOf(left.type, left.ns), await tableOf(right.type, right.ns)];
    expect(new Set(names).size).toBe(2);
    expect(names).toContain(typeTableName(left.ns, left.type));
  });
});
