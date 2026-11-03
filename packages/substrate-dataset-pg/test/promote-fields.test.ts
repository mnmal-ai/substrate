/**
 * Pending fields and the promotion sweep (`tables` only): a field recorded
 * `pending` keeps its values in `extra`, reads and filters as memory does, and
 * the sweep gives it a column, moves the values, builds its indexes and
 * reports it `promoted`, `busy` or `failed`. The old layouts have nothing
 * pending: the sweep and the warnings report none there.
 */

import { randomBytes } from 'node:crypto';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { field } from '@mnmal-ai/substrate-sdk';
import type { Dataset, FieldDef, IndexDecl, ReadParams, Row } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FieldKindChangedError, PgDataset, promotePendingFields } from '../src/index.js';
import { loadTypeTable } from '../src/type-table.js';
import { dropNamespace } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const hex = () => randomBytes(4).toString('hex');

type Def = { fields: Record<string, FieldDef>; indexes?: IndexDecl[] };

describe('promotePendingFields is feature-detected', () => {
  it('is present on PgDataset and absent on memory', () => {
    expect(typeof PgDataset.prototype.promotePendingFields).toBe('function');
    expect(typeof PgDataset.prototype.fieldWarnings).toBe('function');
    const mem: Dataset = new MemoryDataset({ namespace: 'x' });
    expect(mem.promotePendingFields).toBeUndefined();
    expect(mem.fieldWarnings).toBeUndefined();
  });
});

const strip = ({ _metadata: _m, shortId: _s, ...rest }: Row): Row => rest as Row;
/** A stored `extra` without the row's own `id`, which the writer keeps there as `body` kept it. */
const extraOf = (r: Record<string, unknown>) => {
  const { id: _id, ...rest } = r.extra as Record<string, unknown>;
  return rest;
};
const byId = (a: Row, b: Row) => String(a.id).localeCompare(String(b.id));

describe.skipIf(!POSTGRES_URL)('pending fields and the promotion sweep', () => {
  let sql: Sql;
  let ns: string;
  let defs: Record<string, Def>;
  let pg: PgDataset;
  let mem: MemoryDataset;
  const namespaces: string[] = [];

  const lookup = {
    typeDefLookup: (type: string) => defs[type],
    fieldDefLookup: (type: string, f: string) => defs[type]?.fields[f]
  };
  const sweep = (o: { lockTimeoutMs?: number; batchRows?: number } = {}) =>
    pg.promotePendingFields({
      lockTimeoutMs: o.lockTimeoutMs ?? 2000,
      batchRows: o.batchRows ?? 100,
      namespace: ns
    });
  const state = async (type: string, f: string) =>
    (
      await sql<Array<{ state: string; attempts: number }>>`
      SELECT state, attempts FROM substrate_type_fields
      WHERE namespace = ${ns} AND type = ${type} AND field = ${f}`
    )[0];
  const tableOf = async (type: string) => {
    const t = await loadTypeTable(sql, ns, type);
    if (t === undefined) throw new Error(`no table for ${type}`);
    return t.from;
  };
  /** This namespace's detailed field lines, from the (admin-gated) storage report. */
  const warnings = async () => {
    const report = await pg.storageReport({ partitionBudget: 1_000_000 });
    return [...report.warnings, ...(report.info ?? [])].filter((w) => w.startsWith(`${ns}/`));
  };
  async function same(type: string, params: ReadParams): Promise<Row[]> {
    const read = async (ds: PgDataset | MemoryDataset) =>
      (await ds.read(type, params)).rows.map(strip).sort(byId);
    const want = await read(mem);
    expect(await read(pg), JSON.stringify(params)).toEqual(want);
    return want;
  }
  /** Writes `rows` to both datasets. */
  async function write(type: string, rows: Row[]): Promise<void> {
    await pg.write(type, rows);
    await mem.write(type, rows);
  }

  beforeAll(() => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
  });

  afterAll(async () => {
    for (const n of namespaces) await dropNamespace(sql, n);
    await sql.end({ timeout: 5 });
  });

  beforeEach(() => {
    ns = `pf_${hex()}`;
    namespaces.push(ns);
    defs = {
      Note: { fields: { title: field.string() } },
      Other: { fields: { label: field.string() } }
    };
    pg = new PgDataset({ namespace: ns, sql, ...lookup });
    mem = new MemoryDataset({ namespace: ns, ...lookup });
  });

  /** `Note` with rows, then `rank` declared and recorded `pending`, as propose_field records it. */
  async function pendingRank(): Promise<void> {
    await write('Note', [
      { id: 'n1', title: 'a' },
      { id: 'n2', title: 'b' }
    ]);
    defs.Note = { fields: { title: field.string(), rank: field.number() } };
    expect(await pg.ensureTypeStorage('Note', { newFields: 'pending' })).toEqual({
      pending: ['rank']
    });
  }

  it('values written while pending land in extra and filter as memory does', async () => {
    await pendingRank();
    await write('Note', [
      { id: 'n1', rank: 2 },
      { id: 'n3', title: 'c', rank: 10 }
    ]);
    const held = await sql.unsafe(`SELECT id, extra FROM ${await tableOf('Note')} ORDER BY id`);
    expect(held.map((r) => [r.id, (r.extra as Record<string, unknown>).rank])).toEqual([
      ['n1', 2],
      ['n2', undefined],
      ['n3', 10]
    ]);
    await same('Note', {});
    await same('Note', { where: { rank: { gt: 3 } } });
    await same('Note', { where: { rank: { eq: null } } });
    await same('Note', { orderBy: [{ rank: 'desc' }] });
    expect((await pg.describeStorage('Note')).pending).toEqual(['rank']);
    expect(await warnings()).toEqual([
      `${ns}/Note.rank is pending: held in jsonb until promoted (attempt 0)`
    ]);
  });

  it('fieldWarnings, which /health shows unauthenticated, counts and names nothing', async () => {
    await pendingRank();
    const lines = await pg.fieldWarnings();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d+ fields? pending promotion(; .*)? — see the storage report$/);
    expect(lines.join('\n')).not.toContain(ns);
    expect(lines.join('\n')).not.toContain('rank');
  });

  it('the sweep promotes: column filled, extra key gone, storage settled, event promoted', async () => {
    await pendingRank();
    await write('Note', [
      { id: 'n1', rank: 2 },
      { id: 'n3', title: 'c', rank: 10 }
    ]);
    expect(await sweep()).toEqual([
      { kind: 'promoted', namespace: ns, type: 'Note', field: 'rank', attempts: 1 }
    ]);
    expect(await state('Note', 'rank')).toEqual({ state: 'column', attempts: 0 });
    const t = await loadTypeTable(sql, ns, 'Note');
    const col = t?.column('rank')?.column as string;
    const stored = await sql.unsafe(`SELECT id, ${col} AS c, extra FROM ${t?.from} ORDER BY id`);
    expect(stored.map((r) => [r.id, r.c, Object.keys(extraOf(r))])).toEqual([
      ['n1', 2, []],
      ['n2', null, []],
      ['n3', 10, []]
    ]);
    expect((await pg.describeStorage('Note')).pending).toEqual([]);
    expect(await warnings()).toEqual([]);
    await same('Note', {});
    await same('Note', { where: { rank: { gte: 2 } } });
    // Nothing left: a second sweep touches nothing.
    expect(await sweep()).toEqual([]);
  });

  it('a misfit value moves to $raw and reads back as written', async () => {
    defs.Note = { fields: { title: field.string() } };
    await write('Note', [{ id: 'n1', title: 'a', due: '2026-01-02' }]);
    defs.Note = { fields: { title: field.string(), due: field.date() } };
    await pg.ensureTypeStorage('Note', { newFields: 'pending' });
    await sweep();
    const [row] = await sql.unsafe(`SELECT extra FROM ${await tableOf('Note')}`);
    expect(extraOf(row as Record<string, unknown>)).toEqual({ $raw: { due: '2026-01-02' } });
    await same('Note', {});
  });

  it('a long reader holding ACCESS SHARE: busy within 2.5 s, writes on the type wait then succeed, other types unaffected', async () => {
    await pendingRank();
    await write('Other', [{ id: 'o1', label: 'x' }]);
    const table = await tableOf('Note');
    const reader = await sql.reserve();
    try {
      await reader`BEGIN`;
      await reader.unsafe(`SELECT count(*) FROM ${table}`);
      const started = Date.now();
      const swept = sweep();
      // Let the ALTER queue for its lock, so the write below queues behind it.
      await new Promise((r) => setTimeout(r, 300));
      const noteWrite = pg
        .write('Note', [{ id: 'n9', title: 'late', rank: 1 }])
        .then(() => Date.now());
      const otherStart = Date.now();
      await pg.write('Other', [{ id: 'o2', label: 'y' }]);
      expect(Date.now() - otherStart).toBeLessThan(1000);
      const events = await swept;
      expect(Date.now() - started).toBeLessThan(2500);
      expect(events).toEqual([
        { kind: 'busy', namespace: ns, type: 'Note', field: 'rank', attempts: 1 }
      ]);
      expect(await noteWrite).toBeGreaterThanOrEqual(started);
    } finally {
      await reader`ROLLBACK`;
      reader.release();
    }
    expect(await state('Note', 'rank')).toEqual({ state: 'pending', attempts: 1 });
    expect((await pg.read('Note', { ids: ['n9'] })).rows.map((r) => r.rank)).toEqual([1]);
    expect(await warnings()).toEqual([
      `${ns}/Note.rank is pending: held in jsonb until promoted (attempt 1)`
    ]);
  });

  it('three busy sweeps in a row: the third is failed, and the field still warns', async () => {
    await pendingRank();
    const reader = await sql.reserve();
    const kinds: string[] = [];
    try {
      await reader`BEGIN`;
      await reader.unsafe(`SELECT count(*) FROM ${await tableOf('Note')}`);
      for (let i = 0; i < 3; i++) {
        for (const e of await sweep({ lockTimeoutMs: 50 })) kinds.push(`${e.kind}:${e.attempts}`);
      }
    } finally {
      await reader`ROLLBACK`;
      reader.release();
    }
    expect(kinds).toEqual(['busy:1', 'busy:2', 'failed:3']);
    expect(await warnings()).toEqual([
      `${ns}/Note.rank promotion failed (attempt 3): its table's lock was held past 50 ms`
    ]);
    // Once the lock is free it promotes, and the count starts again.
    expect((await sweep()).map((e) => e.kind)).toEqual(['promoted']);
    expect(await state('Note', 'rank')).toEqual({ state: 'column', attempts: 0 });
  });

  it('promoting with a stale extra write: answers equal memory; the next sweep moves it', async () => {
    // `rank` is written undeclared, then declared in code: its column is added, `promoting`.
    await write('Note', [
      { id: 'n1', title: 'a', rank: 1 },
      { id: 'n2', title: 'b', rank: 5 }
    ]);
    defs.Note = { fields: { title: field.string(), rank: field.number() } };
    expect(await pg.ensureTypeStorage('Note')).toEqual({ pending: [] });
    expect(await state('Note', 'rank')).toEqual({ state: 'promoting', attempts: 0 });
    // A current write sets the column; a writer with a stale table then puts a newer value in `extra`.
    await write('Note', [{ id: 'n1', rank: 2 }]);
    const t = await loadTypeTable(sql, ns, 'Note');
    await sql.unsafe(`UPDATE ${t?.from} SET extra = extra || '{"rank": 7}' WHERE id = 'n1'`);
    await mem.write('Note', [{ id: 'n1', rank: 7 }]);
    await same('Note', {});
    await same('Note', { where: { rank: { eq: 7 } } });
    await same('Note', { orderBy: [{ rank: 'asc' }] });
    expect((await sweep()).map((e) => e.kind)).toEqual(['promoted']);
    const col = t?.column('rank')?.column as string;
    const stored = await sql.unsafe(`SELECT id, ${col} AS c, extra FROM ${t?.from} ORDER BY id`);
    expect(stored.map((r) => [r.id, r.c, extraOf(r)])).toEqual([
      ['n1', 7, {}],
      ['n2', 5, {}]
    ]);
    await same('Note', { where: { rank: { eq: 7 } } });
  });

  it('the backfill pages by id: with batchRows 100 over 1,000 rows each page starts past the last', async () => {
    const pages: string[] = [];
    const watched = postgres(POSTGRES_URL as string, {
      onnotice: () => {},
      debug: (_c, query, params) => {
        const bound = /WHERE id > \$(\d+) ORDER BY id LIMIT/.exec(query);
        if (bound !== null) pages.push(String(params[Number(bound[1]) - 1]));
      }
    });
    try {
      const ds = new PgDataset({ namespace: ns, sql: watched, ...lookup });
      const ids = Array.from({ length: 1000 }, (_, i) => `r${String(i).padStart(4, '0')}`);
      await ds.write(
        'Note',
        ids.map((id, i) => ({ id, title: 't', rank: i }))
      );
      defs.Note = { fields: { title: field.string(), rank: field.number() } };
      await ds.ensureTypeStorage('Note', { newFields: 'pending' });
      const events = await ds.promotePendingFields({
        lockTimeoutMs: 2000,
        batchRows: 100,
        namespace: ns
      });
      expect(events.map((e) => e.kind)).toEqual(['promoted']);
    } finally {
      await watched.end({ timeout: 5 });
    }
    // Two passes (the backfill, then the straggler pass), each from '' in steps of 100.
    const pass = [
      '',
      ...Array.from({ length: 10 }, (_, i) => `r${String(i * 100 + 99).padStart(4, '0')}`)
    ];
    expect(pages).toEqual([...pass, ...pass]);
    for (let i = 1; i < 11; i++) expect((pages[i] as string) > (pages[i - 1] as string)).toBe(true);
    const top = await pg.read('Note', { where: { rank: { gte: 995 } } });
    expect(top.rows.map((r) => r.id).sort()).toEqual(['r0995', 'r0996', 'r0997', 'r0998', 'r0999']);
  });

  it('a unique duplicate held in extra fails the field naming the declared index; nothing is lost', async () => {
    const index = `pf_code_${hex()}`;
    await write('Note', [
      { id: 'n1', title: 'a', code: 'X' },
      { id: 'n2', title: 'b', code: 'X' }
    ]);
    defs.Note = {
      fields: { title: field.string(), code: field.string() },
      indexes: [{ name: index, fields: ['code'], unique: true }]
    };
    // Added at boot: the column is empty, so the unique index builds over it.
    await pg.ensureTypeStorage('Note');
    expect(await state('Note', 'code')).toEqual({ state: 'promoting', attempts: 0 });
    const events = await sweep();
    expect(events).toEqual([
      {
        kind: 'failed',
        namespace: ns,
        type: 'Note',
        field: 'code',
        attempts: 1,
        error: `unique index ${index} refuses a duplicate value of code`
      }
    ]);
    expect(await state('Note', 'code')).toEqual({ state: 'promoting', attempts: 1 });
    const report = await pg.describeStorage('Note');
    expect(report.indexes.find((i) => i.name === index)?.state).toBe('pending');
    expect(await warnings()).toEqual([
      `${ns}/Note.code promotion failed (attempt 1): unique index ${index} refuses a duplicate value of code`
    ]);
    await same('Note', {});
    await same('Note', { where: { code: { eq: 'X' } } });
  });

  it('a pending field whose values duplicate under its unique index: the build fails, naming it', async () => {
    const index = `pf_code_${hex()}`;
    await write('Note', [
      { id: 'n1', title: 'a', code: 'X' },
      { id: 'n2', title: 'b', code: 'X' }
    ]);
    defs.Note = {
      fields: { title: field.string(), code: field.string() },
      indexes: [{ name: index, fields: ['code'], unique: true }]
    };
    await pg.ensureTypeStorage('Note', { newFields: 'pending' });
    const [event] = await sweep();
    expect(event?.kind).toBe('failed');
    expect(event?.error).toContain(`unique index ${index}`);
    expect(event?.error).toContain('code');
    expect(await state('Note', 'code')).toMatchObject({ state: 'promoting' });
    // Never built: the reconciler reports the refused build `failed`, as at boot.
    expect((await pg.describeStorage('Note')).indexes.find((i) => i.name === index)?.state).toBe(
      'failed'
    );
    await same('Note', {});
  });

  it('an index waiting on the pending column is built by the sweep and reports settled', async () => {
    const index = `pf_rank_${hex()}`;
    await write('Note', [{ id: 'n1', title: 'a', rank: 3 }]);
    defs.Note = {
      fields: { title: field.string(), rank: field.number() },
      indexes: [{ name: index, fields: ['rank'] }]
    };
    await pg.ensureTypeStorage('Note', { newFields: 'pending' });
    expect((await pg.describeStorage('Note')).indexes.find((i) => i.name === index)?.state).toBe(
      'pending'
    );
    expect((await sweep()).map((e) => e.kind)).toEqual(['promoted']);
    expect((await pg.describeStorage('Note')).indexes.find((i) => i.name === index)?.state).toBe(
      'valid'
    );
  });

  it('a field added in code is promoting at boot and column after the sweep; with the lock held, pending', async () => {
    await write('Note', [{ id: 'n1', title: 'a', rank: 1 }]);
    defs.Note = { fields: { title: field.string(), rank: field.number() } };
    await pg.ensureTypeStorage('Note');
    expect(await state('Note', 'rank')).toMatchObject({ state: 'promoting' });
    await sweep();
    expect(await state('Note', 'rank')).toMatchObject({ state: 'column' });

    defs.Note = { fields: { title: field.string(), rank: field.number(), size: field.number() } };
    const reader = await sql.reserve();
    try {
      await reader`BEGIN`;
      await reader.unsafe(`SELECT count(*) FROM ${await tableOf('Note')}`);
      expect(await pg.ensureTypeStorage('Note', { indexes: 'unique' })).toEqual({
        pending: ['size']
      });
    } finally {
      await reader`ROLLBACK`;
      reader.release();
    }
    expect(await state('Note', 'size')).toMatchObject({ state: 'pending' });
    expect((await sweep()).map((e) => e.kind)).toEqual(['promoted']);
    expect(await state('Note', 'size')).toMatchObject({ state: 'column' });
  });

  it('a field proposed, then declared in code, stays pending at boot and is promoted by the next sweep', async () => {
    await pendingRank();
    await write('Note', [{ id: 'n1', rank: 4 }]);
    // The boot declares it: its catalog row is already `pending`, so the boot leaves it.
    expect(await pg.ensureTypeStorage('Note', { newFields: 'column' })).toEqual({ pending: [] });
    expect(await state('Note', 'rank')).toMatchObject({ state: 'pending' });
    expect((await sweep()).map((e) => e.kind)).toEqual(['promoted']);
    await same('Note', { where: { rank: { eq: 4 } } });
  });

  it('a kind change in code is refused with FieldKindChangedError', async () => {
    await pendingRank();
    defs.Note = { fields: { title: field.string(), rank: field.string() } };
    await expect(pg.ensureTypeStorage('Note')).rejects.toBeInstanceOf(FieldKindChangedError);
  });

  it('the sql-level sweep reports each event as it happens', async () => {
    await pendingRank();
    const seen: string[] = [];
    await promotePendingFields(sql, {
      lockTimeoutMs: 2000,
      batchRows: 10,
      namespace: ns,
      onEvent: (e) => seen.push(`${e.type}.${e.field}:${e.kind}`)
    });
    expect(seen).toEqual(['Note.rank:promoted']);
  });

  /** `Note.code` added in code over rows that carry it: `promoting`, with `index` unique on it. */
  async function promotingCode(index: string, rows: Row[]): Promise<void> {
    await write('Note', rows);
    defs.Note = {
      fields: { title: field.string(), code: field.string() },
      indexes: [{ name: index, fields: ['code'], unique: true }]
    };
    await pg.ensureTypeStorage('Note');
    expect(await state('Note', 'code')).toMatchObject({ state: 'promoting' });
  }
  /** The sql-level sweep with `reconcile` run in step 4 (and again after), as PgDataset wires it. */
  const sweepWith = (
    reconcile: (ns: string, type: string) => Promise<void>,
    signal?: AbortSignal
  ) =>
    promotePendingFields(sql, {
      lockTimeoutMs: 2000,
      batchRows: 100,
      namespace: ns,
      reconcile,
      ...(signal !== undefined ? { signal } : {})
    });

  it('a boot that orphans the field mid-sweep wins: the sweep never records it column', async () => {
    await pendingRank();
    await write('Note', [{ id: 'n1', rank: 4 }]);
    let orphaned = false;
    const events = await sweepWith(async () => {
      if (orphaned) return;
      orphaned = true;
      // A rolling deploy's boot whose code no longer declares `rank`.
      defs.Note = { fields: { title: field.string() } };
      await pg.ensureTypeStorage('Note');
    });
    expect(orphaned).toBe(true);
    expect(await state('Note', 'rank')).toMatchObject({ state: 'orphaned' });
    expect(events.map((e) => e.kind)).not.toContain('promoted');
    await same('Note', {});
  });

  it('a unique duplicate first seen in the straggler pass: failed, the field stays column, no row lost', async () => {
    const index = `pf_code_${hex()}`;
    await promotingCode(index, [
      { id: 'n1', title: 'a', code: 'X' },
      { id: 'n2', title: 'b', code: 'Y' }
    ]);
    const t = await loadTypeTable(sql, ns, 'Note');
    let injected = false;
    const events = await sweepWith(async () => {
      if (injected) return;
      injected = true;
      // A writer with a stale table, between the backfill and the straggler pass.
      await sql.unsafe(`UPDATE ${t?.from} SET extra = extra || '{"code": "X"}' WHERE id = 'n2'`);
    });
    expect(events).toEqual([
      {
        kind: 'failed',
        namespace: ns,
        type: 'Note',
        field: 'code',
        attempts: 1,
        error: `unique index ${index} refuses a duplicate value of code`
      }
    ]);
    expect(await state('Note', 'code')).toEqual({ state: 'column', attempts: 1 });
    expect((await pg.read('Note', {})).rows.map((r) => r.id).sort()).toEqual(['n1', 'n2']);
    const [held] = await sql.unsafe(`SELECT extra FROM ${t?.from} WHERE id = 'n2'`);
    expect(extraOf(held as Record<string, unknown>)).toEqual({ code: 'X' });
    expect(await warnings()).toEqual([
      `${ns}/Note.code promotion failed (attempt 1): unique index ${index} refuses a duplicate value of code`
    ]);
    // The next sweep runs the straggler pass again; once the duplicate is resolved it finishes.
    expect((await sweep()).map((e) => e.kind)).toEqual(['failed']);
    await sql.unsafe(`UPDATE ${t?.from} SET extra = extra || '{"code": "Z"}' WHERE id = 'n2'`);
    expect((await sweep()).map((e) => e.kind)).toEqual(['promoted']);
    expect(await state('Note', 'code')).toEqual({ state: 'column', attempts: 0 });
    expect((await pg.read('Note', { ids: ['n2'] })).rows.map((r) => r.code)).toEqual(['Z']);
    expect(await warnings()).toEqual([]);
  });

  it('a value in extra colliding with one already in the column fails the field, naming the index', async () => {
    const index = `pf_code_${hex()}`;
    await promotingCode(index, [
      { id: 'n1', title: 'a', code: 'X' },
      { id: 'n2', title: 'b', code: 'X' }
    ]);
    // n1's value moves into the column by a current write; n2's stays in extra.
    await write('Note', [{ id: 'n1', code: 'X' }]);
    const [event] = await sweep();
    expect(event).toMatchObject({
      kind: 'failed',
      error: `unique index ${index} refuses a duplicate value of code`
    });
    expect(await state('Note', 'code')).toMatchObject({ state: 'promoting' });
    await same('Note', {});
  });

  it('a deadlock with a writer is busy, not failed, and the next sweep promotes', async () => {
    await write('Note', [
      { id: 'n1', title: 'a', rank: 1 },
      { id: 'n2', title: 'b', rank: 2 }
    ]);
    defs.Note = { fields: { title: field.string(), rank: field.number() } };
    await pg.ensureTypeStorage('Note');
    const table = await tableOf('Note');
    const writer = await sql.reserve();
    let events: Awaited<ReturnType<typeof sweep>> = [];
    try {
      await writer`BEGIN`;
      await writer.unsafe(`UPDATE ${table} SET extra = extra WHERE id = 'n2'`);
      const swept = sweep();
      // The sweep locks n1, then waits on n2; the writer then wants n1. The sweep
      // waited first, so its deadlock check fires first and it is the victim.
      await new Promise((r) => setTimeout(r, 300));
      // `.then` sends it: a postgres.js query is lazy until awaited.
      const wants = writer
        .unsafe(`SELECT 1 FROM ${table} WHERE id = 'n1' FOR UPDATE`)
        .then(() => 'locked');
      events = await swept;
      expect(await wants).toBe('locked');
    } finally {
      await writer`ROLLBACK`;
      writer.release();
    }
    expect(events).toEqual([
      { kind: 'busy', namespace: ns, type: 'Note', field: 'rank', attempts: 1 }
    ]);
    expect((await sweep()).map((e) => e.kind)).toEqual(['promoted']);
  });

  it('an abort stops a sweep mid-backfill at once, with no lock held', async () => {
    const abort = new AbortController();
    let pagesAfterAbort = 0;
    let pagesSeen = 0;
    let abortedAt = 0;
    const watched = postgres(POSTGRES_URL as string, {
      onnotice: () => {},
      debug: (_c, query) => {
        if (!/WHERE id > \$\d+ ORDER BY id LIMIT/.test(query)) return;
        if (abort.signal.aborted) pagesAfterAbort++;
        else if (++pagesSeen === 3) {
          abortedAt = Date.now();
          abort.abort();
        }
      }
    });
    try {
      const ds = new PgDataset({ namespace: ns, sql: watched, ...lookup });
      await ds.write(
        'Note',
        Array.from({ length: 500 }, (_, i) => ({ id: `r${String(i).padStart(4, '0')}`, rank: i }))
      );
      defs.Note = { fields: { title: field.string(), rank: field.number() } };
      await ds.ensureTypeStorage('Note', { newFields: 'pending' });
      const events = await ds.promotePendingFields({
        lockTimeoutMs: 2000,
        batchRows: 10,
        namespace: ns,
        signal: abort.signal
      });
      const stoppedIn = Date.now() - abortedAt;
      expect(abort.signal.aborted).toBe(true);
      expect(events).toEqual([]);
      // The page in flight finishes; none starts after it, far inside the 2 s lock timeout.
      expect(pagesAfterAbort).toBe(0);
      expect(stoppedIn).toBeLessThan(500);
    } finally {
      await watched.end({ timeout: 5 });
    }
    // Not counted as an attempt, and left promoting for the next sweep.
    expect(await state('Note', 'rank')).toEqual({ state: 'promoting', attempts: 0 });
    expect((await sweep()).map((e) => e.kind)).toEqual(['promoted']);
  });

  it("a first write's type lock held in a transaction: the sweep is busy within its timeout", async () => {
    await pendingRank();
    const holder = await sql.reserve();
    const started = Date.now();
    let events: Awaited<ReturnType<typeof sweep>> = [];
    try {
      await holder`BEGIN`;
      await holder`SELECT pg_advisory_xact_lock(hashtext(
        current_schema() || ':substrate-type-table:' || ${ns} || '/Note'))`;
      events = await sweep({ lockTimeoutMs: 200 });
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
    expect(Date.now() - started).toBeLessThan(1500);
    expect(events.map((e) => e.kind)).toEqual(['busy']);
  });

  it('a current write strips the extra key in column state too (as in promoting: tables-dataset-parity F13)', async () => {
    await pendingRank();
    await sweep();
    const t = await loadTypeTable(sql, ns, 'Note');
    expect(t?.column('rank')?.state).toBe('column');
    await sql.unsafe(`UPDATE ${t?.from} SET extra = extra || '{"rank": 9}' WHERE id = 'n1'`);
    await pg.write('Note', [{ id: 'n1', rank: 3 }]);
    const [row] = await sql.unsafe(
      `SELECT ${t?.column('rank')?.column} AS c, extra FROM ${t?.from} WHERE id = 'n1'`
    );
    expect([row?.c, extraOf(row as Record<string, unknown>)]).toEqual([3, {}]);
  });
});
