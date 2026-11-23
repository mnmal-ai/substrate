/**
 * `hasRowsLocked` answers whether a type has rows and holds that answer until
 * its transaction ends: a write in another transaction waits for it, whether
 * the type has a table yet or not. It never queues for its lock, but retries
 * briefly: a write committing meanwhile is seen, and one held open longer
 * makes the answer undefined.
 */

import { randomBytes } from 'node:crypto';
import { field } from '@mnmal-ai/substrate-sdk';
import type { FieldDef } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { dropNamespace } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('hasRowsLocked', () => {
  let sql: Sql;
  const ns = `hrl_${randomBytes(4).toString('hex')}`;
  const other = `${ns}_b`;
  const fields: Record<string, FieldDef> = { title: field.string() };
  const dataset = (namespace = ns): PgDataset =>
    new PgDataset({
      namespace,
      sql,
      typeDefLookup: () => ({ fields }),
      fieldDefLookup: (_t, f) => fields[f]
    });
  /** Whether `type` has rows, asked in a transaction of its own. */
  const holds = (type: string, namespace?: string): Promise<boolean | undefined> =>
    dataset().withTransaction(async (tx) => (tx as PgDataset).hasRowsLocked(type, namespace));

  beforeAll(() => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
  });
  afterAll(async () => {
    await dropNamespace(sql, ns);
    await dropNamespace(sql, other);
    await sql.end({ timeout: 5 });
  });

  /** Resolves once another session waits on a lock in a statement matching `like`. */
  async function waiting(like: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [w] = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE ${like} AND pid <> pg_backend_pid()`;
      if ((w?.n ?? 0) > 0) return;
      if (Date.now() > deadline) throw new Error(`nothing waited on ${like}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /**
   * Holds `type` empty in one transaction while another writes a row of it,
   * and reports whether the write finished before the first transaction did.
   */
  async function writeDuringHold(type: string): Promise<boolean> {
    const pg = dataset();
    let held = true;
    let finishedWhileHeld = false;
    let write: Promise<unknown> | undefined;
    await pg.withTransaction(async (tx) => {
      expect(await tx.hasRowsLocked?.(type)).toBe(false);
      write = pg
        .withTransaction((other) => other.write(type, [{ title: 'late' }]))
        .then(() => {
          finishedWhileHeld = held;
        });
      await waiting('%substrate-type-rows:%');
      held = false;
    });
    await write;
    return finishedWhileHeld;
  }

  it('makes a write to an empty table wait until the holder ends', async () => {
    const pg = dataset();
    await pg.write('Note', [{ id: 'n1', title: 'a' }]);
    await pg.purge('Note', ['n1']);
    expect(await writeDuringHold('Note')).toBe(false);
    expect(await holds('Note')).toBe(true);
  });

  it('makes a first write, which creates the table, wait until the holder ends', async () => {
    expect(await writeDuringHold('Fresh')).toBe(false);
    expect(await holds('Fresh')).toBe(true);
  });

  /**
   * Runs `hold` in a transaction kept open until `ask` settles, or for
   * `releaseAfterMs` when given; returns what `ask` resolved to.
   */
  async function whileHeld<T>(
    hold: (tx: PgDataset) => Promise<unknown>,
    ask: () => Promise<T>,
    releaseAfterMs?: number
  ): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held!: () => void;
    const holding = new Promise<void>((r) => {
      held = r;
    });
    const other = dataset().withTransaction(async (tx) => {
      await hold(tx as PgDataset);
      held();
      await gate;
    });
    await holding;
    if (releaseAfterMs !== undefined) setTimeout(release, releaseAfterMs);
    try {
      return await ask();
    } finally {
      release();
      await other;
    }
  }

  it('answers undefined while another transaction keeps the type busy through its retry', async () => {
    const pg = dataset();
    await pg.write('Draft', [{ id: 'd1', title: 'a' }]);
    await pg.purge('Draft', ['d1']);
    const write = (tx: PgDataset) => tx.write('Draft', [{ title: 'in flight' }]);
    const hold = (tx: PgDataset) => tx.hasRowsLocked('Draft');
    expect(await whileHeld(write, () => holds('Draft'))).toBeUndefined();
    expect(await whileHeld(hold, () => holds('Draft'))).toBeUndefined();
  });

  it('sees the row of a write that commits during its retry', async () => {
    const pg = dataset();
    await pg.write('Brief', [{ id: 'b1', title: 'a' }]);
    await pg.purge('Brief', ['b1']);
    const write = (tx: PgDataset) => tx.write('Brief', [{ title: 'in flight' }]);
    expect(await whileHeld(write, () => holds('Brief'), 100)).toBe(true);
  });

  it('answers beside the lock an index build or a vacuum holds on the table', async () => {
    const pg = dataset();
    await pg.write('Indexed', [{ id: 'i1', title: 'a' }]);
    const [t] = await sql<Array<{ table_name: string }>>`
      SELECT table_name FROM substrate_type_tables WHERE namespace = ${ns} AND type = 'Indexed'`;
    const table = `"${String(t?.table_name).replace(/"/g, '""')}"`;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let held!: () => void;
    const holding = new Promise<void>((r) => {
      held = r;
    });
    const build = sql.begin(async (tx) => {
      await tx.unsafe(`LOCK TABLE ${table} IN SHARE UPDATE EXCLUSIVE MODE`);
      held();
      await gate;
    });
    await holding;
    try {
      expect(await holds('Indexed')).toBe(true);
    } finally {
      release();
      await build;
    }
  });

  it('counts tombstoned rows, and answers for another namespace on its store', async () => {
    const pg = dataset(other);
    await pg.write('Note', [{ id: 'o1', title: 'a' }]);
    await pg.tombstone('Note', ['o1']);
    expect(await holds('Note', other)).toBe(true);
    expect(await holds('Absent', other)).toBe(false);
  });

  it('refuses outside a transaction, where the answer would not be held', async () => {
    await expect(dataset().hasRowsLocked('Note')).rejects.toThrow(/transaction/);
  });
});
