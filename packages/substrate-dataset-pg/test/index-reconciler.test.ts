/**
 * `reconcileTypeIndexes`: declared indexes are created, left alone when
 * identical, swapped without a gap in uniqueness when only the expression
 * differs, refused when anything else differs, refused over duplicate live
 * values, and rebuilt when a failed concurrent build left one INVALID.
 */

import { randomBytes } from 'node:crypto';
import type { FieldDef } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type IndexDecl,
  IndexDefinitionConflictError,
  PgDataset,
  reconcileTypeIndexes,
  type StorageLayout,
  UniqueIndexDuplicatesError
} from '../src/index.js';
import { reconcileTypeStatistics } from '../src/index-reconciler.js';
import { generatedIdentifier } from '../src/migrate.js';
import { addTestPromotedColumns } from './_promoted.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const LAYOUT = (process.env.SUBSTRATE_STORAGE_LAYOUT ?? 'legacy') as StorageLayout;
const TYPE = 'T';

const fields: Record<string, FieldDef> = {
  cert: { kind: 'scalar', type: 'string' },
  observedAt: { kind: 'scalar', type: 'date' },
  kid: { kind: 'scalar', type: 'string' }
};
const kidIndexed: Record<string, FieldDef> = {
  ...fields,
  kid: { kind: 'scalar', type: 'string', indexed: true }
};

const hex = () => randomBytes(4).toString('hex');

let sql: Sql;

beforeAll(async () => {
  if (POSTGRES_URL) sql = postgres(POSTGRES_URL, { onnotice: () => {} });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

interface Fixture {
  ns: string;
  ds: PgDataset;
  /** The table the type's indexes live on. */
  target: string;
  /** The predicate every index of the type carries. */
  live: string;
}

async function fixture(): Promise<Fixture> {
  const ns = `ir_${hex()}`;
  const ds = new PgDataset({ namespace: ns, sql });
  if (LAYOUT === 'legacy') {
    return {
      ns,
      ds,
      target: 'rows',
      live: `namespace = '${ns}' AND type = '${TYPE}' AND deleted_at IS NULL`
    };
  }
  await ds.ensureTypeStorage(TYPE);
  const [row] = await sql<Array<{ relname: string }>>`
    SELECT c.relname FROM pg_partition_tree('rows') t
    JOIN pg_class c ON c.oid = t.relid
    WHERE t.isleaf AND pg_get_expr(c.relpartbound, c.oid) = ${`FOR VALUES IN ('${TYPE}')`}
      AND t.parentrelid = (
        SELECT c2.oid FROM pg_partition_tree('rows') t2 JOIN pg_class c2 ON c2.oid = t2.relid
        WHERE pg_get_expr(c2.relpartbound, c2.oid) = ${`FOR VALUES IN ('${ns}')`})`;
  if (row === undefined) throw new Error('type partition missing');
  return { ns, ds, target: row.relname, live: 'deleted_at IS NULL' };
}

const reconcile = (ns: string, indexes: IndexDecl[], f: Record<string, FieldDef> = fields) =>
  reconcileTypeIndexes(sql, { namespace: ns, type: TYPE, layout: LAYOUT, fields: f, indexes });

async function indexState(name: string) {
  const [row] = await sql<Array<{ valid: boolean; def: string }>>`
    SELECT i.indisvalid AND i.indisready AS valid, pg_get_indexdef(i.indexrelid) AS def
    FROM pg_index i WHERE i.indexrelid = to_regclass(${name})`;
  return row;
}

describe.skipIf(!POSTGRES_URL)(`reconcileTypeIndexes (${LAYOUT})`, () => {
  it('creates a declared composite, then leaves it unchanged', async () => {
    const { ns } = await fixture();
    const name = `rows_c_${hex()}`;
    const decl: IndexDecl = { fields: ['cert', { field: 'observedAt', dir: 'desc' }], name };

    const first = await reconcile(ns, [decl]);
    expect(first.find((s) => s.name === name)).toMatchObject({
      fields: ['cert', 'observedAt'],
      unique: false,
      state: 'valid',
      outcome: 'created'
    });
    const state = await indexState(name);
    expect(state?.valid).toBe(true);
    expect(state?.def).toContain(`substrate_ts((body -> 'observedAt'::text)) DESC NULLS LAST`);

    const second = await reconcile(ns, [decl]);
    expect(second.find((s) => s.name === name)).toMatchObject({
      state: 'valid',
      outcome: 'unchanged'
    });
  });

  describe('an unnamed declaration on an implicitly indexed field', () => {
    const withArchived: Record<string, FieldDef> = {
      ...kidIndexed,
      archived: { kind: 'scalar', type: 'boolean' }
    };
    const kidStates = (states: Awaited<ReturnType<typeof reconcile>>) =>
      states.filter((x) => x.fields.join() === 'kid');

    it('with a predicate, is built beside the implicit index under a name of its own', async () => {
      const { ns } = await fixture();
      const decl: IndexDecl = { fields: ['kid'], where: { archived: false } };
      const states = kidStates(await reconcile(ns, [decl], withArchived));
      const implicit = generatedIdentifier(ns, TYPE, 'kid', 'idx');
      expect(states).toHaveLength(LAYOUT === 'partitioned' ? 2 : 1);
      for (const st of states) expect((await indexState(st.name))?.valid).toBe(true);
      if (LAYOUT === 'partitioned') {
        const own = states.find((x) => x.name !== implicit);
        expect(own?.name).toMatch(/_kid_[0-9a-f]{6}_[0-9a-f]{8}_idx$/);
        expect((await indexState(own?.name ?? ''))?.def).toContain('archived');
      }
    });

    it('identical to the implicit one, is the same index', async () => {
      const { ns } = await fixture();
      const states = kidStates(await reconcile(ns, [{ fields: ['kid'] }], withArchived));
      expect(states.map((x) => x.name)).toEqual([generatedIdentifier(ns, TYPE, 'kid', 'idx')]);
    });

    it('keeps its name across runs', async () => {
      const { ns } = await fixture();
      const decl: IndexDecl = { fields: ['kid'], where: { archived: false } };
      const first = kidStates(await reconcile(ns, [decl], withArchived));
      const second = kidStates(await reconcile(ns, [decl], withArchived));
      expect(second.map((x) => x.name)).toEqual(first.map((x) => x.name));
      expect(second.every((x) => x.outcome === 'unchanged')).toBe(true);
    });
  });

  it('adopts an identical index it did not build', async () => {
    const { ns, target, live } = await fixture();
    const name = `rows_a_${hex()}`;
    await sql.unsafe(
      `CREATE INDEX ${name} ON ${target} (((body ->> 'cert') COLLATE "C"), id) WHERE ${live}`
    );
    const s = (await reconcile(ns, [{ fields: ['cert'], name }])).find((x) => x.name === name);
    expect(s).toMatchObject({ name, outcome: 'adopted', state: 'valid' });
  });

  it('swaps an index whose expression differs, keeping uniqueness enforced throughout', async () => {
    const { ns, ds, target, live } = await fixture();
    const name = `rows_x_${hex()}`;
    await ds.write(TYPE, [
      { id: 'a', kid: 'k1' },
      { id: 'b', kid: 'k2' }
    ]);
    await sql.unsafe(`CREATE UNIQUE INDEX ${name} ON ${target} ((body ->> 'kid')) WHERE ${live}`);

    // An open snapshot holds the concurrent build in its last wait, with both
    // indexes in place.
    const blocker = await sql.reserve();
    await blocker`BEGIN ISOLATION LEVEL REPEATABLE READ`;
    await blocker`SELECT count(*) FROM rows`;
    let swapping: ReturnType<typeof reconcile> | undefined;
    try {
      swapping = reconcile(ns, [{ fields: ['kid'], unique: true, where: 'live', name }]);
      swapping.catch(() => {});
      const swapName = `${name}__swap`;
      for (let i = 0; i < 200 && (await indexState(swapName)) === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(await indexState(swapName)).toBeDefined();
      expect((await indexState(name))?.valid).toBe(true);
      await expect(ds.write(TYPE, [{ id: 'dup1', kid: 'k1' }])).rejects.toThrow(
        /unique|duplicate/i
      );
    } finally {
      await blocker`COMMIT`;
      blocker.release();
    }

    const s = (await (swapping as ReturnType<typeof reconcile>)).find((x) => x.name === name);
    expect(s).toMatchObject({ name, unique: true, outcome: 'swapped', state: 'valid' });
    expect((await indexState(name))?.def).toContain(`COLLATE "C"`);
    expect(await indexState(`${name}__swap`)).toBeUndefined();
    await expect(ds.write(TYPE, [{ id: 'dup2', kid: 'k2' }])).rejects.toThrow(/unique|duplicate/i);
  });

  it('swaps from a valid leftover __swap that no longer matches, never dropping it before its replacement is valid', async () => {
    const { ns, ds, target, live } = await fixture();
    const name = `rows_v_${hex()}`;
    const swapName = `${name}__swap`;
    await ds.write(TYPE, [
      { id: 'a', kid: 'k1' },
      { id: 'b', kid: 'k2' }
    ]);
    // An interrupted earlier swap: the old index is gone and the __swap, built
    // to a since-changed declaration, is the only thing enforcing uniqueness.
    await sql.unsafe(
      `CREATE UNIQUE INDEX ${swapName} ON ${target} ((body ->> 'kid')) WHERE ${live}`
    );

    const blocker = await sql.reserve();
    await blocker`BEGIN ISOLATION LEVEL REPEATABLE READ`;
    await blocker`SELECT count(*) FROM rows`;
    let swapping: ReturnType<typeof reconcile> | undefined;
    try {
      swapping = reconcile(ns, [{ fields: ['kid'], unique: true, where: 'live', name }]);
      swapping.catch(() => {});
      for (let i = 0; i < 200 && (await indexState(name)) === undefined; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(await indexState(name)).toBeDefined();
      expect((await indexState(swapName))?.valid).toBe(true);
      await expect(ds.write(TYPE, [{ id: 'dup1', kid: 'k1' }])).rejects.toThrow(
        /unique|duplicate/i
      );
    } finally {
      await blocker`COMMIT`;
      blocker.release();
    }

    const s = (await (swapping as ReturnType<typeof reconcile>)).find((x) => x.name === name);
    expect(s).toMatchObject({ outcome: 'swapped', state: 'valid' });
    expect((await indexState(name))?.def).toContain(`COLLATE "C"`);
    expect(await indexState(swapName)).toBeUndefined();
    await expect(ds.write(TYPE, [{ id: 'dup2', kid: 'k2' }])).rejects.toThrow(/unique|duplicate/i);
  });

  it('swaps a body-keyed index onto the column once its field is promoted', async () => {
    await addTestPromotedColumns(sql);
    const { ns, target, live } = await fixture();
    const name = `rows_p_${hex()}`;
    await sql.unsafe(`CREATE INDEX ${name} ON ${target} ((body ->> 'status')) WHERE ${live}`);
    const states = await reconcileTypeIndexes(sql, {
      namespace: ns,
      type: TYPE,
      layout: LAYOUT,
      fields: { ...fields, status: { kind: 'scalar', type: 'string' } },
      indexes: [{ fields: ['status'], name }],
      promotedColumns: { status: { column: 'status', kind: 'text' } }
    });
    expect(states.find((x) => x.name === name)).toMatchObject({
      outcome: 'swapped',
      state: 'valid'
    });
    expect((await indexState(name))?.def).toMatch(/\(status COLLATE "C", id\)/);
  });

  describe('a trailing id key', () => {
    /** The key-column list of `def`, which ends `, id` on a non-unique btree. */
    const keyList = (def: string | undefined) =>
      /USING btree \((.*?)\) WHERE /.exec(def ?? '')?.[1];

    it('ends every non-unique btree, ascending, and no unique one', async () => {
      const { ns } = await fixture();
      const single = `rows_s_${hex()}`;
      const composite = `rows_c_${hex()}`;
      const unique = `rows_u_${hex()}`;
      const datey: Record<string, FieldDef> = {
        ...fields,
        observedAt: { kind: 'scalar', type: 'date', indexed: true }
      };
      await reconcile(
        ns,
        [
          { fields: ['cert'], name: single },
          { fields: ['cert', { field: 'observedAt', dir: 'desc' }], name: composite },
          { fields: ['kid'], unique: true, name: unique }
        ],
        datey
      );
      expect(keyList((await indexState(single))?.def)).toBe(
        `((body ->> 'cert'::text)) COLLATE "C", id`
      );
      expect(keyList((await indexState(composite))?.def)).toBe(
        `((body ->> 'cert'::text)) COLLATE "C", substrate_ts((body -> 'observedAt'::text)) DESC NULLS LAST, id`
      );
      expect(keyList((await indexState(unique))?.def)).toBe(`((body ->> 'kid'::text)) COLLATE "C"`);
      if (LAYOUT === 'partitioned') {
        expect(
          keyList((await indexState(generatedIdentifier(ns, TYPE, 'observedAt', 'idx')))?.def)
        ).toBe(`substrate_ts((body -> 'observedAt'::text)) DESC NULLS LAST, id`);
        expect(
          keyList((await indexState(generatedIdentifier(ns, TYPE, 'created_at', 'base')))?.def)
        ).toBe('created_at DESC NULLS LAST, id');
      }
    });

    it('swaps an index of the shape without it in place of conflicting', async () => {
      const { ns, target, live } = await fixture();
      const name = `rows_o_${hex()}`;
      await sql.unsafe(
        `CREATE INDEX ${name} ON ${target} (((body ->> 'cert') COLLATE "C")) WHERE ${live}`
      );
      const s = (await reconcile(ns, [{ fields: ['cert'], name }])).find((x) => x.name === name);
      expect(s).toMatchObject({ name, outcome: 'swapped', state: 'valid' });
      expect(keyList((await indexState(name))?.def)).toBe(
        `((body ->> 'cert'::text)) COLLATE "C", id`
      );
      expect(await indexState(`${name}__swap`)).toBeUndefined();
    });

    it('still refuses an existing non-unique index on a different field', async () => {
      const { ns, target, live } = await fixture();
      const name = `rows_d_${hex()}`;
      await sql.unsafe(
        `CREATE INDEX ${name} ON ${target} (((body ->> 'cert') COLLATE "C")) WHERE ${live}`
      );
      const err = await reconcile(ns, [{ fields: ['kid'], name }]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IndexDefinitionConflictError);
      expect((err as IndexDefinitionConflictError).existing).toContain(`'cert'`);
    });
  });

  describe('expression statistics', () => {
    /** The statistics objects on `target`, with their expressions. */
    const statsOn = async (target: string) =>
      sql<Array<{ name: string; exprs: string[] }>>`
        SELECT stxname AS name, pg_get_statisticsobjdef_expressions(oid) AS exprs
        FROM pg_statistic_ext WHERE stxrelid = to_regclass(${`"${target}"`}) ORDER BY stxname`;
    const ours = (ns: string, field: string) =>
      new RegExp(`^rows_${ns}_t_${field.toLowerCase()}_[0-9a-f]{6}_[0-9a-f]{8}_stat$`);

    it('are created per body-keyed key, once, dropped with the declaration, and nothing else is touched', async () => {
      const { ns, target } = await fixture();
      const foreign = `other_stat_${hex()}`;
      await sql.unsafe(`CREATE STATISTICS ${foreign} ON ((body ->> 'kid')) FROM "${target}"`);
      const decls: IndexDecl[] = [
        { fields: ['cert'], name: `rows_s_${hex()}` },
        { fields: ['kid'], unique: true, name: `rows_u_${hex()}` }
      ];
      await reconcile(ns, decls);
      const after = await statsOn(target);
      const cert = after.find((x) => ours(ns, 'cert').test(x.name));
      const kid = after.find((x) => ours(ns, 'kid').test(x.name));
      expect(cert?.exprs).toEqual([`((body ->> 'cert'::text) COLLATE "C")`]);
      expect(kid?.exprs).toEqual([`((body ->> 'kid'::text) COLLATE "C")`]);

      const again = await reconcileTypeStatistics(sql, {
        namespace: ns,
        type: TYPE,
        layout: LAYOUT,
        fields,
        indexes: decls
      });
      expect(again).toEqual({ created: [], dropped: [], analyzed: false });

      await reconcile(ns, []);
      const left = (await statsOn(target)).map((x) => x.name);
      expect(left).not.toContain(cert?.name);
      expect(left).not.toContain(kid?.name);
      expect(left).toContain(foreign);
      await sql.unsafe(`DROP STATISTICS ${foreign}`);
    });

    it('are not created for a promoted field', async () => {
      await addTestPromotedColumns(sql);
      const { ns, target } = await fixture();
      await reconcileTypeIndexes(sql, {
        namespace: ns,
        type: TYPE,
        layout: LAYOUT,
        fields: { ...fields, status: { kind: 'scalar', type: 'string' } },
        indexes: [
          { fields: ['status'], name: `rows_p_${hex()}` },
          { fields: ['cert'], name: `rows_s_${hex()}` }
        ],
        promotedColumns: { status: { column: 'status', kind: 'text' } }
      });
      const names = (await statsOn(target)).map((x) => x.name);
      expect(names.some((n) => ours(ns, 'cert').test(n))).toBe(true);
      expect(names.some((n) => ours(ns, 'status').test(n))).toBe(false);
    });
  });

  it('refuses a boolean predicate on a field that is not boolean, naming it', async () => {
    const { ns } = await fixture();
    await expect(
      reconcile(ns, [{ fields: ['cert'], where: { kid: false }, name: `rows_b_${hex()}` }])
    ).rejects.toThrow(/'kid'.*boolean/);
  });

  it('reports a non-unique build that fails as failed, unchanged, without throwing', async () => {
    const { ns } = await fixture();
    const name = `rows_f_${hex()}`;
    // A non-index relation holding the name makes the CREATE INDEX fail.
    await sql.unsafe(`CREATE SEQUENCE ${name}`);
    try {
      const states = await reconcile(ns, [{ fields: ['cert'], name }]);
      expect(states.find((x) => x.name === name)).toMatchObject({
        state: 'failed',
        outcome: 'unchanged'
      });
    } finally {
      await sql.unsafe(`DROP SEQUENCE ${name}`);
    }
  });

  it('refuses an existing index of the same name on a different field', async () => {
    const { ns, target, live } = await fixture();
    const name = `rows_y_${hex()}`;
    await sql.unsafe(`CREATE UNIQUE INDEX ${name} ON ${target} ((body ->> 'cert')) WHERE ${live}`);
    const err = await reconcile(ns, [{ fields: ['kid'], unique: true, where: 'live', name }]).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(IndexDefinitionConflictError);
    expect(err).toMatchObject({
      code: 'index_definition_conflict',
      indexName: name,
      name: 'IndexDefinitionConflictError'
    });
    expect((err as IndexDefinitionConflictError).existing).toContain(`'cert'`);
    expect((err as IndexDefinitionConflictError).declared).toContain(`'kid'`);
  });

  it('refuses a unique index over duplicate live values and builds nothing', async () => {
    const { ns, ds } = await fixture();
    const name = `rows_z_${hex()}`;
    await ds.write(TYPE, [
      { id: 'a', kid: 'same' },
      { id: 'b', kid: 'same' },
      { id: 'c', kid: 'other' }
    ]);
    const err = await reconcile(ns, [{ fields: ['kid'], unique: true, where: 'live', name }]).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(UniqueIndexDuplicatesError);
    expect(err).toMatchObject({
      code: 'unique_index_duplicates',
      namespace: ns,
      type: TYPE,
      fields: ['kid'],
      count: 1
    });
    expect(await indexState(name)).toBeUndefined();
  });

  it('drops a leftover INVALID build and builds the index again', async () => {
    const { ns, ds, target, live } = await fixture();
    const name = `rows_w_${hex()}`;
    await ds.write(TYPE, [
      { id: 'a', kid: 'd' },
      { id: 'b', kid: 'd' }
    ]);
    await expect(
      sql.unsafe(
        `CREATE UNIQUE INDEX CONCURRENTLY ${name}__swap ON ${target} (((body ->> 'kid') COLLATE "C")) WHERE ${live}`
      )
    ).rejects.toThrow();
    expect((await indexState(`${name}__swap`))?.valid).toBe(false);
    await ds.purge(TYPE, ['b']);

    const s = (await reconcile(ns, [{ fields: ['kid'], unique: true, where: 'live', name }])).find(
      (x) => x.name === name
    );
    expect(s).toMatchObject({ name, outcome: 'created', state: 'valid' });
    expect(await indexState(`${name}__swap`)).toBeUndefined();
  });

  it.skipIf(LAYOUT !== 'legacy')('legacy: an implicit indexed field creates nothing', async () => {
    const { ns } = await fixture();
    expect(await reconcile(ns, [], kidIndexed)).toEqual([]);
    const made = await sql`
      SELECT 1 FROM pg_indexes
      WHERE schemaname = current_schema() AND indexdef LIKE ${`%'${ns}'%`}`;
    expect(made).toHaveLength(0);
  });

  it.skipIf(LAYOUT !== 'partitioned')(
    'partitioned: implicit, list, json and engine base indexes land on the type partition',
    async () => {
      const { ns, target } = await fixture();
      const states = await reconcile(ns, [], {
        ...kidIndexed,
        n: { kind: 'scalar', type: 'number', indexed: true },
        tags: { kind: 'list', of: { kind: 'scalar', type: 'string' }, indexed: true },
        values: { kind: 'scalar', type: 'json', indexed: true }
      });
      expect(states.every((s) => s.state === 'valid')).toBe(true);
      const defs = (
        await sql<Array<{ def: string }>>`
          SELECT pg_get_indexdef(i.indexrelid) AS def FROM pg_index i
          WHERE i.indrelid = to_regclass(${target})`
      ).map((r) => r.def);
      const expected = [
        `USING btree (((body ->> 'kid'::text)) COLLATE "C", id) WHERE (deleted_at IS NULL)`,
        `USING btree (substrate_num((body -> 'n'::text)), id) WHERE (deleted_at IS NULL)`,
        `USING gin (((body -> 'tags'::text)) jsonb_path_ops) WHERE (deleted_at IS NULL)`,
        `USING gin (((body -> 'values'::text)) jsonb_path_ops) WHERE (deleted_at IS NULL)`,
        `USING btree (created_at DESC NULLS LAST, id) WHERE (deleted_at IS NULL)`,
        `USING btree (updated_at DESC NULLS LAST, id) WHERE (deleted_at IS NULL)`,
        `USING btree (deleted_at) WHERE (deleted_at IS NOT NULL)`
      ];
      for (const e of expected)
        expect(
          defs.some((d) => d.endsWith(e)),
          e
        ).toBe(true);
    }
  );
});
