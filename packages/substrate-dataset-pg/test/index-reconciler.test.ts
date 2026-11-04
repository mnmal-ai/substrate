/**
 * `reconcileTypeIndexes`: declared indexes are created, left alone when
 * identical, swapped without a gap in uniqueness when only the expression
 * differs, refused when anything else differs, refused over duplicate live
 * values, and rebuilt when a failed concurrent build left one INVALID.
 */

import { randomBytes } from 'node:crypto';
import { DEFAULT_ORDERED_BY, type FieldDef, type OrderedBy } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type IndexDecl,
  IndexDefinitionConflictError,
  PgDataset,
  reconcileTypeIndexes,
  UniqueIndexDuplicatesError
} from '../src/index.js';
import { desiredIndexKeys } from '../src/index-reconciler.js';
import { columnName } from '../src/layout.js';
import { generatedIdentifier, withMigrationLock, withTableIndexLock } from '../src/migrate.js';
import { ensureTypeTable, typeTableOf } from '../src/type-table.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
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

/** `p`, or a rejection once `ms` pass: a wait on a held lock fails rather than hangs. */
const within = <T>(ms: number, p: Promise<T>): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms).unref()
    )
  ]);

/**
 * Every field this file declares gets its column at the type table's CREATE,
 * so an index keys on it; `kid` is text there, whatever kind a test declares it.
 */
const TABLE_FIELDS: Record<string, FieldDef> = {
  ...fields,
  archived: { kind: 'scalar', type: 'boolean' },
  n: { kind: 'scalar', type: 'number' },
  owner: { kind: 'crossRef', ns: 'x', type: 'Owner', onDelete: 'set_null' },
  boughtOn: { kind: 'scalar', type: 'date' }
};

/** Key expressions as pg deparses them: each field's column. */
const KEY = {
  cert: columnName('cert'),
  kid: columnName('kid'),
  observedAt: columnName('observedAt'),
  owner: columnName('owner'),
  boughtOn: columnName('boughtOn')
};
/** Index keys a test builds by hand, as it writes them. */
const HAND = { cert: 'f_cert', certPlain: 'f_cert', kid: 'f_kid', kidCollated: 'f_kid' };
/**
 * A hand-built `(f_kid)` keys as the reconciler's does, so its predicate
 * differs instead, which makes it a swap rather than a match.
 */
const otherLive = (live: string): string => `${live} AND id IS NOT NULL`;
/** A statement that opens a snapshot, so a concurrent build waits for it. */
const SNAPSHOT = 'SELECT 1';

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
  await ensureTypeTable(sql, {
    namespace: ns,
    type: TYPE,
    fields: TABLE_FIELDS,
    newFields: 'column',
    enforceUuidCheck: false
  });
  const target = await typeTableOf(sql, ns, TYPE);
  if (target === undefined) throw new Error('type table missing');
  return { ns, ds, target, live: 'deleted_at IS NULL' };
}

const reconcile = (
  ns: string,
  indexes: IndexDecl[],
  f: Record<string, FieldDef> = fields,
  orderedBy: OrderedBy = DEFAULT_ORDERED_BY
) =>
  reconcileTypeIndexes(sql, {
    namespace: ns,
    type: TYPE,
    fields: f,
    indexes,
    orderedBy
  });

async function indexState(name: string) {
  const [row] = await sql<Array<{ valid: boolean; def: string }>>`
    SELECT i.indisvalid AND i.indisready AS valid, pg_get_indexdef(i.indexrelid) AS def
    FROM pg_index i WHERE i.indexrelid = to_regclass(${name})`;
  return row;
}

describe.skipIf(!POSTGRES_URL)('reconcileTypeIndexes', () => {
  it('reports a type with no unique index in the unique pass without taking the migration lock', async () => {
    const { ns } = await fixture();
    // Held here, so a pass that waited for it would never return.
    const states = await withMigrationLock(sql, () =>
      reconcileTypeIndexes(
        sql,
        {
          namespace: ns,
          type: TYPE,
          fields: kidIndexed,
          indexes: [],
          orderedBy: DEFAULT_ORDERED_BY
        },
        { only: 'unique' }
      )
    );
    const kid = generatedIdentifier(ns, TYPE, 'kid', 'idx');
    expect(states.find((s) => s.name === kid)).toMatchObject({ state: 'pending', unique: false });
  });

  it('reconciles a unique index already as declared without taking the migration lock', async () => {
    const { ns } = await fixture();
    const name = `rows_u_${hex()}`;
    const decl = [{ fields: ['kid'], unique: true, where: 'live' as const, name }];
    await reconcile(ns, decl);
    // Held here, so a pass that waited for it would never return.
    const states = await withMigrationLock(sql, () => within(5000, reconcile(ns, decl)));
    expect(states.find((s) => s.name === name)).toMatchObject({
      state: 'valid',
      outcome: 'unchanged'
    });
  });

  it('a unique build waiting on its table holds no migration lock: an unrelated type reconciles meanwhile', async () => {
    const a = await fixture();
    const b = await fixture();
    const nameA = `rows_ua_${hex()}`;
    const nameB = `rows_ub_${hex()}`;
    const conn = await sql.reserve();
    let first: Promise<unknown> | undefined;
    try {
      // Stands in for a long build on A's table.
      await withTableIndexLock(sql, conn, a.target, undefined, async () => {
        first = reconcile(a.ns, [{ fields: ['kid'], unique: true, where: 'live', name: nameA }]);
        first.catch(() => undefined);
        // A takes the migration lock (polled every 250 ms), decides, and waits on its table.
        await new Promise((r) => setTimeout(r, 1000));
        const states = await within(
          5000,
          reconcile(b.ns, [{ fields: ['kid'], unique: true, where: 'live', name: nameB }])
        );
        expect(states.find((s) => s.name === nameB)).toMatchObject({ state: 'valid' });
        expect(await indexState(nameA)).toBeUndefined();
      });
    } finally {
      conn.release();
    }
    const states = (await first) as Awaited<ReturnType<typeof reconcile>>;
    expect(states.find((s) => s.name === nameA)).toMatchObject({
      state: 'valid',
      outcome: 'created'
    });
  });

  it('reports an unbuilt non-unique index on a column the table lacks yet as pending in the unique pass', async () => {
    const { ns } = await fixture();
    const states = await reconcileTypeIndexes(
      sql,
      {
        namespace: ns,
        type: TYPE,
        fields: { ...fields, phase: { kind: 'scalar', type: 'string', indexed: true } },
        indexes: [],
        orderedBy: DEFAULT_ORDERED_BY
      },
      { only: 'unique' }
    );
    const phase = generatedIdentifier(ns, TYPE, 'phase', 'idx');
    expect(states.find((s) => s.name === phase)).toMatchObject({ state: 'pending', unique: false });
  });

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
    expect(state?.def).toContain(`${KEY.observedAt} DESC NULLS LAST`);

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
      expect(states).toHaveLength(2);
      for (const st of states) expect((await indexState(st.name))?.valid).toBe(true);
      const own = states.find((x) => x.name !== implicit);
      expect(own?.name).toMatch(/_kid_[0-9a-f]{6}_[0-9a-f]{8}_idx$/);
      expect((await indexState(own?.name ?? ''))?.def).toContain('archived');
    });

    it('on a crossRef, a plain one-field declaration is its derived index', async () => {
      const { ns } = await fixture();
      // Spec rule (derived keys): the derived (kid, created_at DESC, id) serves
      // it, and a crossRef never sorts, so no second (kid, id) is built.
      const refKid: Record<string, FieldDef> = {
        ...withArchived,
        kid: { kind: 'crossRef', ns: 'x', type: 'K', onDelete: 'set_null' }
      };
      const states = kidStates(await reconcile(ns, [{ fields: ['kid'] }], refKid));
      expect(states.map((x) => x.name)).toEqual([generatedIdentifier(ns, TYPE, 'kid', 'idx')]);
    });

    it('identical to the implicit one, is the same index', async () => {
      const { ns } = await fixture();
      // Spec rule (derived keys): a derived index is (field, natural key, id),
      // so a one-field declaration matches it only on the natural-order field,
      // whose derived index is (field DIR, id).
      const withN: Record<string, FieldDef> = {
        ...withArchived,
        n: { kind: 'scalar', type: 'number', indexed: true }
      };
      const states = (await reconcile(ns, [{ fields: ['n'] }], withN, { n: 'asc' })).filter(
        (x) => x.fields.join() === 'n'
      );
      expect(states.map((x) => x.name)).toEqual([generatedIdentifier(ns, TYPE, 'n', 'idx')]);
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
    await sql.unsafe(`CREATE INDEX ${name} ON ${target} (${HAND.cert}, id) WHERE ${live}`);
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
    await sql.unsafe(
      `CREATE UNIQUE INDEX ${name} ON ${target} (${HAND.kid}) WHERE ${otherLive(live)}`
    );

    // An open snapshot holds the concurrent build in its last wait, with both
    // indexes in place.
    const blocker = await sql.reserve();
    await blocker`BEGIN ISOLATION LEVEL REPEATABLE READ`;
    await blocker.unsafe(SNAPSHOT);
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
    expect((await indexState(name))?.def).toContain(`(f_kid) WHERE (deleted_at IS NULL)`);
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
      `CREATE UNIQUE INDEX ${swapName} ON ${target} (${HAND.kid}) WHERE ${otherLive(live)}`
    );

    const blocker = await sql.reserve();
    await blocker`BEGIN ISOLATION LEVEL REPEATABLE READ`;
    await blocker.unsafe(SNAPSHOT);
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
    expect((await indexState(name))?.def).toContain(`(f_kid) WHERE (deleted_at IS NULL)`);
    expect(await indexState(swapName)).toBeUndefined();
    await expect(ds.write(TYPE, [{ id: 'dup2', kid: 'k2' }])).rejects.toThrow(/unique|duplicate/i);
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
      expect(keyList((await indexState(single))?.def)).toBe(`${KEY.cert}, id`);
      expect(keyList((await indexState(composite))?.def)).toBe(
        `${KEY.cert}, ${KEY.observedAt} DESC NULLS LAST, id`
      );
      expect(keyList((await indexState(unique))?.def)).toBe(KEY.kid);
      // Spec rule (derived keys): the natural key replaces the implicit date
      // DESC rule, so a date field is ascending, then created_at.
      expect(
        keyList((await indexState(generatedIdentifier(ns, TYPE, 'observedAt', 'idx')))?.def)
      ).toBe(`${KEY.observedAt}, created_at DESC NULLS LAST, id`);
      expect(
        keyList((await indexState(generatedIdentifier(ns, TYPE, 'created_at', 'base')))?.def)
      ).toBe('created_at DESC NULLS LAST, id');
    });

    it('swaps an index of the shape without it in place of conflicting', async () => {
      const { ns, target, live } = await fixture();
      const name = `rows_o_${hex()}`;
      await sql.unsafe(`CREATE INDEX ${name} ON ${target} (${HAND.cert}) WHERE ${live}`);
      const s = (await reconcile(ns, [{ fields: ['cert'], name }])).find((x) => x.name === name);
      expect(s).toMatchObject({ name, outcome: 'swapped', state: 'valid' });
      expect(keyList((await indexState(name))?.def)).toBe(`${KEY.cert}, id`);
      expect(await indexState(`${name}__swap`)).toBeUndefined();
    });

    it('still refuses an existing non-unique index on a different field, failing it alone', async () => {
      const { ns, target, live } = await fixture();
      const name = `rows_d_${hex()}`;
      const after = `rows_e_${hex()}`;
      await sql.unsafe(`CREATE INDEX ${name} ON ${target} (${HAND.cert}) WHERE ${live}`);
      const states = await reconcile(ns, [
        { fields: ['kid'], name },
        { fields: ['observedAt'], name: after }
      ]);
      expect(states.find((x) => x.name === name)).toMatchObject({
        state: 'failed',
        error: `index_definition_conflict: ${name} exists with a different definition; drop or rename it`
      });
      expect(keyList((await indexState(name))?.def)).toContain('f_cert');
      // The declaration after it, and the type's statistics, still reconcile.
      expect(states.find((x) => x.name === after)).toMatchObject({ state: 'valid' });
      const [stats] = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_statistic_ext
        WHERE obj_description(oid, 'pg_statistic_ext') = ${`substrate: statistics of ${JSON.stringify([ns, TYPE])}`}`;
      // A column key has column statistics, so no object is built.
      expect(stats?.n).toBe(0);
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
    await sql.unsafe(`CREATE UNIQUE INDEX ${name} ON ${target} (${HAND.certPlain}) WHERE ${live}`);
    const err = await reconcile(ns, [{ fields: ['kid'], unique: true, where: 'live', name }]).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(IndexDefinitionConflictError);
    expect(err).toMatchObject({
      code: 'index_definition_conflict',
      indexName: name,
      name: 'IndexDefinitionConflictError'
    });
    expect((err as IndexDefinitionConflictError).existing).toContain('f_cert');
    expect((err as IndexDefinitionConflictError).declared).toContain('f_kid');
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
        `CREATE UNIQUE INDEX CONCURRENTLY ${name}__swap ON ${target} (${HAND.kidCollated}) WHERE ${live}`
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

  describe('on a type table', () => {
    it('declared index keys columns: CREATE INDEX … (f_cert, f_observedat DESC, id) WHERE deleted_at IS NULL', async () => {
      const { ns, target } = await fixture();
      const name = `rows_c_${hex()}`;
      await reconcile(ns, [{ fields: ['cert', { field: 'observedAt', dir: 'desc' }], name }]);
      const state = await indexState(name);
      expect(state?.valid).toBe(true);
      expect(state?.def).toMatch(new RegExp(`^CREATE INDEX ${name} ON \\S+\\.${target} `));
      expect(state?.def).toMatch(
        /USING btree \(f_cert, f_observedat_[0-9a-f]{8} DESC NULLS LAST, id\) WHERE \(deleted_at IS NULL\)$/
      );
    });

    it('implicit, list, json and engine base indexes land on the type table, with no statistics object', async () => {
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
        `USING btree (f_kid, created_at DESC NULLS LAST, id) WHERE (deleted_at IS NULL)`,
        `USING btree (f_n, created_at DESC NULLS LAST, id) WHERE (deleted_at IS NULL)`,
        `USING gin (((extra -> 'tags'::text)) jsonb_path_ops) WHERE (deleted_at IS NULL)`,
        `USING gin (((extra -> 'values'::text)) jsonb_path_ops) WHERE (deleted_at IS NULL)`,
        `USING btree (created_at DESC NULLS LAST, id) WHERE (deleted_at IS NULL)`,
        `USING btree (updated_at DESC NULLS LAST, id) WHERE (deleted_at IS NULL)`,
        `USING btree (deleted_at) WHERE (deleted_at IS NOT NULL)`
      ];
      for (const e of expected)
        expect(
          defs.some((d) => d.endsWith(e)),
          e
        ).toBe(true);
      const [stats] = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_statistic_ext WHERE stxrelid = to_regclass(${target})`;
      expect(stats?.n).toBe(0);
    });

    it('a boolean or null predicate compares the column', async () => {
      const { ns } = await fixture();
      const name = `rows_b_${hex()}`;
      await reconcile(
        ns,
        [{ fields: ['kid'], unique: true, where: { archived: false, observedAt: null }, name }],
        TABLE_FIELDS
      );
      expect((await indexState(name))?.def).toMatch(
        /USING btree \(f_kid\) WHERE \(\(deleted_at IS NULL\) AND \(f_archived = false\) AND \(f_observedat_[0-9a-f]{8} IS NULL\)\)$/
      );
    });

    it('an index reading a column the table lacks yet (a pending field) waits, pending, until it exists', async () => {
      const { ns, target } = await fixture();
      const late: Record<string, FieldDef> = {
        ...fields,
        phase: { kind: 'scalar', type: 'string', indexed: true }
      };
      const uniq = `rows_l_${hex()}`;
      const decls: IndexDecl[] = [{ fields: ['phase'], unique: true, name: uniq }];
      const phase = generatedIdentifier(ns, TYPE, 'phase', 'idx');
      const before = await reconcile(ns, decls, late);
      expect(before.find((s) => s.name === phase)).toMatchObject({ state: 'pending' });
      expect(before.find((s) => s.name === uniq)).toMatchObject({ state: 'pending', unique: true });
      expect(await indexState(phase)).toBeUndefined();
      await sql.unsafe(`ALTER TABLE ${target} ADD COLUMN f_phase text COLLATE "C"`);
      const after = await reconcile(ns, decls, late);
      expect(after.find((s) => s.name === phase)).toMatchObject({
        state: 'valid',
        outcome: 'created'
      });
      expect(after.find((s) => s.name === uniq)).toMatchObject({
        state: 'valid',
        outcome: 'created'
      });
    });

    it('unique index on Key.kid where revokedAt null rejects a second live kid', async () => {
      // `_system/Key`'s declaration (substrate-compose `_system/types.ts`), on a namespace of its own.
      const ns = `ir_${hex()}`;
      const keyDef = {
        fields: {
          kid: { kind: 'scalar', type: 'string' },
          name: { kind: 'scalar', type: 'string' },
          revokedAt: { kind: 'scalar', type: 'date', nullable: true }
        } satisfies Record<string, FieldDef>,
        indexes: [
          {
            name: 'substrate_key_live_kid_uniq',
            fields: ['kid'],
            unique: true,
            where: { revokedAt: null }
          }
        ] satisfies IndexDecl[]
      };
      const ds = new PgDataset({
        namespace: ns,
        sql,
        typeDefLookup: (type) => (type === 'Key' ? keyDef : undefined)
      });
      await ds.ensureTypeStorage('Key');
      expect((await ds.describeStorage('Key')).indexes).toContainEqual(
        expect.objectContaining({
          name: 'substrate_key_live_kid_uniq',
          unique: true,
          state: 'valid'
        })
      );
      const kid = `k-${hex()}`;
      await ds.write('Key', [{ id: `${kid}-1`, kid, name: 'one' }]);
      // A revoked key may share the kid.
      await ds.write('Key', [
        { id: `${kid}-2`, kid, name: 'revoked', revokedAt: '2026-01-01T00:00:00.000Z' }
      ]);
      const err = await ds
        .write('Key', [{ id: `${kid}-4`, kid, name: 'second live' }])
        .catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe('unique_violation');
      expect((err as Error).message).toContain('substrate_key_live_kid_uniq');
      expect((err as Error).message).toContain('(kid)');
      // Once the live key is tombstoned, a new live one may take the kid.
      await ds.tombstone('Key', [`${kid}-1`]);
      await ds.write('Key', [{ id: `${kid}-5`, kid, name: 'replacement' }]);
      const { rows } = await ds.read('Key', { where: { kid: { eq: kid } } });
      expect(rows.map((r) => r.id).sort()).toEqual([`${kid}-2`, `${kid}-5`]);
    });
  });

  describe('derived indexes in natural order', () => {
    const withRef: Record<string, FieldDef> = {
      ...fields,
      owner: { kind: 'crossRef', ns: 'x', type: 'Owner', onDelete: 'set_null' },
      boughtOn: { kind: 'scalar', type: 'date' }
    };
    const ownerIdx = (ns: string) => generatedIdentifier(ns, TYPE, 'owner', 'idx');
    const bought = `${KEY.boughtOn} DESC NULLS LAST`;

    it('a crossRef index is (ref, created_at DESC NULLS LAST, id) by default', async () => {
      const { ns } = await fixture();
      const s = (await reconcile(ns, [], withRef)).find((x) => x.name === ownerIdx(ns));
      expect(s).toMatchObject({ fields: ['owner'], state: 'valid', outcome: 'created' });
      expect((await indexState(ownerIdx(ns)))?.def).toContain(
        `(${KEY.owner}, created_at DESC NULLS LAST, id) WHERE `
      );
    });

    it('a crossRef index follows a declared orderedBy body date', async () => {
      const { ns } = await fixture();
      await reconcile(ns, [], withRef, { boughtOn: 'desc' });
      expect((await indexState(ownerIdx(ns)))?.def).toContain(`${KEY.owner}, ${bought}, id)`);
    });

    it('a crossRef declared indexed:false gets no derived index', async () => {
      const { ns } = await fixture();
      const states = await reconcile(ns, [], {
        ...withRef,
        owner: { kind: 'crossRef', ns: 'x', type: 'Owner', onDelete: 'set_null', indexed: false }
      });
      expect(states.map((x) => x.name)).not.toContain(ownerIdx(ns));
      expect(await indexState(ownerIdx(ns))).toBeUndefined();
    });

    it('changing orderedBy swaps the derived index in place', async () => {
      const { ns, ds } = await fixture();
      await reconcile(ns, [], withRef);
      const N = 50;
      await ds.write(
        TYPE,
        Array.from({ length: N }, (_, i) => ({
          id: `r${i}`,
          owner: 'o1',
          boughtOn: new Date(Date.UTC(2026, 0, 1 + i)).toISOString()
        }))
      );
      // An open snapshot holds the concurrent build in its last wait, mid-swap.
      const blocker = await sql.reserve();
      await blocker`BEGIN ISOLATION LEVEL REPEATABLE READ`;
      await blocker.unsafe(SNAPSHOT);
      let swapping: ReturnType<typeof reconcile> | undefined;
      try {
        swapping = reconcile(ns, [], withRef, { boughtOn: 'desc' });
        swapping.catch(() => {});
        const swapName = `${ownerIdx(ns)}__swap`;
        for (let i = 0; i < 200 && (await indexState(swapName)) === undefined; i++) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(await indexState(swapName)).toBeDefined();
        const during = await ds.read(TYPE, { where: { owner: { eq: 'o1' } }, limit: 1000 });
        expect(during.rows).toHaveLength(N);
      } finally {
        await blocker`COMMIT`;
        blocker.release();
      }
      const s = (await (swapping as ReturnType<typeof reconcile>)).find(
        (x) => x.name === ownerIdx(ns)
      );
      expect(s).toMatchObject({ outcome: 'swapped', state: 'valid' });
      expect((await indexState(ownerIdx(ns)))?.def).toContain(`${KEY.owner}, ${bought}, id)`);
      expect(await indexState(`${ownerIdx(ns)}__swap`)).toBeUndefined();
    });

    it('on the natural-order field itself, the key is (field DIR NULLS LAST, id)', async () => {
      const { ns } = await fixture();
      await reconcile(
        ns,
        [],
        { ...withRef, boughtOn: { kind: 'scalar', type: 'date', indexed: true } },
        { boughtOn: 'desc' }
      );
      expect((await indexState(generatedIdentifier(ns, TYPE, 'boughtOn', 'idx')))?.def).toContain(
        `USING btree (${KEY.boughtOn} DESC NULLS LAST, id) WHERE `
      );
    });
  });
});

describe('desiredIndexKeys', () => {
  const args = (orderedBy: OrderedBy = DEFAULT_ORDERED_BY) => ({
    namespace: 'n',
    type: TYPE,
    fields: {
      ...kidIndexed,
      owner: { kind: 'crossRef', ns: 'n', type: 'U' } as FieldDef
    },
    indexes: [{ fields: ['cert', { field: 'observedAt', dir: 'desc' as const }] }],
    orderedBy
  });
  const keysOf = (orderedBy?: OrderedBy) => desiredIndexKeys(args(orderedBy)).map((s) => s.keys);

  it('gives a derived index its field then the natural order, and a declaration its own keys', () => {
    const keys = keysOf();
    expect(keys).toContainEqual([
      ['kid', 'asc'],
      ['createdAt', 'desc']
    ]);
    expect(keys).toContainEqual([
      ['owner', 'asc'],
      ['createdAt', 'desc']
    ]);
    expect(keys).toContainEqual([
      ['cert', 'asc'],
      ['observedAt', 'desc']
    ]);
  });

  it('follows a declared natural order, and has the metadata order keys', () => {
    expect(keysOf({ observedAt: 'asc' })).toContainEqual([
      ['kid', 'asc'],
      ['observedAt', 'asc']
    ]);
    expect(keysOf()).toContainEqual([['createdAt', 'desc']]);
    expect(keysOf()).toContainEqual([['updatedAt', 'desc']]);
  });

  it("carries a partial declaration's predicate, which a read must match", () => {
    const keys = desiredIndexKeys({
      ...args(),
      fields: { ...kidIndexed, archived: { kind: 'scalar', type: 'boolean' } },
      indexes: [{ fields: ['cert'], where: { archived: false } }]
    });
    expect(keys.find((k) => k.keys[0]?.[0] === 'cert')?.only).toEqual({ archived: false });
    expect(keys.find((k) => k.keys[0]?.[0] === 'kid')?.only).toBeUndefined();
  });
});
