/**
 * The sweep's retention purge: only tombstones older than the horizon go,
 * across every namespace; live rows and fresh tombstones stay.
 */
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDataset, PgEdgesStore, runMigrations } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const DAY_MS = 86_400_000;

describe.skipIf(!POSTGRES_URL)('purgeTombstonedRows / purgeTombstonedEdges', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql`TRUNCATE TABLE rows, edges, short_ids`;
  });

  it('purges only tombstones past the horizon, in every namespace', async () => {
    const now = Date.now();
    const olderThan = new Date(now - 30 * DAY_MS);
    const edges = new PgEdgesStore({ sql });
    for (const ns of ['ns_a', 'ns_b']) {
      const ds = new PgDataset({ namespace: ns, sql });
      await ds.write('T', [{ id: 'live' }, { id: 'fresh' }, { id: 'old' }]);
      await ds.tombstone('T', ['fresh', 'old']);
      await sql`
        UPDATE rows SET deleted_at = ${new Date(now - 31 * DAY_MS)}
        WHERE namespace = ${ns} AND id = 'old'
      `;
      for (const [id, at] of [
        ['live', undefined],
        ['fresh', new Date(now)],
        ['old', new Date(now - 31 * DAY_MS)]
      ] as const) {
        const e = await edges.write({
          from: { ns, type: 'T', id },
          to: { ns, type: 'U', id },
          fieldName: 'u',
          policy: 'set_null'
        });
        if (at !== undefined) await edges.tombstone(e.id, at);
      }
    }

    const ds = new PgDataset({ namespace: 'ns_a', sql });
    expect(await ds.purgeTombstonedRows({ olderThan })).toEqual({ deleted: 2 });
    expect(await edges.purgeTombstonedEdges({ olderThan })).toEqual({ deleted: 2 });

    const rows = await sql`SELECT namespace, id FROM rows ORDER BY namespace, id`;
    expect(rows.map((r) => `${r.namespace}/${r.id}`)).toEqual([
      'ns_a/fresh',
      'ns_a/live',
      'ns_b/fresh',
      'ns_b/live'
    ]);
    const left = await sql`SELECT from_ns, from_id FROM edges ORDER BY from_ns, from_id`;
    expect(left.map((r) => `${r.from_ns}/${r.from_id}`)).toEqual([
      'ns_a/fresh',
      'ns_a/live',
      'ns_b/fresh',
      'ns_b/live'
    ]);
  });
});
