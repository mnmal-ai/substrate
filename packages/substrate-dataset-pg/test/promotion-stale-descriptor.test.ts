/**
 * Audit #1 (Todo #1872): a process whose catalog notification is late writes
 * through a stale table descriptor. Every write checks the type's catalog
 * version in its own statement; a stale one reloads the table and runs again,
 * so a value written while a field is promoted is never lost to `extra`.
 *
 * Two pools stand in for two processes. B's pool is deaf: its cache believes
 * it is listening, so it caches descriptors, but no notification reaches it.
 */

import { randomBytes } from 'node:crypto';
import { field } from '@mnmal-ai/substrate-sdk';
import type { FieldDef, Row } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { loadTypeTable, tableCacheFor } from '../src/type-table.js';
import { dropNamespace } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const hex = () => randomBytes(4).toString('hex');

type Def = { fields: Record<string, FieldDef> };

describe.skipIf(!POSTGRES_URL)('a write through a stale table descriptor (pg)', () => {
  let sqlA: Sql;
  let sqlB: Sql;
  let ns: string;
  let defs: Record<string, Def>;
  let a: PgDataset;
  let b: PgDataset;
  const namespaces: string[] = [];
  const lookup = {
    typeDefLookup: (type: string) => defs[type],
    fieldDefLookup: (type: string, f: string) => defs[type]?.fields[f]
  };
  const sweep = (lockTimeoutMs = 2000) =>
    a.promotePendingFields({ lockTimeoutMs, batchRows: 100, namespace: ns });
  /** n1's stored rank column and `extra.rank`, read raw. */
  const stored = async (id = 'n1') => {
    const t = await loadTypeTable(sqlA, ns, 'Note');
    const col = t?.column('rank')?.column as string;
    const [r] = await sqlA.unsafe(`SELECT ${col} AS c, extra FROM ${t?.from} WHERE id = '${id}'`);
    return { column: r?.c, extra: (r?.extra as Record<string, unknown> | undefined)?.rank };
  };
  const rankOf = async (ds: PgDataset, id = 'n1') =>
    (await ds.read('Note', { ids: [id] })).rows.map((r: Row) => r.rank)[0];

  beforeAll(() => {
    sqlA = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    sqlB = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    // Deaf: B caches as if listening, and never hears a catalog notification.
    tableCacheFor(sqlB).listening = Promise.resolve(true);
  });

  afterAll(async () => {
    for (const n of namespaces) await dropNamespace(sqlA, n);
    await sqlA.end({ timeout: 5 });
    await sqlB.end({ timeout: 5 });
  });

  beforeEach(() => {
    ns = `sd_${hex()}`;
    namespaces.push(ns);
    defs = { Note: { fields: { title: field.string() } } };
    a = new PgDataset({ namespace: ns, sql: sqlA, ...lookup });
    b = new PgDataset({ namespace: ns, sql: sqlB, ...lookup });
  });

  /** `rank` pending with n1.rank = 1 in extra; B caches that descriptor; A promotes it. */
  async function promotedBehindB(): Promise<void> {
    await a.write('Note', [
      { id: 'n1', title: 'a' },
      { id: 'n2', title: 'b' }
    ]);
    defs.Note = { fields: { title: field.string(), rank: field.number() } };
    await a.ensureTypeStorage('Note', { newFields: 'pending' });
    await a.write('Note', [{ id: 'n1', rank: 1 }]);
    expect(await rankOf(b)).toBe(1); // B caches `rank` pending
    expect((await sweep()).map((e) => e.kind)).toEqual(['promoted']);
    expect(await stored()).toEqual({ column: 1, extra: undefined });
  }

  const paths: Array<[string, () => Promise<unknown>]> = [
    ['write (upsert)', () => b.write('Note', [{ id: 'n1', rank: 7 }])],
    ['patchRows', () => b.patchRows('Note', [{ id: 'n1', patch: { rank: 7 } }], null, new Date())],
    [
      'conditionalUpdate',
      () => b.conditionalUpdate('Note', 'n1', { title: 'a' }, { rank: 7 }, undefined, new Date())
    ],
    ['updateField', () => b.updateField({ type: 'Note', id: 'n1' }, 'rank', 7)],
    [
      'updateWhere',
      () => b.updateWhere('Note', { title: { eq: 'a' } }, { rank: 7 }, { maxMatch: 10 })
    ]
  ];

  it.each(paths)('%s lands in the column after the field was promoted unseen', async (_, run) => {
    await promotedBehindB();
    await run();
    expect(await rankOf(a)).toBe(7);
    expect(await stored()).toEqual({ column: 7, extra: undefined });
  });

  it('the retry reloads the descriptor: B then holds the current version', async () => {
    await promotedBehindB();
    const key = `${ns}/Note`;
    expect(tableCacheFor(sqlB).tables.get(key)?.pending).toEqual(['rank']);
    await b.write('Note', [{ id: 'n1', rank: 7 }]);
    const cached = tableCacheFor(sqlB).tables.get(key);
    expect(cached?.column('rank')?.state).toBe('column');
    expect(cached?.version).toBe((await loadTypeTable(sqlA, ns, 'Note'))?.version);
  });

  it('in a transaction the stale copy is reloaded too, and the commit lands the value', async () => {
    await promotedBehindB();
    await b.withTransaction(async (tx) => {
      await tx.read('Note', { ids: ['n1'] });
      await tx.write('Note', [{ id: 'n1', rank: 7 }]);
    });
    expect(await rankOf(a)).toBe(7);
    expect(await stored()).toEqual({ column: 7, extra: undefined });
  });

  it('deleteWhere through a stale filter matches the promoted value', async () => {
    await promotedBehindB();
    // B's pending view would filter `extra.rank`, which no longer holds n1's value.
    const res = await b.deleteWhere('Note', { rank: { eq: 1 } }, { maxMatch: 10 });
    expect(res.ids).toEqual(['n1']);
  });

  it('outside READ COMMITTED a write is refused, naming the setting, and writes nothing', async () => {
    await a.write('Note', [{ id: 'n1', title: 'a' }]);
    const rr = postgres(POSTGRES_URL as string, {
      onnotice: () => {},
      connection: { default_transaction_isolation: 'repeatable read' }
    });
    try {
      const c = new PgDataset({ namespace: ns, sql: rr, ...lookup });
      await expect(c.write('Note', [{ id: 'n1', title: 'b' }])).rejects.toThrow(
        /transaction_isolation 'repeatable read'.*default_transaction_isolation/
      );
      await expect(
        c.patchRows('Note', [{ id: 'n1', patch: { title: 'b' } }], null, new Date())
      ).rejects.toThrow(/repeatable read/);
    } finally {
      await rr.end({ timeout: 5 });
    }
    expect((await a.read('Note', { ids: ['n1'] })).rows.map((r) => r.title)).toEqual(['a']);
  });

  it('a patch takes no row lock unless its guard passes (M7)', async () => {
    await a.write('Note', [{ id: 'n1', title: 'a' }]);
    const seen: string[] = [];
    const cap = postgres(POSTGRES_URL as string, {
      onnotice: () => {},
      debug: (_c, q) => {
        seen.push(q);
      }
    });
    try {
      const c = new PgDataset({ namespace: ns, sql: cap, ...lookup });
      await c.patchRows('Note', [{ id: 'n1', patch: { title: 'b' } }], null, new Date());
    } finally {
      await cap.end({ timeout: 5 });
    }
    const patch = seen.find((q) => q.includes('FOR NO KEY UPDATE'));
    const locked = patch?.slice(patch.indexOf('locked AS'), patch.indexOf('FOR NO KEY UPDATE'));
    expect(locked).toContain('(SELECT ok FROM guard)');
    expect((await a.read('Note', { ids: ['n1'] })).rows.map((r: Row) => r.title)).toEqual(['b']);
  });

  it('the move to column waits for a write in flight, so the straggler pass sees it', async () => {
    // `rank` declared in code: its column is added, `promoting`.
    await a.write('Note', [{ id: 'n1', title: 'a', rank: 1 }]);
    defs.Note = { fields: { title: field.string(), rank: field.number() } };
    await a.ensureTypeStorage('Note');
    await a.write('Note', [{ id: 'n1', rank: 2 }]); // now in the column
    const t = await loadTypeTable(sqlA, ns, 'Note');
    // A write that passed its version check at `promoting` and has not committed:
    // it puts the value in `extra`, as a writer whose descriptor still has the
    // field undeclared (orphaned, or pending) does.
    const writer = await sqlB.reserve();
    try {
      await writer`BEGIN`;
      await writer.unsafe(`UPDATE ${t?.from} SET extra = extra || '{"rank": 7}' WHERE id = 'n1'`);
      expect((await sweep(200)).map((e) => e.kind)).toEqual(['busy']);
      await writer`COMMIT`;
    } finally {
      await writer`ROLLBACK`; // a no-op after the COMMIT; frees the locks when the test failed
      writer.release();
    }
    expect((await sweep()).map((e) => e.kind)).toEqual(['promoted']);
    expect(await rankOf(a)).toBe(7);
    expect(await stored()).toEqual({ column: 7, extra: undefined });
  });

  /**
   * `rank` promoting (only n1 has a value to move) and a reserved connection
   * whose open transaction holds `lock` on Note's table (on n2, which the
   * backfill never touches); `run` runs while it is held.
   */
  async function behindHolder<T>(
    lock: 'row' | 'share update exclusive',
    run: (release: () => Promise<void>) => Promise<T>
  ): Promise<T> {
    await a.write('Note', [
      { id: 'n1', title: 'a', rank: 1 },
      { id: 'n2', title: 'b' }
    ]);
    defs.Note = { fields: { title: field.string(), rank: field.number() } };
    await a.ensureTypeStorage('Note');
    const t = await loadTypeTable(sqlA, ns, 'Note');
    const holder = await sqlB.reserve();
    try {
      await holder`BEGIN`;
      await holder.unsafe(
        lock === 'row'
          ? `UPDATE ${t?.from} SET extra = extra WHERE id = 'n2'`
          : `LOCK TABLE ${t?.from} IN SHARE UPDATE EXCLUSIVE MODE` // autovacuum's lock
      );
      return await run(async () => {
        await holder`COMMIT`;
      });
    } finally {
      await holder`ROLLBACK`; // a no-op after the COMMIT
      holder.release();
    }
  }
  const timed = async <T>(p: Promise<T>) => {
    const t = performance.now();
    const value = await p;
    return { value, ms: performance.now() - t };
  };
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('the move retries its lock without queueing, and lands once a short holder lets go (M4)', async () => {
    await behindHolder('row', async (release) => {
      const sweeping = timed(sweep(3000));
      await pause(300); // the backfill is done; the move is retrying its lock
      // A write is never queued behind the move.
      expect((await timed(a.write('Note', [{ id: 'n1', title: 'c' }]))).ms).toBeLessThan(1000);
      await release();
      expect((await sweeping).value.map((e) => e.kind)).toEqual(['promoted']);
    });
    expect(await rankOf(a)).toBe(1);
  });

  it('a move whose table lock stays held past the timeout is busy, naming the table lock (m1)', async () => {
    await behindHolder('row', async () => {
      const sweeping = timed(sweep(800));
      await pause(300);
      expect((await timed(a.write('Note', [{ id: 'n1', title: 'c' }]))).ms).toBeLessThan(700);
      const { value, ms } = await sweeping;
      expect(value.map((e) => e.kind)).toEqual(['busy']);
      expect(ms).toBeGreaterThanOrEqual(800);
    });
    const [row] = await sqlA<Array<{ last_error: string }>>`
      SELECT last_error FROM substrate_type_fields WHERE namespace = ${ns} AND field = 'rank'`;
    expect(row?.last_error).toMatch(/move to column could not lock its table within 800 ms/);
    expect((await sweep()).map((e) => e.kind)).toEqual(['promoted']);
  });

  it('a store with no writers (migrate-store) waits for its move, past an autovacuum-like holder (I1)', async () => {
    const events = await behindHolder('share update exclusive', async (release) => {
      const settling = a.promotePendingFields({
        lockTimeoutMs: 10_000,
        batchRows: 100,
        namespace: ns,
        noWriters: true
      });
      await pause(1500);
      await release();
      return settling;
    });
    expect(events.map((e) => e.kind)).toEqual(['promoted']);
    expect(await rankOf(a)).toBe(1);
  });
});
