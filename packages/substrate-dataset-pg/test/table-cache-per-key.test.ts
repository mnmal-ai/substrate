/**
 * The table cache drops per key (Todo #1890): a catalog notification for one
 * type, arriving while another type's descriptor loads, does not stop that
 * load being cached; one for the loading type does. The load is held open
 * through a wrapped `loadTypeTable` while the notification is delivered.
 */

import { randomBytes } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ afterLoad: null as null | (() => Promise<void>) }));
vi.mock('../src/type-table.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/type-table.js')>();
  return {
    ...actual,
    loadTypeTable: async (...args: Parameters<typeof actual.loadTypeTable>) => {
      const table = await actual.loadTypeTable(...args);
      const hook = hooks.afterLoad;
      hooks.afterLoad = null;
      await hook?.();
      return table;
    }
  };
});

const { PgDataset } = await import('../src/index.js');
const { tableCacheFor } = await import('../src/type-table.js');
const { dropNamespace } = await import('./_layout.js');

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('the table cache drops per key (pg)', () => {
  let sqlA: Sql;
  let sqlB: Sql;
  let ns: string;
  const namespaces: string[] = [];
  let b: InstanceType<typeof PgDataset>;

  /** Notifies `type` from A and waits until B's listener has dropped it. */
  const notify = async (type: string) => {
    const tables = tableCacheFor(sqlB).tables;
    await sqlA`SELECT pg_notify('substrate_catalog', ${`${ns}/${type}`})`;
    for (let i = 0; tables.has(`${ns}/${type}`); i++) {
      if (i > 200) throw new Error(`no notification for ${type}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  beforeAll(() => {
    sqlA = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    sqlB = postgres(POSTGRES_URL as string, { onnotice: () => {} });
  });
  afterAll(async () => {
    hooks.afterLoad = null;
    for (const n of namespaces) await dropNamespace(sqlA, n);
    await sqlA.end({ timeout: 5 });
    await sqlB.end({ timeout: 5 });
  });
  beforeEach(async () => {
    ns = `pk_${randomBytes(4).toString('hex')}`;
    namespaces.push(ns);
    const a = new PgDataset({ namespace: ns, sql: sqlA });
    await a.write('TA', [{ id: 'a1' }]);
    await a.write('TB', [{ id: 'b1' }]);
    b = new PgDataset({ namespace: ns, sql: sqlB });
    await b.read('TB', {}); // B listens, and caches TB so its drop is observable
    expect(tableCacheFor(sqlB).tables.has(`${ns}/TB`)).toBe(true);
  });

  it("another type's notification during a load does not stop it being cached", async () => {
    hooks.afterLoad = () => notify('TB');
    await b.read('TA', {});
    expect(tableCacheFor(sqlB).tables.has(`${ns}/TA`)).toBe(true);
  });

  it("the loading type's own notification does", async () => {
    hooks.afterLoad = async () => {
      await b.read('TA', {}); // a nested read caches TA, so its drop is observable
      await notify('TA');
    };
    await b.read('TA', {});
    expect(tableCacheFor(sqlB).tables.has(`${ns}/TA`)).toBe(false);
  });
});
