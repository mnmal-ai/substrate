/**
 * An explicit null on a declared scalar or crossRef field reads back as absent,
 * the same on memory and on pg. json and list fields keep their null. Memory
 * always; pg when POSTGRES_URL is set, in whichever layout the run selected.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { field } from '@mnmal-ai/substrate-sdk';
import { type Dataset, type FieldDef, isColumnField, type Row } from '@mnmal-ai/substrate-types';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/pg-dataset.js';
import { findPartition, ident } from '../src/type-storage.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const PARTITIONED = process.env.SUBSTRATE_TEST_LAYOUT === 'partitioned';
const NS = `nullabs_${randomBytes(4).toString('hex')}`;
const TYPE = 'Item';

// Mutable, as the registry entry a `propose_field` adds to: typeDefLookup reads it per call.
const fields: Record<string, FieldDef> = {
  title: field.string(),
  due: field.date(),
  meta: field.json(),
  tags: field.list(field.string()),
  addr: field.struct({ street: field.string() }),
  gone: field.string(),
  ref: field.crossRef(NS, TYPE)
};
// `Other` has no def at all, as a type proposed before its registry entry exists.
const typeDefLookup = (type: string) => (type === TYPE ? { fields } : undefined);
const fieldDefLookup = (type: string, name: string) => (type === TYPE ? fields[name] : undefined);

describe('isColumnField', () => {
  it('is true for string, date and crossRef; false for json, list and a readonly shortId', () => {
    expect(isColumnField(field.string())).toBe(true);
    expect(isColumnField(field.date())).toBe(true);
    expect(isColumnField(field.crossRef(NS, TYPE))).toBe(true);
    expect(isColumnField(field.json())).toBe(false);
    expect(isColumnField(field.list(field.string()))).toBe(false);
    expect(isColumnField(field.number({ indexed: true, readonly: true }))).toBe(false);
  });
});

function suite(label: string, make: () => Dataset | Promise<Dataset>): void {
  describe(label, () => {
    let ds: Dataset;
    beforeAll(async () => {
      ds = await make();
    });

    const read = async (id: string) => {
      const [row] = (await ds.read(TYPE, { id })).rows;
      expect(row).toBeDefined();
      return row as Row;
    };

    it('create {title: null} reads back without title', async () => {
      const id = randomUUID();
      const { rows } = await ds.write(TYPE, [{ id, title: null, ref: null, due: null }]);
      for (const row of [rows[0] as Row, await read(id)]) {
        expect('title' in row).toBe(false);
        expect('ref' in row).toBe(false);
        expect('due' in row).toBe(false);
      }
    });

    it('json field keeps explicit null, and so does a list', async () => {
      const id = randomUUID();
      await ds.write(TYPE, [{ id, meta: null, tags: null }]);
      const row = await read(id);
      expect(row.meta).toBeNull();
      expect(row.tags).toBeNull();
    });

    it('update {title: null} clears a set title', async () => {
      const id = randomUUID();
      await ds.write(TYPE, [{ id, title: 'a' }]);
      expect((await read(id)).title).toBe('a');
      const { rows } = await ds.write(TYPE, [{ id, title: null }]);
      expect('title' in (rows[0] as Row)).toBe(false);
      expect('title' in (await read(id))).toBe(false);
    });

    it('conditionalUpdate match {title: null} matches an absent title', async () => {
      const id = randomUUID();
      await ds.write(TYPE, [{ id }]);
      const r = await ds.conditionalUpdate(TYPE, id, { title: null }, { title: 'x' });
      expect(r.matched).toBe(true);
      expect((await read(id)).title).toBe('x');
    });

    it('a crossRef nulled the way the set_null sweep nulls it reads back absent', async () => {
      const target = randomUUID();
      const referrer = randomUUID();
      await ds.write(TYPE, [{ id: target }, { id: referrer, ref: target }]);
      await ds.tombstone(TYPE, [target]);
      const r = await ds.conditionalUpdate(TYPE, referrer, { ref: target }, { ref: null });
      expect(r.matched).toBe(true);
      expect('ref' in (r.row as Row)).toBe(false);
      expect('ref' in (await read(referrer))).toBe(false);
    });

    it('projecting a json field the row lacks reads absent; one holding null reads null', async () => {
      const lacking = randomUUID();
      const holding = randomUUID();
      await ds.write(TYPE, [{ id: lacking }, { id: holding, meta: null, tags: null }]);
      const project = async (id: string, f: string) =>
        ((await ds.read(TYPE, { id, fields: { [f]: true } })).rows[0] ?? {}) as Row;
      for (const f of ['meta', 'tags', 'addr'])
        expect(f in (await project(lacking, f))).toBe(false);
      expect((await project(holding, 'meta')).meta).toBeNull();
      expect((await project(holding, 'tags')).tags).toBeNull();
    });

    it('projecting a field the def does not declare reads absent when missing, null when stored', async () => {
      const id = randomUUID();
      await ds.write(TYPE, [{ id, undeclared: null }]);
      const [row] = (await ds.read(TYPE, { id, fields: { undeclared: true, nothere: true } })).rows;
      expect((row as Row).undeclared).toBeNull();
      expect('nothere' in (row as Row)).toBe(false);
    });

    it('a type with no def keeps an explicit null', async () => {
      const id = randomUUID();
      const { rows } = await ds.write('Other', [{ id, title: null }]);
      expect((rows[0] as Row).title).toBeNull();
      expect(((await ds.read('Other', { id })).rows[0] as Row).title).toBeNull();
    });

    it("a struct's inner null is kept", async () => {
      const id = randomUUID();
      await ds.write(TYPE, [{ id, addr: { street: null } }]);
      expect((await read(id)).addr).toEqual({ street: null });
    });

    it('a field removed from the def keeps its null', async () => {
      const id = randomUUID();
      await ds.write(TYPE, [{ id, gone: null }]);
      expect('gone' in (await read(id))).toBe(false);
      const removed = fields.gone as FieldDef;
      delete fields.gone;
      try {
        expect((await read(id)).gone).toBeNull();
      } finally {
        fields.gone = removed;
      }
    });

    it('a field added at runtime is absent on rows written before it existed', async () => {
      const ids = [randomUUID(), randomUUID()];
      await ds.write(
        TYPE,
        ids.map((id) => ({ id, title: 'old' }))
      );
      fields.proposed = field.string();
      try {
        for (const id of ids) {
          expect('proposed' in (await read(id))).toBe(false);
          const [projected] = (await ds.read(TYPE, { id, fields: { proposed: true } })).rows;
          expect('proposed' in (projected as Row)).toBe(false);
        }
      } finally {
        delete fields.proposed;
      }
    });
  });
}

suite('null reads absent (memory)', () =>
  new MemoryDataset({ namespace: NS, typeDefLookup, fieldDefLookup }));

describe.skipIf(!POSTGRES_URL)('null reads absent (pg)', () => {
  let sql: ReturnType<typeof postgres>;
  let pg: PgDataset;
  beforeAll(() => {
    if (!POSTGRES_URL) return;
    sql = postgres(POSTGRES_URL, { onnotice: () => {} });
    pg = new PgDataset({ namespace: NS, sql, typeDefLookup, fieldDefLookup });
  });
  afterAll(async () => {
    if (!POSTGRES_URL) return;
    await pg.dropNamespace();
    // dropNamespace empties the partitions but keeps them.
    const nsPart = await findPartition(sql, 'rows', NS);
    if (nsPart !== undefined) await sql.unsafe(`DROP TABLE IF EXISTS ${ident(nsPart)} CASCADE`);
    await sql.end({ timeout: 5 });
  });

  suite('pg', async () => {
    if (PARTITIONED) await pg.ensureTypeStorage(TYPE);
    return pg;
  });

  // The projection stands a marker in for a key the row lacks and `materialize`
  // drops it. None of these read shapes may let it out.
  describe('a projected key the row lacks, under each read shape', () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    const where = { id: { in: ids } };
    const fieldsHint = { title: true, meta: true };

    beforeAll(async () => {
      if (PARTITIONED) await pg.ensureTypeStorage(TYPE);
      await pg.write(
        TYPE,
        ids.map((id, n) => ({ id, title: `t${n}` }))
      );
    });

    const clean = (result: unknown, rows: Row[]) => {
      expect(JSON.stringify(result)).not.toContain('$absent:');
      for (const row of rows) expect('meta' in row).toBe(false);
    };

    it('a page with hasMore and nextCursor, then the page after it', async () => {
      const params = { where, fields: fieldsHint, orderBy: [{ title: 'asc' }] as never, limit: 2 };
      const first = await pg.read(TYPE, params);
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toBeDefined();
      clean(first, first.rows);
      const second = await pg.read(TYPE, { ...params, cursor: first.nextCursor as string });
      expect(second.rows).toHaveLength(1);
      clean(second, second.rows);
    });

    it('the joinShortIds shape', async () => {
      const result = await pg.read(TYPE, {
        where,
        fields: fieldsHint,
        orderBy: [{ shortId: 'asc' }] as never,
        limit: 2
      });
      expect(result.rows).toHaveLength(2);
      clean(result, result.rows);
    });

    // Walks run only on the partitioned layout.
    it.skipIf(!PARTITIONED)('a nested walk list and an _agg', async () => {
      const [parent, child] = ids as [string, string, string];
      await pg.write(TYPE, [{ id: child, title: 't-child', ref: parent }]);
      const into = `${NS}/${TYPE}.ref`;
      const result = await pg.read(TYPE, {
        where: { id: { eq: parent } },
        fields: fieldsHint,
        nested: { kids: { _walk: { in: into }, fields: { title: true }, limit: 5 } } as never,
        agg: { n: { in: into, count: true } } as never
      });
      expect(result.rows).toHaveLength(1);
      clean(result, result.rows);
      expect(result.rows[0]).toMatchObject({ kids: [{ title: 't-child' }], _agg: { n: 1 } });
    });
  });
});
