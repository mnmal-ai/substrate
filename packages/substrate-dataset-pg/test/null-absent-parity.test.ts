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
  ref: field.crossRef(NS, TYPE)
};
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
  beforeAll(() => {
    if (POSTGRES_URL) sql = postgres(POSTGRES_URL, { onnotice: () => {} });
  });
  afterAll(async () => {
    if (!POSTGRES_URL) return;
    await sql`DELETE FROM rows WHERE namespace = ${NS}`;
    await sql.end({ timeout: 5 });
  });

  suite('pg', async () => {
    const pg = new PgDataset({ namespace: NS, sql, typeDefLookup, fieldDefLookup });
    if (PARTITIONED) await pg.ensureTypeStorage(TYPE);
    return pg;
  });
});
