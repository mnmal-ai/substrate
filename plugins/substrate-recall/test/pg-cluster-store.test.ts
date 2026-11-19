/**
 * PgClusterStore SQL-shape tests, against a stub `Sql`. Behaviour is covered
 * by cluster-store-parity.test.ts against a live database.
 */

import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { PgClusterStore } from '../src/pg-cluster-store.js';

function makeFakeSql(): { sql: Sql; texts: string[] } {
  const texts: string[] = [];
  const fn = Object.assign(
    async (strings: TemplateStringsArray) => {
      texts.push(strings.join('?'));
      return [];
    },
    { begin: async (cb: (tx: unknown) => Promise<unknown>) => cb(fn) }
  );
  return { sql: fn as unknown as Sql, texts };
}

describe('PgClusterStore.attachMembers', () => {
  it('inserts every member in one statement', async () => {
    const { sql, texts } = makeFakeSql();
    const store = new PgClusterStore({ sql });
    await store.attachMembers(
      Array.from({ length: 50 }, (_, i) => ({
        id: `m${i}`,
        clusterId: 'c1',
        ref: { namespace: 'cortext', type: 'Decision', id: `d${i}` },
        origin: 'formation' as const,
        similarity: 0.5
      }))
    );
    expect(texts.filter((t) => t.includes('INSERT INTO recall_cluster_members'))).toHaveLength(1);
  });
});
