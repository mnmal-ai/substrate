/**
 * A date filter operand in the ISO shape that names a day that does not exist
 * (Feb 30, month 13) is refused by the engine's filter validation, naming the
 * field, on both datasets: memory would otherwise roll it over to March, and
 * pg's cast would raise.
 *
 * The pg half is skipped unless POSTGRES_URL is set.
 */

import { randomUUID } from 'node:crypto';
import { compose } from '@mnmal-ai/substrate-compose';
import { MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { PgDataset, PgEdgesStore, runMigrations } from '@mnmal-ai/substrate-dataset-pg';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type {
  CoordinatorPlugin,
  Dataset,
  EdgesStore,
  RequestContext
} from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

const POSTGRES_URL = process.env.POSTGRES_URL;
const ns = `dor_${randomUUID().slice(0, 8)}`;
const plugin: CoordinatorPlugin = {
  name: ns,
  contractVersion: '*',
  namespaces: [defineNamespace(ns, { Ev: { fields: { at: field.date() } } })]
};
const ctx: Partial<RequestContext> = {
  identity: { kind: 'system', id: 'test', grants: { '*': ['read', 'mutate'] } }
};

let sql: Sql | undefined;
afterAll(async () => {
  if (sql === undefined) return;
  await sql`DELETE FROM rows WHERE namespace = ${ns}`;
  await sql.end({ timeout: 5 });
});

async function store(kind: 'memory' | 'pg'): Promise<{ dataset: Dataset; edges: EdgesStore }> {
  if (kind === 'memory') {
    return {
      dataset: new MemoryDataset({ namespace: 'default' }),
      edges: new MemoryEdgesStore({ now: () => new Date() })
    };
  }
  sql ??= postgres(POSTGRES_URL as string, { onnotice: () => {} });
  await runMigrations(sql);
  const edges = new PgEdgesStore({ sql });
  return { dataset: new PgDataset({ namespace: 'default', sql, edgesStore: edges }), edges };
}

for (const kind of ['memory', 'pg'] as const) {
  describe.skipIf(kind === 'pg' && !POSTGRES_URL)(`date operand refusal (${kind})`, () => {
    it('refuses an impossible day by name, and still reads a real one', async () => {
      const composed = await compose({
        server: new MemorySubstrateServer(),
        ...(await store(kind)),
        coordinators: [plugin],
        systemActor: 'test'
      });
      try {
        const created = await composed.engine.mutate({
          frame: {
            [`${ns}/createEv`]: { params: { at: '2026-03-02T00:00:00Z' }, fields: { id: true } }
          },
          ctx
        });
        expect(created.errors).toBeUndefined();
        const read = (gt: string) =>
          composed.engine.query({
            frame: { [`${ns}/Ev`]: { params: { where: { at: { gt } } }, fields: { id: true } } },
            ctx
          });
        for (const gt of ['2026-02-30', '2026-13-01T00:00:00Z']) {
          const env = await read(gt);
          expect(env.data[`${ns}/Ev`], gt).toBeUndefined();
          expect(env.errors?.[0], gt).toMatchObject({ code: 'type_mismatch' });
          expect(env.errors?.[0]?.message, gt).toMatch(/on 'at': .* is not a real date/);
        }
        const ok = await read('2026-03-01');
        expect(ok.errors).toBeUndefined();
        expect(ok.data[`${ns}/Ev`]).toHaveLength(1);
      } finally {
        await composed.stop();
      }
    });
  });
}
