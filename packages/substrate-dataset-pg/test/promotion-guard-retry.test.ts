/**
 * The guarded write's retry budget (audit #1, fix round 1). The catalog version
 * is bumped between each reload and its retry, through a wrapped
 * `loadTypeTable`, as a sweep promoting several fields bumps it once per step:
 * one bump more than the first refusal still lands; refused on every attempt,
 * the write throws and writes nothing. B's pool is deaf, as in
 * promotion-stale-descriptor.test.ts.
 */

import { randomBytes } from 'node:crypto';
import { field } from '@mnmal-ai/substrate-sdk';
import type { FieldDef } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ afterLoad: null as null | (() => Promise<void>) }));
vi.mock('../src/type-table.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/type-table.js')>();
  return {
    ...actual,
    loadTypeTable: async (...args: Parameters<typeof actual.loadTypeTable>) => {
      const table = await actual.loadTypeTable(...args);
      await hooks.afterLoad?.();
      return table;
    }
  };
});

const { PgDataset } = await import('../src/index.js');
const { tableCacheFor } = await import('../src/type-table.js');
const { dropNamespace } = await import('./_layout.js');

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)(
  'a guarded write retried while the version keeps advancing (pg)',
  () => {
    let sqlA: Sql;
    let sqlB: Sql;
    let ns: string;
    const namespaces: string[] = [];
    const defs: Record<string, { fields: Record<string, FieldDef> }> = {};
    const lookup = { typeDefLookup: (type: string) => defs[type] };
    let b: InstanceType<typeof PgDataset>;
    let a: InstanceType<typeof PgDataset>;

    const bump = () =>
      sqlA`UPDATE substrate_type_tables SET version = version + 1 WHERE namespace = ${ns} AND type = 'Note'`;
    /** Bumps the version after each of B's next `n` reloads. */
    const bumpAfterReloads = (n: number) => {
      let left = n;
      hooks.afterLoad = async () => {
        if (left-- > 0) await bump();
      };
    };

    beforeAll(() => {
      sqlA = postgres(POSTGRES_URL as string, { onnotice: () => {} });
      sqlB = postgres(POSTGRES_URL as string, { onnotice: () => {} });
      tableCacheFor(sqlB).listening = Promise.resolve(true);
    });
    afterAll(async () => {
      hooks.afterLoad = null;
      for (const n of namespaces) await dropNamespace(sqlA, n);
      await sqlA.end({ timeout: 5 });
      await sqlB.end({ timeout: 5 });
    });
    beforeEach(async () => {
      hooks.afterLoad = null;
      ns = `gr_${randomBytes(4).toString('hex')}`;
      namespaces.push(ns);
      defs.Note = { fields: { title: field.string() } };
      a = new PgDataset({ namespace: ns, sql: sqlA, ...lookup });
      b = new PgDataset({ namespace: ns, sql: sqlB, ...lookup });
      await a.write('Note', [{ id: 'n1', title: 'a' }]);
      await b.read('Note', {}); // B caches the table at its version
      await bump(); // which B never hears of
    });

    it('two bumps after the first check: refused twice, the third attempt lands', async () => {
      bumpAfterReloads(1);
      await b.write('Note', [{ id: 'n1', title: 'b' }]);
      expect((await a.read('Note', { ids: ['n1'] })).rows.map((r) => r.title)).toEqual(['b']);
    });

    it('refused on all three attempts: throws, and nothing is written', async () => {
      bumpAfterReloads(2);
      await expect(b.write('Note', [{ id: 'n1', title: 'c' }])).rejects.toThrow(
        /changed on each of 3 attempts at a write; nothing was written/
      );
      expect((await a.read('Note', { ids: ['n1'] })).rows.map((r) => r.title)).toEqual(['a']);
    });
  }
);
