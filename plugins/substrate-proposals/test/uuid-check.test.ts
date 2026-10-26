/**
 * Every row id the engine mints passes migration 0002's `rows_id_uuid_format`
 * CHECK (`SUBSTRATE_ENFORCE_UUID_CHECK=true`): the `_system` install's
 * StoreProfile seed, an advisor pass's IndexRecommendation and AdvisorState,
 * and the AuditEvent of a recommendation-based `propose_index` add and remove.
 *
 * Runs in a schema of its own, migrated with the CHECK on, so no other suite
 * inherits the constraint. Skipped unless POSTGRES_URL is set.
 */

import { randomUUID } from 'node:crypto';
import { installSystemNamespace, runAdvisorPass, uuidFromName } from '@mnmal-ai/substrate-compose';
import {
  Registry as CoreRegistry,
  Engine,
  loadPlugins,
  ShapeRecorder
} from '@mnmal-ai/substrate-core';
import { MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import {
  desiredIndexKeys,
  PgDataset,
  PgEdgesStore,
  runMigrations,
  type StorageLayout,
  typeIndexesOf
} from '@mnmal-ai/substrate-dataset-pg';
import {
  pgTestSchemaName,
  pgTestSchemaUrl,
  recreatePgTestSchema
} from '@mnmal-ai/substrate-dataset-pg/testing';
import { isReservedAutoCrudField } from '@mnmal-ai/substrate-sdk';
import type {
  Dataset,
  FieldDef,
  NamespaceTypeDef,
  RequestContext
} from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNoopPubSub, createProposalsPlugin, storageSettled } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ctx = (capabilities: string[]): Partial<RequestContext> => ({
  identity: { id: 'reviewer', tokenId: 'reviewer', grants: { '*': capabilities } },
  headers: {},
  meta: {}
});
const PROPOSER = ctx(['read', 'mutate', 'substrate.propose']);
const REVIEWER = ctx(['read', 'mutate', 'substrate.index']);

describe.skipIf(!POSTGRES_URL)('engine row ids under the UUID-format CHECK (pg)', () => {
  const APP = 'kuuidapp';
  const CODE = 'kuuidcode';
  let sql: Sql;
  let schema: string;
  let layout: StorageLayout;
  let engine: Engine;
  let system: PgDataset;
  let app: PgDataset;
  let code: PgDataset;
  const codeTypes = new Map<string, NamespaceTypeDef>();

  beforeAll(async () => {
    layout = process.env.SUBSTRATE_TEST_LAYOUT === 'partitioned' ? 'partitioned' : 'legacy';
    const pkg = `substrate-proposals-uuidcheck-${layout}`;
    schema = pgTestSchemaName(pkg);
    const url = pgTestSchemaUrl(POSTGRES_URL as string, pkg);
    await recreatePgTestSchema(url, schema);
    sql = postgres(url, { onnotice: () => {} });
    await runMigrations(sql, { layout, enforceUuidCheck: true });
    const [check] = await sql`
      SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.conname = 'rows_id_uuid_format' AND n.nspname = ${schema}`;
    expect(check).toBeDefined();

    const edges = new PgEdgesStore({ sql });
    let live: Engine | undefined;
    const fromRegistry = (type: string): NamespaceTypeDef | undefined => {
      const e = live?.registryFor(APP)?.get(type);
      if (e?.kind !== 'type') return undefined;
      return {
        fields: Object.fromEntries(
          Object.entries(e.fields).filter(([, d]) => !isReservedAutoCrudField(d))
        ),
        ...(e.orderedBy !== undefined ? { orderedBy: e.orderedBy } : {}),
        ...(e.indexes !== undefined ? { indexes: e.indexes } : {})
      };
    };
    system = new PgDataset({ namespace: '_system', sql, edgesStore: edges });
    app = new PgDataset({ namespace: APP, sql, edgesStore: edges, typeDefLookup: fromRegistry });
    code = new PgDataset({
      namespace: CODE,
      sql,
      edgesStore: edges,
      typeDefLookup: (type) => codeTypes.get(type)
    });
    const datasets = new MemoryDatasetRegistry();
    datasets.set('_system', system);
    datasets.set(
      '_system_proposals',
      new PgDataset({ namespace: '_system_proposals', sql, edgesStore: edges })
    );
    datasets.set(APP, app);
    datasets.set(CODE, code);

    // The StoreProfile seed is the install's first engine-minted id.
    await installSystemNamespace({
      registry: new CoreRegistry(),
      dataset: system,
      edges,
      storeProfile: 'scale'
    });

    const datasetFor = (ns: string): Dataset | undefined => datasets.get(ns);
    const plugin = createProposalsPlugin({
      ownedNamespaces: [APP],
      pubsub: createNoopPubSub(),
      datasetFor
    });
    const loaded = await loadPlugins({ plugins: [plugin], datasetFor, edges });
    engine = new Engine({ namespaces: loaded.namespaces, datasets, edges });
    await loaded.runOnStart(engine);
    live = engine;
  });

  afterAll(async () => {
    await storageSettled();
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await sql.end();
  });

  const proposeIndex = (params: Record<string, unknown>) =>
    engine.mutate({
      frame: {
        '_system_proposals/propose_index': {
          params: { reason: 'test', ...params },
          fields: { id: true }
        }
      },
      ctx: REVIEWER
    });
  const auditOf = async (recId: string) =>
    (await system.read('AuditEvent', { id: uuidFromName(`index_proposed:${recId}`) })).rows[0];

  it('seeds, advises, and approves an add and a remove', async () => {
    const [profile] = (await system.read('StoreProfile', {})).rows;
    expect(profile).toMatchObject({ profile: 'scale' });
    expect(String(profile?.id)).toMatch(UUID);

    const type = `Sneaker${randomUUID().slice(0, 8)}`;
    const proposed = await engine.mutate({
      frame: {
        [`${APP}/propose_type`]: {
          params: {
            typeName: type,
            fields: { brand: { kind: 'scalar', type: 'string' } },
            proposedReason: 'r'
          },
          fields: { id: true }
        }
      },
      ctx: PROPOSER
    });
    expect(proposed.errors ?? []).toEqual([]);
    await storageSettled();
    // Above the scale profile's 20,000-row minimum.
    await sql`INSERT INTO rows (namespace, type, id, body)
      SELECT ${APP}, ${type}, gen_random_uuid()::text, jsonb_build_object('brand', 'b')
      FROM generate_series(1, 25000)`;
    await sql`ANALYZE rows`;

    // Twenty slow reads of `brand eq`, the scale profile's minReads.
    const recorder = new ShapeRecorder();
    for (let i = 0; i < 20; i++) {
      recorder.observe(
        {
          namespace: APP,
          type,
          filters: [{ field: 'brand', op: 'eq' }],
          orderBy: [['createdAt', 'desc']]
        },
        80
      );
    }
    const pass = await runAdvisorPass({
      dataset: app,
      system,
      recorder,
      registry: (ns) => engine.registryFor(ns),
      now: Date.now
    });
    expect(pass.upserted).toBeGreaterThanOrEqual(1);
    const [add] = (
      await system.read('IndexRecommendation', {
        where: { type: { eq: type }, action: { eq: 'add' } }
      })
    ).rows;
    expect(String(add?.id)).toMatch(UUID);
    expect(String((await system.read('AdvisorState', {})).rows[0]?.id)).toMatch(UUID);

    const added = await proposeIndex({
      namespace: APP,
      type,
      action: 'add',
      recommendationId: add?.id
    });
    expect(added.errors ?? []).toEqual([]);
    expect(await auditOf(String(add?.id))).toBeDefined();

    // A code-defined type's retracted index, recommended for removal as the advisor keys it.
    const fields: Record<string, FieldDef> = { brand: { kind: 'scalar', type: 'string' } };
    const gadget = `Gadget${randomUUID().slice(0, 8)}`;
    codeTypes.set(gadget, { fields, indexes: [{ fields: ['brand'] }] });
    await code.ensureTypeStorage(gadget);
    codeTypes.set(gadget, { fields });
    const desired = desiredIndexKeys({
      namespace: CODE,
      type: gadget,
      layout,
      fields,
      indexes: [],
      orderedBy: { createdAt: 'desc' }
    }).map((d) => d.name);
    const leftover = (await typeIndexesOf(sql, CODE, gadget, layout)).find(
      (i) => i.engineOwned && !desired.includes(i.name)
    )?.name as string;
    expect(leftover).toBeDefined();
    const removeId = uuidFromName(`remove${leftover}`);
    await system.write('IndexRecommendation', [
      {
        id: removeId,
        recKey: 'test',
        namespace: CODE,
        type: gadget,
        action: 'remove',
        shape: '',
        indexName: leftover,
        declarationJson: JSON.stringify({ drop: leftover }),
        evidenceJson: '{}',
        estimatedWriteCost: 'low',
        state: 'open'
      }
    ]);
    const removed = await proposeIndex({
      namespace: CODE,
      type: gadget,
      action: 'remove',
      recommendationId: removeId
    });
    expect(removed.errors ?? []).toEqual([]);
    expect((await typeIndexesOf(sql, CODE, gadget, layout)).map((i) => i.name)).not.toContain(
      leftover
    );
    expect(await auditOf(removeId)).toBeDefined();
  }, 60_000);
});
