/**
 * Non-unique index builds run after the server starts, wired as `runServe`
 * wires them: declared unique indexes are valid before start, the server
 * answers `/health` while a non-unique build is still running, and the
 * storage report (what doctor reads) shows it building, then valid.
 *
 * A build is held open by a second connection's uncommitted write, which
 * CREATE INDEX CONCURRENTLY waits for.
 *
 * Skipped unless POSTGRES_URL is set.
 */

import { randomUUID } from 'node:crypto';
import { compose } from '@mnmal-ai/substrate-compose';
import {
  type DiskGuard,
  PgDataset,
  PgEdgesStore,
  runMigrations
} from '@mnmal-ai/substrate-dataset-pg';
import { defineNamespace } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildDeferredIndexes,
  buildPluginDatasetMap,
  makeFieldDefLookupFactory,
  reconcileDeclaredStorage,
  reconcileRegisteredStorage,
  runDeferredIndexBuilds
} from '../src/serve/wiring.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('deferred index builds at boot (pg)', () => {
  let sql: Sql;
  const ns = `kdeferred_${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql`DELETE FROM rows WHERE namespace = ${ns}`;
    await sql.end();
  });

  async function valid(name: string): Promise<boolean | undefined> {
    const [row] = await sql<Array<{ valid: boolean }>>`
      SELECT indisvalid AND indisready AS valid FROM pg_index
      WHERE indexrelid = to_regclass(${name})`;
    return row?.valid;
  }

  it('starts serving before a non-unique build completes', async () => {
    const unique = `${ns}_kid_uq`;
    const plain = `${ns}_cert_ix`;
    const def = defineNamespace(ns, {
      Member: {
        fields: {
          kid: { kind: 'scalar', type: 'string' },
          cert: { kind: 'scalar', type: 'string' }
        },
        indexes: [
          { fields: ['kid'], unique: true, where: 'live', name: unique },
          { fields: ['cert'], name: plain }
        ]
      }
    });
    const plugin = { name: ns, contractVersion: '*', namespaces: [def] };
    const nsDefs = new Map([[ns, def]]);
    const edges = new PgEdgesStore({ sql });
    const dataset = new PgDataset({ namespace: 'default', sql, edgesStore: edges });
    const datasets = buildPluginDatasetMap(
      [plugin],
      dataset,
      sql,
      edges,
      makeFieldDefLookupFactory(nsDefs)
    );
    const members = datasets[ns] as PgDataset;

    await reconcileDeclaredStorage((n) => datasets[n], nsDefs);
    expect(await valid(unique)).toBe(true);
    expect(await valid(plain)).toBeUndefined();

    const server = new MemorySubstrateServer();
    const composed = await compose({
      server,
      dataset,
      edges,
      datasets,
      coordinators: [plugin],
      systemActor: 'local-dev'
    });
    try {
      await reconcileRegisteredStorage(composed.engine, composed.datasets, nsDefs);
      expect(await valid(unique)).toBe(true);

      const hold = await sql.reserve();
      await hold`BEGIN`;
      await hold`INSERT INTO rows (namespace, type, id, body)
        VALUES (${ns}, 'Member', ${randomUUID()}, ${sql.json({ kid: randomUUID() })})`;
      let settled = false;
      const builds = buildDeferredIndexes(composed.engine, composed.datasets).then(() => {
        settled = true;
      });
      try {
        const report = async () => (await members.storageReport({ partitionBudget: 1e6 })).warnings;
        for (let i = 0; !(await report()).some((w) => w.includes(' is building:')); i++) {
          if (i > 200) throw new Error('no build started');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const res = await server.inject({ method: 'GET', path: '/health' });
        expect(res.status).toBe(200);
        expect(settled).toBe(false);
        const state = (await members.describeStorage('Member')).indexes.find(
          (i) => i.name === plain
        )?.state;
        expect(['pending', 'building']).toContain(state);
      } finally {
        await hold`COMMIT`;
        hold.release();
      }
      await builds;
      expect(await valid(plain)).toBe(true);
      const after = await members.describeStorage('Member');
      expect(after.indexes.find((i) => i.name === plain)?.state).toBe('valid');
      expect(
        (await members.storageReport({ partitionBudget: 1e6 })).warnings.filter((w) =>
          w.includes(ns)
        )
      ).toEqual([]);
    } finally {
      await composed.stop();
    }
  }, 60_000);

  it('retries a build the disk guard refused on a later pass, without a reboot', async () => {
    const rns = `${ns}_r`;
    const plain = `${rns}_cert_ix`;
    const def = defineNamespace(rns, {
      Member: {
        fields: { cert: { kind: 'scalar', type: 'string' } },
        indexes: [{ fields: ['cert'], name: plain }]
      }
    });
    const plugin = { name: rns, contractVersion: '*', namespaces: [def] };
    const nsDefs = new Map([[rns, def]]);
    let allow = false;
    const guard: DiskGuard = {
      path: '/var/lib/postgresql',
      check: async (n) => (allow ? { ok: true } : { ok: false, freeBytes: 0, needBytes: n })
    };
    const edges = new PgEdgesStore({ sql });
    const dataset = new PgDataset({ namespace: 'default', sql, edgesStore: edges });
    const datasets = buildPluginDatasetMap(
      [plugin],
      dataset,
      sql,
      edges,
      makeFieldDefLookupFactory(nsDefs),
      undefined,
      guard
    );
    const members = datasets[rns] as PgDataset;
    const composed = await compose({
      server: new MemorySubstrateServer(),
      dataset,
      edges,
      datasets,
      coordinators: [plugin],
      systemActor: 'local-dev'
    });
    try {
      await reconcileRegisteredStorage(composed.engine, composed.datasets, nsDefs);
      const state = async () =>
        (await members.describeStorage('Member')).indexes.find((i) => i.name === plain);
      // Each pass awaits its builds, so the test drives them directly: no timer, no polling.
      await buildDeferredIndexes(composed.engine, composed.datasets);
      expect(await valid(plain)).toBeUndefined();
      expect(await state()).toMatchObject({ state: 'pending', reason: 'insufficient_disk' });

      allow = true;
      await buildDeferredIndexes(composed.engine, composed.datasets, undefined, {
        onlyUnsettled: true
      });
      expect(await valid(plain)).toBe(true);
      expect((await state())?.state).toBe('valid');
      expect((await state())?.reason).toBeUndefined();

      // A retry pass leaves a settled type alone.
      const ensure = vi.spyOn(PgDataset.prototype, 'ensureTypeStorage');
      try {
        await buildDeferredIndexes(composed.engine, composed.datasets, undefined, {
          onlyUnsettled: true
        });
        expect(ensure.mock.contexts.filter((c) => (c as PgDataset).namespace === rns)).toEqual([]);
      } finally {
        ensure.mockRestore();
      }
    } finally {
      await sql`DELETE FROM rows WHERE namespace = ${rns}`;
      await composed.stop();
    }
  }, 60_000);

  it('the retry loop runs a pass after each interval until aborted', async () => {
    const lns = `${ns}_l`;
    const def = defineNamespace(lns, {
      Member: {
        fields: { cert: { kind: 'scalar', type: 'string' } },
        indexes: [{ fields: ['cert'], name: `${lns}_cert_ix` }]
      }
    });
    const plugin = { name: lns, contractVersion: '*', namespaces: [def] };
    const nsDefs = new Map([[lns, def]]);
    const edges = new PgEdgesStore({ sql });
    const dataset = new PgDataset({ namespace: 'default', sql, edgesStore: edges });
    const datasets = buildPluginDatasetMap(
      [plugin],
      dataset,
      sql,
      edges,
      makeFieldDefLookupFactory(nsDefs)
    );
    const composed = await compose({
      server: new MemorySubstrateServer(),
      dataset,
      edges,
      datasets,
      coordinators: [plugin],
      systemActor: 'local-dev'
    });
    // The type's storage exists and its non-unique index is still to build.
    await reconcileRegisteredStorage(composed.engine, composed.datasets, nsDefs);
    const stop = new AbortController();
    // Builds nothing, so the index stays unsettled and every retry pass reaches it;
    // the second call (the first retry) ends the loop.
    let calls = 0;
    const ensure = vi
      .spyOn(PgDataset.prototype, 'ensureTypeStorage')
      .mockImplementation(async function (this: PgDataset) {
        if (this.namespace === lns && ++calls === 2) stop.abort();
      });
    try {
      await runDeferredIndexBuilds(composed.engine, composed.datasets, 1, stop.signal);
      expect(calls).toBe(2);
    } finally {
      ensure.mockRestore();
      stop.abort();
      await composed.stop();
    }
  }, 60_000);
});
