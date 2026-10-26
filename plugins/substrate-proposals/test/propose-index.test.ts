/**
 * `propose_index`: the signed approval of an index recommendation, or a direct
 * index change, under `substrate.index`. `add` and `orderedBy` change a
 * proposed type's stored declaration, which boot replays; `remove` drops only
 * an engine-owned, non-unique index the engine no longer wants; recommendation
 * rows are re-checked, never trusted.
 */

import { randomUUID } from 'node:crypto';
import { Engine, loadPlugins, MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import {
  desiredIndexKeys,
  detectLayout,
  PgDataset,
  PgEdgesStore,
  partitionName,
  type StorageLayout,
  typeIndexesOf
} from '@mnmal-ai/substrate-dataset-pg';
import { isReservedAutoCrudField } from '@mnmal-ai/substrate-sdk';
import type {
  Dataset,
  FieldDef,
  IndexDecl,
  NamespaceTypeDef,
  PackEnvelope,
  RequestContext,
  Row
} from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createNoopPubSub,
  createProposalsPlugin,
  type PubSub,
  storageSettled
} from '../src/index.js';

const T0 = new Date('2026-10-25T00:00:00Z');

function ctx(capabilities: string[]): Partial<RequestContext> {
  return {
    identity: { id: 'reviewer', tokenId: 'reviewer', grants: { '*': capabilities } },
    now: T0,
    headers: {},
    meta: {}
  };
}
const PROPOSER = ctx(['read', 'mutate', 'substrate.propose']);
const REVIEWER = ctx(['read', 'mutate', 'substrate.index']);

/** A booted engine over `datasets`, with the proposals plugin owning `owned`. */
async function boot(datasets: MemoryDatasetRegistry, owned: string, pubsub = createNoopPubSub()) {
  const datasetFor = (ns: string): Dataset | undefined => datasets.get(ns);
  const plugin = createProposalsPlugin({
    ownedNamespaces: [owned],
    pubsub,
    datasetFor
  });
  const edges = new MemoryEdgesStore({ now: () => T0 });
  const loaded = await loadPlugins({ plugins: [plugin], datasetFor, edges });
  const engine = new Engine({ namespaces: loaded.namespaces, datasets, edges });
  await loaded.runOnStart(engine);
  return engine;
}

function proposeIndex(engine: Engine, params: Record<string, unknown>, as = REVIEWER) {
  return engine.mutate({
    frame: {
      '_system_proposals/propose_index': {
        params: { reason: 'test', ...params },
        fields: { id: true, action: true, indexName: true }
      }
    },
    ctx: as
  });
}

const code = (env: PackEnvelope): string | undefined => env.errors?.[0]?.code;

function recommendation(over: Record<string, unknown>): Row {
  const id = randomUUID();
  return {
    id,
    recKey: id,
    action: 'add',
    shape: '',
    declarationJson: '{}',
    evidenceJson: '{}',
    estimatedWriteCost: 'low',
    state: 'open',
    indexName: null,
    ...over
  };
}

async function recState(system: Dataset, id: unknown): Promise<unknown> {
  return (await system.read('IndexRecommendation', { id: id as string })).rows[0]?.state;
}

describe('propose_index (memory)', () => {
  const NS = 'shop';

  async function setup() {
    const datasets = new MemoryDatasetRegistry();
    for (const ns of [NS, '_system_proposals', '_system']) {
      datasets.set(ns, new MemoryDataset({ namespace: ns }));
    }
    const engine = await boot(datasets, NS);
    const env = await engine.mutate({
      frame: {
        [`${NS}/propose_type`]: {
          params: {
            typeName: 'Sneaker',
            fields: {
              brand: { kind: 'scalar', type: 'string' },
              size: { kind: 'scalar', type: 'number' }
            },
            proposedReason: 'collection'
          },
          fields: { id: true }
        }
      },
      ctx: PROPOSER
    });
    expect(env.errors ?? []).toEqual([]);
    const system = datasets.get('_system') as Dataset;
    return { datasets, engine, system };
  }

  const sneaker = (engine: Engine) => engine.registryFor(NS)?.get('Sneaker');

  it('adds a declared index to a proposed type and replays it on boot', async () => {
    const { datasets, engine } = await setup();
    // A field proposed later, and a metadata column: both may be keys.
    const field = await engine.mutate({
      frame: {
        [`${NS}/propose_field`]: {
          params: {
            targetType: 'Sneaker',
            fieldName: 'colour',
            fieldSpec: { kind: 'scalar', type: 'string' },
            proposedReason: 'r'
          },
          fields: { id: true }
        }
      },
      ctx: PROPOSER
    });
    expect(field.errors ?? []).toEqual([]);
    const decl: IndexDecl = { fields: ['colour', { field: 'createdAt', dir: 'desc' }] };
    const added = await proposeIndex(engine, {
      namespace: NS,
      type: 'Sneaker',
      action: 'add',
      declaration: decl
    });
    expect(added.errors ?? []).toEqual([]);
    const ordered = await proposeIndex(engine, {
      namespace: NS,
      type: 'Sneaker',
      action: 'orderedBy',
      orderedBy: { size: 'desc' }
    });
    expect(ordered.errors ?? []).toEqual([]);
    expect(sneaker(engine)?.indexes).toEqual([decl]);
    expect(sneaker(engine)?.orderedBy).toEqual({ size: 'desc' });
    // The field proposal's reinstall keeps them.
    expect(sneaker(engine)?.fields.colour).toBeDefined();

    // A fresh engine over the same rows replays the type, its field, then its indexes.
    const again = await boot(datasets, NS);
    expect(sneaker(again)?.indexes).toEqual([decl]);
    expect(sneaker(again)?.orderedBy).toEqual({ size: 'desc' });
    expect(again.schemaFor(NS).types.Sneaker?.orderedBy).toEqual({ size: 'desc' });
    await storageSettled();
  });

  it("applies a peer's index change when notified", async () => {
    const handlers = new Map<string, Array<(p: string) => void | Promise<void>>>();
    const loopback: PubSub = {
      listen: async (channel, handler) => {
        handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
      },
      notify: async (channel, payload) => {
        for (const h of handlers.get(channel) ?? []) await h(payload);
      }
    };
    const { datasets, engine } = await setup();
    const peer = await boot(datasets, NS, loopback);
    const env = await proposeIndex(engine, {
      namespace: NS,
      type: 'Sneaker',
      action: 'add',
      declaration: { fields: ['brand'] }
    });
    expect(env.errors ?? []).toEqual([]);
    // `engine` was booted with a no-op transport; tell the peer as pg NOTIFY would.
    const [row] = (await (datasets.get(NS) as Dataset).read('TypeProposal', {})).rows;
    await loopback.notify(`_substrate_proposals_${NS}`, String(row?.id));
    expect(sneaker(peer)?.indexes).toEqual([{ fields: ['brand'] }]);
    await storageSettled();
  });

  it('refuses add on a code-defined type', async () => {
    const { engine } = await setup();
    for (const [ns, type] of [
      ['_system', 'AuditEvent'],
      [NS, 'TypeProposal']
    ] as const) {
      const env = await proposeIndex(engine, {
        namespace: ns,
        type,
        action: 'add',
        declaration: { fields: ['kind'] }
      });
      expect(code(env)).toBe('index_on_code_defined_type');
      expect(env.errors?.[0]?.message).toContain(`'${ns}'`);
    }
    const order = await proposeIndex(engine, {
      namespace: '_system',
      type: 'AuditEvent',
      action: 'orderedBy',
      orderedBy: { createdAt: 'desc' }
    });
    expect(code(order)).toBe('index_on_code_defined_type');
  });

  it('refuses a unique or named declaration, and an invalid one', async () => {
    const { engine } = await setup();
    for (const declaration of [
      { fields: ['brand'], unique: true },
      { fields: ['brand'], name: 'adopt_me' },
      { fields: ['nope'] }
    ]) {
      const env = await proposeIndex(engine, {
        namespace: NS,
        type: 'Sneaker',
        action: 'add',
        declaration
      });
      expect(code(env)).toBe('invalid_params');
    }
    expect(sneaker(engine)?.indexes).toBeUndefined();
  });

  it('requires substrate.index, not substrate.propose', async () => {
    const { engine } = await setup();
    const env = await proposeIndex(
      engine,
      { namespace: NS, type: 'Sneaker', action: 'add', declaration: { fields: ['brand'] } },
      PROPOSER
    );
    expect(code(env)).toBe('policy_denied');
    // Nor can the propose capability write a stored declaration directly.
    const direct = await engine.mutate({
      frame: {
        [`${NS}/updateTypeProposal`]: {
          params: { id: 'any', indexesJson: '[{"fields":["brand"]}]' },
          fields: { id: true }
        }
      },
      ctx: PROPOSER
    });
    expect(code(direct)).toBe('policy_denied');
    // The grant must cover the target namespace, not only some other one.
    const elsewhere = await proposeIndex(
      engine,
      { namespace: NS, type: 'Sneaker', action: 'add', declaration: { fields: ['brand'] } },
      {
        ...REVIEWER,
        identity: {
          id: 'r',
          tokenId: 'r',
          grants: { _system_proposals: ['read', 'mutate', 'substrate.index'] }
        }
      }
    );
    expect(code(elsewhere)).toBe('policy_denied');
    expect(sneaker(engine)?.indexes).toBeUndefined();
  });

  it('marks the referenced recommendation accepted', async () => {
    const { engine, system } = await setup();
    const rec = recommendation({
      namespace: NS,
      type: 'Sneaker',
      declarationJson: JSON.stringify({ fields: ['brand'] })
    });
    await system.write('IndexRecommendation', [rec]);
    const env = await proposeIndex(engine, {
      namespace: NS,
      type: 'Sneaker',
      action: 'add',
      recommendationId: rec.id
    });
    expect(env.errors ?? []).toEqual([]);
    expect(await recState(system, rec.id)).toBe('accepted');
    expect(sneaker(engine)?.indexes).toEqual([{ fields: ['brand'] }]);
    const [audit] = (await system.read('AuditEvent', {})).rows;
    expect(audit).toMatchObject({ kind: 'index_proposed', actorKid: 'reviewer' });
    expect(audit?.details).toMatchObject({ action: 'add', recommendationId: rec.id });

    // Accepted is closed.
    const again = await proposeIndex(engine, {
      namespace: NS,
      type: 'Sneaker',
      action: 'add',
      recommendationId: rec.id
    });
    expect(code(again)).toBe('recommendation_closed');
  });

  it('dismisses a recommendation, which then stays closed', async () => {
    const { engine, system } = await setup();
    const rec = recommendation({
      namespace: NS,
      type: 'Sneaker',
      action: 'remove',
      indexName: 'x'
    });
    await system.write('IndexRecommendation', [rec]);
    const env = await proposeIndex(engine, {
      namespace: NS,
      type: 'Sneaker',
      action: 'dismiss',
      recommendationId: rec.id
    });
    expect(env.errors ?? []).toEqual([]);
    expect(await recState(system, rec.id)).toBe('dismissed');
    const again = await proposeIndex(engine, {
      namespace: NS,
      type: 'Sneaker',
      action: 'dismiss',
      recommendationId: rec.id
    });
    expect(code(again)).toBe('recommendation_closed');
  });

  it('supersedes a recommendation whose declaration no longer validates', async () => {
    const { engine, system } = await setup();
    const rec = recommendation({
      namespace: NS,
      type: 'Sneaker',
      declarationJson: JSON.stringify({ fields: ['gone'] })
    });
    await system.write('IndexRecommendation', [rec]);
    const env = await proposeIndex(engine, {
      namespace: NS,
      type: 'Sneaker',
      action: 'add',
      recommendationId: rec.id
    });
    expect(code(env)).toBe('recommendation_stale');
    expect(await recState(system, rec.id)).toBe('superseded');
    expect(sneaker(engine)?.indexes).toBeUndefined();
  });

  it('refuses a superseded recommendation, and one for another type', async () => {
    const { engine, system } = await setup();
    const closed = recommendation({ namespace: NS, type: 'Sneaker', state: 'superseded' });
    const other = recommendation({ namespace: NS, type: 'Boot' });
    await system.write('IndexRecommendation', [closed, other]);
    const base = { namespace: NS, type: 'Sneaker', action: 'add' };
    expect(code(await proposeIndex(engine, { ...base, recommendationId: closed.id }))).toBe(
      'recommendation_closed'
    );
    expect(code(await proposeIndex(engine, { ...base, recommendationId: other.id }))).toBe(
      'invalid_params'
    );
    expect(code(await proposeIndex(engine, { ...base, recommendationId: 'missing' }))).toBe(
      'unknown_recommendation'
    );
  });
});

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('propose_index (pg)', () => {
  const APP = 'kidxapp';
  const CODE = 'kidxcode';
  let sql: Sql;
  let layout: StorageLayout;
  let engine: Engine;
  let system: Dataset;
  let codeDataset: PgDataset;
  /** The code-defined types' declarations, changed by the tests to retract an index. */
  const codeTypes = new Map<string, NamespaceTypeDef>();

  const ref = { kind: 'crossRef', ns: CODE, type: 'Maker', onDelete: 'set_null' } as const;
  const fields: Record<string, FieldDef> = {
    brand: { kind: 'scalar', type: 'string' },
    size: { kind: 'scalar', type: 'number' },
    maker: ref
  };

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    const detected = await detectLayout(sql);
    if (detected === 'absent') throw new Error('test schema is not migrated');
    layout = detected;
    const edges = new PgEdgesStore({ sql });
    const datasets = new MemoryDatasetRegistry();
    let live: Engine | undefined;
    // As the binary wires it: a proposed type's fields, order and indexes from its registry entry.
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
    codeDataset = new PgDataset({
      namespace: CODE,
      sql,
      edgesStore: edges,
      typeDefLookup: (type) => codeTypes.get(type)
    });
    datasets.set(CODE, codeDataset);
    datasets.set(
      APP,
      new PgDataset({ namespace: APP, sql, edgesStore: edges, typeDefLookup: fromRegistry })
    );
    for (const ns of ['_system_proposals', '_system']) {
      datasets.set(ns, new PgDataset({ namespace: ns, sql, edgesStore: edges }));
    }
    engine = await boot(datasets, APP);
    live = engine;
    system = datasets.get('_system') as Dataset;
  });

  afterAll(async () => {
    await storageSettled();
    await sql.end();
  });

  async function indexNames(type: string, ns = CODE): Promise<string[]> {
    return (await typeIndexesOf(sql, ns, type, layout)).map((i) => i.name);
  }

  /** A code-defined type built with `indexes`, then retracted to `keep`: returns the leftovers. */
  async function codeType(
    indexes: IndexDecl[],
    keep: IndexDecl[] = []
  ): Promise<{
    type: string;
    leftovers: string[];
    desired: string[];
  }> {
    const type = `Gadget${randomUUID().slice(0, 8)}`;
    codeTypes.set(type, { fields, indexes });
    await codeDataset.ensureTypeStorage(type);
    codeTypes.set(type, { fields, indexes: keep });
    const desired = desiredIndexKeys({
      namespace: CODE,
      type,
      layout,
      fields,
      indexes: keep,
      orderedBy: { createdAt: 'desc' }
    }).map((d) => d.name);
    const owned = (await typeIndexesOf(sql, CODE, type, layout)).filter((i) => i.engineOwned);
    return {
      type,
      desired: owned.map((i) => i.name).filter((n) => desired.includes(n)),
      leftovers: owned.map((i) => i.name).filter((n) => !desired.includes(n))
    };
  }

  it('removes an engine-owned non-unique index on a code-defined type', async () => {
    const { type, leftovers } = await codeType([{ fields: ['brand', 'size'] }]);
    expect(leftovers).toHaveLength(1);
    const name = leftovers[0] as string;
    const rec = recommendation({ namespace: CODE, type, action: 'remove', indexName: name });
    await system.write('IndexRecommendation', [rec]);
    const env = await proposeIndex(engine, {
      namespace: CODE,
      type,
      action: 'remove',
      recommendationId: rec.id
    });
    expect(env.errors ?? []).toEqual([]);
    expect(await indexNames(type)).not.toContain(name);
    expect(await recState(system, rec.id)).toBe('accepted');
  });

  it('refuses remove of a unique index, a non-engine index, and an accepted recommendation', async () => {
    const { type, leftovers } = await codeType(
      [{ fields: ['brand', 'size'] }, { fields: ['size'], unique: true }],
      [{ fields: ['size'], unique: true }]
    );
    const leftover = leftovers[0] as string;
    const unique = (await typeIndexesOf(sql, CODE, type, layout)).find(
      (i) => i.unique && i.engineOwned
    )?.name;
    expect(unique).toBeDefined();
    const table = layout === 'partitioned' ? partitionName(CODE, type) : 'rows';
    const scope =
      layout === 'partitioned'
        ? 'deleted_at IS NULL'
        : `namespace = '${CODE}' AND type = '${type}'`;
    const hand = `hand_${randomUUID().slice(0, 8)}`;
    await sql.unsafe(`CREATE INDEX ${hand} ON ${table} ((body->>'brand')) WHERE ${scope}`);

    const remove = (indexName: string) =>
      proposeIndex(engine, { namespace: CODE, type, action: 'remove', indexName });
    expect(code(await remove(unique as string))).toBe('unique_index');
    expect(code(await remove(hand))).toBe('not_engine_owned');
    expect(code(await remove('no_such_index'))).toBe('unknown_index');

    const rec = recommendation({
      namespace: CODE,
      type,
      action: 'remove',
      indexName: leftover,
      state: 'accepted'
    });
    await system.write('IndexRecommendation', [rec]);
    const closed = await proposeIndex(engine, {
      namespace: CODE,
      type,
      action: 'remove',
      recommendationId: rec.id
    });
    expect(code(closed)).toBe('recommendation_closed');

    const after = await indexNames(type);
    for (const name of [unique, hand, leftover]) expect(after).toContain(name);
  });

  it('refuses remove of a still-desired index, and supersedes a recommendation for one', async () => {
    const { type, desired } = await codeType([]);
    // The derived crossRef index, which a reconcile would only rebuild.
    const wanted = desired.find((n) => n.endsWith('_idx')) as string;
    expect(wanted).toBeDefined();
    expect(
      code(
        await proposeIndex(engine, { namespace: CODE, type, action: 'remove', indexName: wanted })
      )
    ).toBe('still_desired');
    // The partitioned layout's engine timestamp and tombstone indexes, never removable.
    for (const base of desired.filter((n) => n.endsWith('_base'))) {
      expect(
        code(
          await proposeIndex(engine, { namespace: CODE, type, action: 'remove', indexName: base })
        )
      ).toBe('still_desired');
    }
    expect(desired.some((n) => n.endsWith('_base'))).toBe(layout === 'partitioned');
    const rec = recommendation({ namespace: CODE, type, action: 'remove', indexName: wanted });
    await system.write('IndexRecommendation', [rec]);
    const env = await proposeIndex(engine, {
      namespace: CODE,
      type,
      action: 'remove',
      recommendationId: rec.id
    });
    expect(code(env)).toBe('recommendation_stale');
    expect(env.errors?.[0]?.details).toMatchObject({ reason: 'still_desired' });
    expect(await recState(system, rec.id)).toBe('superseded');
    expect(await indexNames(type)).toContain(wanted);
  });

  it('builds an added index on a proposed type in the background', async () => {
    const typeName = `Sneaker${randomUUID().slice(0, 8)}`;
    const proposed = await engine.mutate({
      frame: {
        [`${APP}/propose_type`]: {
          params: {
            typeName,
            fields: {
              brand: { kind: 'scalar', type: 'string' },
              size: { kind: 'scalar', type: 'number' }
            },
            proposedReason: 'r'
          },
          fields: { id: true }
        }
      },
      ctx: PROPOSER
    });
    expect(proposed.errors ?? []).toEqual([]);
    await storageSettled();
    const before = await indexNames(typeName, APP);
    const env = await proposeIndex(engine, {
      namespace: APP,
      type: typeName,
      action: 'add',
      declaration: { fields: ['brand', { field: 'updatedAt', dir: 'desc' }] }
    });
    expect(env.errors ?? []).toEqual([]);
    await storageSettled();
    const added = (await typeIndexesOf(sql, APP, typeName, layout)).filter(
      (i) => i.engineOwned && !before.includes(i.name)
    );
    expect(added).toHaveLength(1);
    expect(added[0]?.unique).toBe(false);
  });
});
