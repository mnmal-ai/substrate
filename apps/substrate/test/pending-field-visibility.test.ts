/**
 * A field added at runtime is visible while it waits for its column, and the
 * promotion sweep is reachable from every way in:
 *
 * - propose_field on a live type records the field `pending` (`tables` only):
 *   the scoped schema marks it `storage: 'pending'`, `/health` warns, and a
 *   `field_pending` `_system/AuditEvent` reaches a subscriber. On the old
 *   layouts nothing is pending and no event is sent (F12).
 * - `POST /substrate/v1/_system/promote-fields` and `substrate-admin
 *   promote-fields` run the sweep: `field_promoted`, the mark and the warning gone.
 * - At boot a field declared in code gets its column (`promoting`), or waits
 *   `pending` while its table is locked; a kind change refuses the boot.
 * - Shutdown during a sweep finishes, and the pool then ends.
 *
 * Skipped unless POSTGRES_URL is set.
 */

import { randomBytes } from 'node:crypto';
import {
  type ComposeResult,
  compose,
  SYSTEM_NAMESPACE,
  signHs256
} from '@mnmal-ai/substrate-compose';
import type { Engine } from '@mnmal-ai/substrate-core';
import {
  FieldKindChangedError,
  PgDataset,
  PgEdgesStore,
  runMigrations
} from '@mnmal-ai/substrate-dataset-pg';
import { pgTestSchemaName, pgTestSchemaUrl } from '@mnmal-ai/substrate-dataset-pg/testing';
import {
  createNoopPubSub,
  createProposalsPlugin,
  storageSettled
} from '@mnmal-ai/substrate-proposals';
import { field } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { FieldDef, NamespaceDefinition, SubstrateResponse } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  formatPromoteFieldsOutput,
  promoteFieldsCommand
} from '../src/admin/commands/promote-fields.js';
import { bootStore } from '../src/serve/boot-store.js';
import { parseEnv } from '../src/serve/config.js';
import { makeTypeDefLookupFactory, reconcileDeclaredStorage } from '../src/serve/wiring.js';
import { deleteNamespaces, relationOf, TABLES } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const SECRET = 'pending-field-secret';
const CONTROL = '_system_proposals';
const hex = () => randomBytes(4).toString('hex');
/** A namespace definition declaring `Item` with `fields`, all the boot reconcile reads. */
const itemDef = (fields: Record<string, FieldDef>) =>
  ({ types: { Item: { fields } } }) as unknown as NamespaceDefinition;
const json = (res: SubstrateResponse) => JSON.parse(String(res.body)) as Record<string, unknown>;
const until = async (check: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
};

describe.skipIf(!POSTGRES_URL)('pending runtime fields, seen and promoted', () => {
  let sql: Sql;
  const namespaces: string[] = [];
  const stops: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await runMigrations(sql);
  });

  afterEach(async () => {
    while (stops.length > 0) await stops.pop()?.();
    await storageSettled();
  });

  afterAll(async () => {
    await deleteNamespaces(sql, ...namespaces, CONTROL);
    await sql.end({ timeout: 5 });
  });

  /** A server owning a fresh namespace through the proposals plugin, on pg, as the binary wires it. */
  async function boot() {
    const ns = `kpend_${hex()}`;
    namespaces.push(ns);
    let engine: Engine | undefined;
    const typeDefLookup = makeTypeDefLookupFactory(new Map(), (n) => engine?.registryFor(n))(ns);
    const edges = new PgEdgesStore({ sql });
    const pg = (namespace: string) =>
      new PgDataset({ namespace, sql, edgesStore: edges, typeDefLookup });
    const server = new MemorySubstrateServer();
    const composed: ComposeResult = await compose({
      server,
      dataset: pg('default'),
      edges,
      datasets: { [SYSTEM_NAMESPACE]: pg(SYSTEM_NAMESPACE), [ns]: pg(ns), [CONTROL]: pg(CONTROL) },
      coordinators: [createProposalsPlugin({ ownedNamespaces: [ns], pubsub: createNoopPubSub() })],
      auth: { keys: [{ kid: 'file', alg: 'HS256', publicKey: SECRET }], adminCapability: 'admin' },
      streamTicketSecret: 'pending-field-ticket'
    });
    engine = composed.engine;
    stops.push(() => composed.stop());
    const token = signHs256(
      {
        sub: 'op',
        exp: Math.floor(Date.now() / 1000) + 300,
        capabilities: ['admin', 'read', 'mutate', 'substrate.propose'],
        ns: ['*']
      },
      SECRET,
      { kid: 'file' }
    );
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const post = (path: string, body: unknown) =>
      server.inject({ method: 'POST', path, headers, body: Buffer.from(JSON.stringify(body)) });
    const get = (path: string) => server.inject({ method: 'GET', path, headers });
    const mutate = async (frame: Record<string, unknown>) => {
      const body = json(await post('/substrate/v1/mutate', frame));
      expect(body.errors ?? [], JSON.stringify(body)).toEqual([]);
      return body.data as Record<string, Record<string, unknown>>;
    };
    /** Every field event pushed to an `_system/AuditEvent` subscriber about this namespace. */
    const audit: Array<{ kind: string; details: Record<string, unknown> }> = [];
    await composed.engine.subscribe({
      id: `audit-${ns}`,
      frame: {
        '_system/AuditEvent': { params: {}, fields: { id: true, kind: true, details: true } }
      },
      ctx: { identity: { id: 'op', tokenId: 'op', grants: { '*': ['admin', 'read'] } } } as never,
      onFrame: (f: { kind: string; data?: unknown }) => {
        if (f.kind !== 'add') return;
        const row = (f.data as Record<string, { kind: string; details: Record<string, unknown> }>)[
          '_system/AuditEvent'
        ];
        if (row?.details?.namespace === ns) audit.push({ kind: row.kind, details: row.details });
      }
    });
    /** A live `Note` with one row, then `rank` proposed on it. */
    const proposeRankOnLiveNote = async () => {
      await mutate({
        [`${ns}/propose_type`]: {
          params: {
            typeName: 'Note',
            fields: { title: { kind: 'scalar', type: 'string' } },
            proposedReason: 'test'
          },
          fields: { id: true }
        }
      });
      await storageSettled();
      await mutate({ [`${ns}/createNote`]: { params: { title: 'a' }, fields: { id: true } } });
      await mutate({
        [`${ns}/propose_field`]: {
          params: {
            targetType: 'Note',
            fieldName: 'rank',
            fieldSpec: { kind: 'scalar', type: 'number' },
            proposedReason: 'test'
          },
          fields: { id: true }
        }
      });
      await storageSettled();
      await mutate({
        [`${ns}/createNote`]: { params: { title: 'b', rank: 3 }, fields: { id: true } }
      });
    };
    const rankDef = async () =>
      (json(await get(`/substrate/v1/schema/${ns}/Note`)).fields as Record<string, object>).rank;
    /** `/health`, asked as an anonymous caller would ask it. */
    const health = async () =>
      json(await server.inject({ method: 'GET', path: '/health' })) as {
        status: string;
        warnings: string[];
      };
    /** The admin-gated storage report's lines naming this namespace's fields. */
    const reportLines = async () => {
      const r = await pg('default').storageReport({ partitionBudget: 1_000_000 });
      return [...r.warnings, ...(r.info ?? [])].filter((w) => w.startsWith(`${ns}/`));
    };
    return {
      ns,
      composed,
      post,
      get,
      mutate,
      audit,
      proposeRankOnLiveNote,
      rankDef,
      health,
      reportLines
    };
  }

  it.skipIf(!TABLES)(
    "propose_field on a live type → schema storage:'pending', a /health warning, a field_pending event; the sweep promotes it",
    async () => {
      const { ns, post, get, audit, proposeRankOnLiveNote, rankDef, health, reportLines } =
        await boot();
      await proposeRankOnLiveNote();
      expect(await rankDef()).toMatchObject({ storage: 'pending' });
      // Unauthenticated: a count, store-wide, naming no namespace, type or field.
      const pendingHealth = await health();
      expect(pendingHealth.status).toBe('ok');
      expect(pendingHealth.warnings).toContainEqual(
        expect.stringMatching(/^\d+ fields? pending promotion(; .*)? — see the storage report$/)
      );
      expect(JSON.stringify(pendingHealth)).not.toContain(ns);
      expect(JSON.stringify(pendingHealth)).not.toContain('rank');
      // The names are on the admin-gated storage report.
      expect(await reportLines()).toEqual([
        `${ns}/Note.rank is pending: held in jsonb until promoted (attempt 0)`
      ]);
      await until(() => audit.length >= 1);
      expect(audit).toEqual([
        {
          kind: 'field_pending',
          details: { namespace: ns, type: 'Note', field: 'rank', attempts: 0 }
        }
      ]);
      const filtered = json(
        await post('/substrate/v1/query', {
          [`${ns}/Note`]: { params: { where: { rank: { eq: 3 } } }, fields: { title: true } }
        })
      ).data as Record<string, Array<Record<string, unknown>>>;
      expect(filtered[`${ns}/Note`]?.map((r) => r.title)).toEqual(['b']);

      const swept = json(await post('/substrate/v1/_system/promote-fields', {}));
      expect(swept.events).toContainEqual({
        kind: 'promoted',
        namespace: ns,
        type: 'Note',
        field: 'rank',
        attempts: 1
      });
      await until(() => audit.length >= 2);
      expect(audit[1]).toEqual({
        kind: 'field_promoted',
        details: { namespace: ns, type: 'Note', field: 'rank', attempts: 1 }
      });
      expect(await rankDef()).not.toHaveProperty('storage');
      expect(await reportLines()).toEqual([]);
      expect(JSON.stringify(await health())).not.toContain(ns);
      const after = json(
        await post('/substrate/v1/query', {
          [`${ns}/Note`]: { params: { where: { rank: { eq: 3 } } }, fields: { title: true } }
        })
      ).data as Record<string, Array<Record<string, unknown>>>;
      expect(after[`${ns}/Note`]?.map((r) => r.title)).toEqual(['b']);
      expect((await get('/health')).status).toBe(200);
    }
  );

  it.skipIf(TABLES)('propose_field on an old layout emits no field_pending event', async () => {
    const { audit, proposeRankOnLiveNote, rankDef, health } = await boot();
    await proposeRankOnLiveNote();
    // Give a stray event the time a real one takes to arrive.
    await new Promise((r) => setTimeout(r, 300));
    expect(audit).toEqual([]);
    expect(await rankDef()).not.toHaveProperty('storage');
    expect((await health()).warnings.filter((w) => w.includes('pending promotion'))).toEqual([]);
  });

  it('substrate-admin promote-fields reaches the route', async () => {
    const { composed: _c, post } = await boot();
    const seen: string[] = [];
    // The CLI's fetch, served by this process's server.
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      seen.push(`${init.method} ${path}`);
      const res = await post(path, {});
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        json: async () => json(res)
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const token = signHs256(
      { sub: 'op', exp: Math.floor(Date.now() / 1000) + 120, capabilities: ['admin'], ns: ['*'] },
      SECRET,
      { kid: 'file' }
    );
    const result = await promoteFieldsCommand(
      ['--url', 'http://127.0.0.1:3100'],
      { SUBSTRATE_ADMIN_TOKEN: token },
      fetchImpl
    );
    expect(seen).toEqual(['POST /substrate/v1/_system/promote-fields']);
    expect(Array.isArray(result.events)).toBe(true);
    expect(formatPromoteFieldsOutput(result)).toMatch(
      /^promote-fields: targeting http:\/\/127\.0\.0\.1:3100/
    );
  });

  describe.skipIf(!TABLES)('at boot', () => {
    /** Declares `Item` in code with `fields`, as the binary's boot reconcile sees it. */
    async function bootWith(ns: string, fields: Record<string, FieldDef>) {
      const nsDefs = new Map<string, NamespaceDefinition>([[ns, itemDef(fields)]]);
      const typeDefLookup = makeTypeDefLookupFactory(nsDefs)(ns);
      const ds = new PgDataset({ namespace: ns, sql, typeDefLookup });
      await reconcileDeclaredStorage(() => ds, nsDefs);
      return ds;
    }
    const stateOf = async (ns: string, f: string) =>
      (
        await sql<Array<{ state: string }>>`
          SELECT state FROM substrate_type_fields
          WHERE namespace = ${ns} AND type = 'Item' AND field = ${f}`
      )[0]?.state;

    it('a field added in code is promoting at boot, then column after the sweep; with the lock held, pending', async () => {
      const ns = `kpendboot_${hex()}`;
      namespaces.push(ns);
      const first = await bootWith(ns, { title: field.string() });
      await first.write('Item', [{ title: 'a', size: 2 }]);
      const ds = await bootWith(ns, { title: field.string(), size: field.number() });
      expect(await stateOf(ns, 'size')).toBe('promoting');
      expect(
        (await ds.promotePendingFields({ lockTimeoutMs: 2000, batchRows: 100, namespace: ns })).map(
          (e) => e.kind
        )
      ).toEqual(['promoted']);
      expect(await stateOf(ns, 'size')).toBe('column');

      const reader = await sql.reserve();
      try {
        await reader`BEGIN`;
        await reader.unsafe(`SELECT count(*) FROM ${await relationOf(sql, ns, 'Item')}`);
        await bootWith(ns, { title: field.string(), size: field.number(), weight: field.number() });
      } finally {
        await reader`ROLLBACK`;
        reader.release();
      }
      expect(await stateOf(ns, 'weight')).toBe('pending');
    });

    it('a field added in code reaches column at boot, without waiting for an interval', async () => {
      const name = `apps/substrate-boot-sweep-${hex()}`;
      const url = pgTestSchemaUrl(POSTGRES_URL as string, name);
      const own = postgres(url, { max: 2, onnotice: () => {} });
      await own.unsafe(`CREATE SCHEMA ${pgTestSchemaName(name)}`);
      const config = parseEnv({
        SUBSTRATE_DATABASE_URL: url,
        SUBSTRATE_SYSTEM_ACTOR: 'boot-sweep'
      });
      try {
        // Migrate the fresh schema, starting nothing in the background.
        await (
          await bootStore({ config, pluginDir: null, layout: 'tables', background: false })
        ).close();
        const ns = 'kbootsweep';
        const nsDefs = new Map<string, NamespaceDefinition>([
          [ns, itemDef({ title: field.string() })]
        ]);
        const ds = new PgDataset({
          namespace: ns,
          sql: own,
          typeDefLookup: makeTypeDefLookupFactory(nsDefs)(ns)
        });
        await ds.write('Item', [{ title: 'a', size: 2 }]);
        nsDefs.set(ns, itemDef({ title: field.string(), size: field.number() }));
        await ds.ensureTypeStorage('Item');
        const state = async () =>
          (
            await own<Array<{ state: string }>>`
              SELECT state FROM substrate_type_fields
              WHERE namespace = ${ns} AND type = 'Item' AND field = 'size'`
          )[0]?.state;
        expect(await state()).toBe('promoting');
        // SUBSTRATE_PROMOTE_INTERVAL_MS is its 6 h default: only the boot sweep can do this.
        const booted = await bootStore({ config, pluginDir: null, layout: 'tables' });
        try {
          const deadline = Date.now() + 10_000;
          while ((await state()) !== 'column' && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
          }
          expect(await state()).toBe('column');
        } finally {
          await booted.close();
        }
      } finally {
        await own.unsafe(`DROP SCHEMA IF EXISTS ${pgTestSchemaName(name)} CASCADE`);
        await own.end({ timeout: 5 });
      }
    });

    it('a kind change in code refuses the boot, naming FieldKindChangedError', async () => {
      const ns = `kpendkind_${hex()}`;
      namespaces.push(ns);
      await bootWith(ns, { title: field.string(), size: field.number() });
      await expect(bootWith(ns, { title: field.string(), size: field.string() })).rejects.toThrow(
        FieldKindChangedError
      );
      await expect(
        bootWith(ns, { title: field.string(), size: field.string() })
      ).rejects.toMatchObject({ name: 'FieldKindChangedError' });
    });

    it('shutdown during a sweep finishes it, then the pool ends', async () => {
      const ns = `kpendstop_${hex()}`;
      namespaces.push(ns);
      const own = postgres(POSTGRES_URL as string, { onnotice: () => {} });
      const nsDefs = new Map<string, NamespaceDefinition>([
        [ns, itemDef({ title: field.string() })]
      ]);
      const ds = new PgDataset({
        namespace: ns,
        sql: own,
        typeDefLookup: makeTypeDefLookupFactory(nsDefs)(ns)
      });
      await reconcileDeclaredStorage(() => ds, nsDefs);
      await ds.write('Item', [{ title: 'a', size: 1 }]);
      nsDefs.set(ns, itemDef({ title: field.string(), size: field.number() }));
      await ds.ensureTypeStorage('Item', { newFields: 'pending' });
      const server = new MemorySubstrateServer();
      const composed = await compose({
        systemActor: 'test',
        server,
        dataset: ds,
        datasets: { [ns]: ds }
      });
      // A reader holds the table, so the sweep's ADD COLUMN waits on its lock.
      const reader = await sql.reserve();
      await reader`BEGIN`;
      await reader.unsafe(`SELECT count(*) FROM ${await relationOf(sql, ns, 'Item')}`);
      const started = Date.now();
      try {
        const sweep = composed.runPromoteFieldsNow();
        await new Promise((r) => setTimeout(r, 200));
        await composed.stop();
        await sweep;
        await own.end({ timeout: 5 });
      } finally {
        await reader`ROLLBACK`;
        reader.release();
      }
      expect(Date.now() - started).toBeLessThan(5000);
    });
  });
});
