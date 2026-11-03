/**
 * autoCRUD batch resolvers through `Engine`, memory against pg: every
 * scenario's envelopes are identical, and each batch answers as the same
 * elements dispatched one at a time. Also counts the statements a batch sends
 * on pg, which must not grow with the batch.
 *
 * Each scenario gets a fresh namespace, so pg's short-id sequences start at 1
 * as memory's do.
 */

import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { row as rowPolicy } from '@mnmal-ai/substrate-policy';
import { field, installAutoCrud } from '@mnmal-ai/substrate-sdk';
import type {
  Dataset,
  Edge,
  EdgesStore,
  FieldDef,
  PackEnvelope,
  Policy,
  RequestContext
} from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset, PgEdgesStore } from '../src/index.js';
import { dropNamespacesLike, TABLES } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const PARTITIONED = process.env.SUBSTRATE_TEST_LAYOUT === 'partitioned';
const NOW = new Date('2026-11-01T12:00:00.000Z');
const PREFIX = 'bcrud';
const ITEM_SEL = { id: true, title: true, owner: true, parent: true, shortId: true };
const DEL_SEL = { id: true, deleted: true };

type Params = Record<string, unknown>;
type Kind = 'memory' | 'pg';

function fieldsFor(ns: string) {
  const owner: Record<string, FieldDef> = { id: field.string(), name: field.string() };
  const item: Record<string, FieldDef> = {
    id: field.string(),
    title: field.string(),
    owner: field.crossRef(ns, 'Owner', { onDelete: 'restrict' }),
    parent: field.crossRef(ns, 'Item'),
    shortId: { kind: 'scalar', type: 'number', readonly: true }
  };
  return { owner, item };
}

function ctx(id = 'tester'): RequestContext {
  return {
    identity: { kind: 'agent', id, agentKeyId: id, grants: { '*': ['read', 'mutate'] } },
    namespace: 'any',
    operation: 'mutate',
    now: NOW,
    headers: {},
    meta: {}
  };
}

/**
 * Null and absent read alike here: pg answers a projected absent key as null
 * until the explicit-null change lands, and memory leaves it out.
 */
function norm(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(norm);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== null && v !== undefined) out[k] = norm(v);
  return out;
}

const items = (n: number): Params[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `i${String(i).padStart(3, '0')}`,
    title: `item ${i}`,
    owner: `o${i % 10}`,
    ...(i > 0 ? { parent: `i${String(i - 1).padStart(3, '0')}` } : {})
  }));

describe('autoCRUD batch resolvers: memory vs pg through Engine', () => {
  let sql: Sql | undefined;
  let statements: string[] = [];
  let seq = 0;
  const run = Date.now().toString(36);

  beforeAll(() => {
    if (POSTGRES_URL === undefined) return;
    sql = postgres(POSTGRES_URL, {
      onnotice: () => {},
      debug: (_conn, query) => {
        statements.push(query);
      }
    });
  });

  afterAll(async () => {
    if (sql === undefined) return;
    const like = `${PREFIX}%`;
    await sql`DELETE FROM short_ids WHERE namespace LIKE ${like}`;
    await sql`DELETE FROM edges WHERE from_ns LIKE ${like} OR to_ns LIKE ${like}`;
    await dropNamespacesLike(sql, PREFIX);
    await sql.end();
  });

  async function stack(kind: Kind, ns: string, itemPolicy?: Policy) {
    let dataset: Dataset;
    let edges: EdgesStore;
    if (kind === 'pg') {
      const pgEdges = new PgEdgesStore({ sql: sql as Sql });
      const pg = new PgDataset({ namespace: ns, sql: sql as Sql, edgesStore: pgEdges });
      if (PARTITIONED) {
        await pg.ensureTypeStorage('Owner');
        await pg.ensureTypeStorage('Item');
      }
      dataset = pg;
      edges = pgEdges;
    } else {
      dataset = new MemoryDataset({ namespace: ns });
      edges = new MemoryEdgesStore({ now: () => NOW });
    }
    const { owner, item } = fieldsFor(ns);
    const registry = new Registry();
    installAutoCrud(registry, 'Owner', dataset, edges, { fields: owner });
    installAutoCrud(registry, 'Item', dataset, edges, {
      fields: item,
      ...(itemPolicy !== undefined ? { policy: itemPolicy } : {})
    });
    const datasets = new MemoryDatasetRegistry();
    datasets.set(ns, dataset);
    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([[ns, { registry }]]),
      datasets,
      edges
    });
    const sel = (op: string) => (op.startsWith('delete') ? DEL_SEL : ITEM_SEL);
    const mutate = (op: string, params: Params | Params[], as = 'tester') =>
      engine.mutate({
        frame: {
          [`${ns}/${op}`]: Array.isArray(params)
            ? params.map((p) => ({ params: p, fields: sel(op) }))
            : { params, fields: sel(op) }
        },
        ctx: ctx(as)
      });
    /** The envelope with the namespace taken out of keys and paths, nulls as absent. */
    const strip = (env: PackEnvelope) => {
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(env.data)) data[k.slice(ns.length + 1)] = norm(v);
      const errors = (env.errors ?? []).map((e) => ({
        ...e,
        message: e.message.replaceAll(ns, '<ns>'),
        path: e.path?.map((p) => p.replace(`${ns}/`, ''))
      }));
      return { data, errors };
    };
    const sequential = async (op: string, params: Params[], as = 'tester') => {
      const out: unknown[] = [];
      for (const p of params) out.push((await mutate(op, p, as)).data[`${ns}/${op}`] ?? null);
      return norm(out);
    };
    const liveIds = async (type: string) =>
      (await dataset.read(type, {})).rows.map((r) => String(r.id)).sort();
    const allEdges = async () => {
      const { edges: list } = await edges.readNextBatch(null, 100_000);
      return list
        .filter((e: Edge) => e.from.ns === ns)
        .map((e: Edge) => ({
          from: String(e.from.id),
          to: `${e.to.type}:${String(e.to.id)}`,
          fieldName: e.fieldName,
          policy: e.policy,
          live: e.deletedAt == null
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    };
    const seedOwners = async () => {
      const env = await mutate(
        'createOwner',
        Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, name: `owner ${i}` }))
      );
      expect(env.errors).toBeUndefined();
    };
    return { kind, ns, dataset, edges, mutate, strip, sequential, liveIds, allEdges, seedOwners };
  }
  type Stack = Awaited<ReturnType<typeof stack>>;

  const fresh = () => `${PREFIX}_${run}_${++seq}`;

  /**
   * Run `scenario` on memory, then on pg when POSTGRES_URL is set, each in a
   * fresh namespace, and expect the same result from both.
   */
  async function onBoth(
    scenario: (s: Stack, fresh: (p?: Policy) => Promise<Stack>) => Promise<unknown>
  ): Promise<void> {
    const kinds: Kind[] = sql === undefined ? ['memory'] : ['memory', 'pg'];
    const results: unknown[] = [];
    for (const kind of kinds) {
      const s = await stack(kind, fresh());
      results.push(await scenario(s, (p) => stack(kind, fresh(), p)));
    }
    if (results.length === 2) expect(results[1]).toEqual(results[0]);
  }

  it('createBatch of 500 equals 500 sequential creates (rows, shortIds, edges)', async () => {
    await onBoth(async (a, other) => {
      const b = await other();
      await a.seedOwners();
      await b.seedOwners();
      const params = items(500);
      const env = await a.mutate('createItem', params);
      expect(env.errors).toBeUndefined();
      const seq = await b.sequential('createItem', params);
      expect(a.strip(env).data.createItem).toEqual(seq);
      expect(await a.liveIds('Item')).toEqual(await b.liveIds('Item'));
      expect(await a.allEdges()).toEqual(await b.allEdges());
      return { env: a.strip(env), edges: await a.allEdges() };
    });
  });

  it('duplicate id in a create batch → id_exists present, batched_frame_rolled_back at [key,"<second index>"], nothing written', async () => {
    await onBoth(async (s) => {
      await s.seedOwners();
      const [p0, p1] = items(2) as [Params, Params];
      const env = s.strip(await s.mutate('createItem', [p0, p1, { ...p0, title: 'again' }]));
      expect(env.errors.map((e) => e.code)).toContain('id_exists');
      expect(env.errors).toContainEqual(
        expect.objectContaining({ code: 'batched_frame_rolled_back', path: ['createItem', '2'] })
      );
      expect(await s.liveIds('Item')).toEqual([]);
      return env;
    });
  });

  it('an id that already exists in the store refuses at its own index', async () => {
    await onBoth(async (s) => {
      await s.seedOwners();
      const [p0, p1, p2] = items(3) as [Params, Params, Params];
      expect((await s.mutate('createItem', { ...p1, parent: undefined })).errors).toBeUndefined();
      const env = s.strip(await s.mutate('createItem', [p0, { ...p1, parent: undefined }, p2]));
      expect(env.errors).toContainEqual(
        expect.objectContaining({ code: 'batched_frame_rolled_back', path: ['createItem', '1'] })
      );
      return env;
    });
  });

  it('two updates to one id equal sequential, slot by slot', async () => {
    await onBoth(async (a, other) => {
      const b = await other();
      for (const s of [a, b]) {
        await s.seedOwners();
        expect((await s.mutate('createItem', items(3))).errors).toBeUndefined();
      }
      const ups = [
        { id: 'i001', title: 'one', owner: 'o5' },
        { id: '2', title: 'two' },
        { id: 'i002', title: 'three' }
      ];
      const env = a.strip(await a.mutate('updateItem', ups));
      expect(env.errors).toEqual([]);
      expect(env.data.updateItem).toEqual(await b.sequential('updateItem', ups));
      expect(await a.allEdges()).toEqual(await b.allEdges());
      return { env, edges: await a.allEdges() };
    });
  });

  it('two deletes of one id: deleted true then false, as sequential', async () => {
    await onBoth(async (a, other) => {
      const b = await other();
      for (const s of [a, b]) await s.seedOwners();
      const dels = [{ id: 'o3' }, { id: 'o3' }, { id: 'o4' }];
      const env = a.strip(await a.mutate('deleteOwner', dels));
      expect(env.data.deleteOwner).toEqual([
        { id: 'o3', deleted: true },
        { id: 'o3', deleted: false },
        { id: 'o4', deleted: true }
      ]);
      expect(env.data.deleteOwner).toEqual(await b.sequential('deleteOwner', dels));
      return env;
    });
  });

  it("self-referencing crossRef to an earlier element's id is accepted", async () => {
    await onBoth(async (s) => {
      await s.seedOwners();
      const env = s.strip(
        await s.mutate('createItem', [
          { id: 'p', title: 'parent', owner: 'o0' },
          { id: 'c', title: 'child', owner: 'o0', parent: 'p' }
        ])
      );
      expect(env.errors).toEqual([]);
      return { env, edges: await s.allEdges() };
    });
  });

  it('forward reference to a later element → missing_referent, rolled back at that index', async () => {
    await onBoth(async (s) => {
      await s.seedOwners();
      const forward = s.strip(
        await s.mutate('createItem', [
          { id: 'c', title: 'child', owner: 'o0', parent: 'p' },
          { id: 'p', title: 'parent', owner: 'o0' }
        ])
      );
      expect(forward.errors.map((e) => e.code)).toContain('missing_referent');
      expect(forward.errors).toContainEqual(
        expect.objectContaining({ code: 'batched_frame_rolled_back', path: ['createItem', '0'] })
      );
      const self = s.strip(
        await s.mutate('createItem', [
          { id: 'p', title: 'parent', owner: 'o0' },
          { id: 's', title: 'self', owner: 'o0', parent: 's' }
        ])
      );
      expect(await s.liveIds('Item')).toEqual([]);
      return { forward, self };
    });
  });

  it('missing crossRef target at index 4 → missing_referent present, batched_frame_rolled_back at [key,"4"]', async () => {
    await onBoth(async (s) => {
      await s.seedOwners();
      const params = items(8);
      params[4] = { ...params[4], owner: 'nobody' };
      const env = s.strip(await s.mutate('createItem', params));
      expect(env.errors).toContainEqual(
        expect.objectContaining({ code: 'batched_frame_rolled_back', path: ['createItem', '4'] })
      );
      expect(await s.liveIds('Item')).toEqual([]);
      return env;
    });
  });

  it('the lowest failing index wins, whichever check it fails', async () => {
    await onBoth(async (s) => {
      await s.seedOwners();
      const first = items(5);
      first[1] = { id: 'i001', title: 't', owner: 'o1', bogus: true };
      first[3] = { ...first[3], owner: 'nobody' };
      const second = items(5);
      second[1] = { id: 'i001', title: 't', owner: 'nobody' };
      second[3] = { ...second[3], bogus: true };
      return [
        s.strip(await s.mutate('createItem', first)),
        s.strip(await s.mutate('createItem', second))
      ];
    });
  });

  it('updateBatch on a tombstoned id → not_found at its index, row stays tombstoned; on a purged id → not_found, nothing re-created', async () => {
    await onBoth(async (s) => {
      await s.seedOwners();
      expect((await s.mutate('createItem', items(4))).errors).toBeUndefined();
      await s.dataset.tombstone('Item', ['i002']);
      await s.dataset.purge('Item', ['i003']);
      const dead = s.strip(
        await s.mutate('updateItem', [
          { id: 'i000', title: 'x' },
          { id: 'i001', title: 'x' },
          { id: 'i002', title: 'revived?' }
        ])
      );
      expect(dead.errors).toContainEqual(
        expect.objectContaining({ code: 'batched_frame_rolled_back', path: ['updateItem', '2'] })
      );
      const purged = s.strip(
        await s.mutate('updateItem', [
          { id: 'i000', title: 'x' },
          { id: 'i003', title: 'back?' }
        ])
      );
      const all = (await s.dataset.read('Item', { includeDeleted: true })).rows;
      expect(all.map((r) => String(r.id)).sort()).toEqual(['i000', 'i001', 'i002']);
      expect(all.find((r) => r.id === 'i002')?._deletedAt ?? null).not.toBeNull();
      expect(all.map((r) => r.title).sort()).toEqual(['item 0', 'item 1', 'item 2']);
      return { dead, purged };
    });
  });

  it('updateBatch on a row-policy type hides a row the caller cannot read, as sequential does', async () => {
    const hide = rowPolicy(
      (c, r) => (r as { title?: string }).title !== `hidden from ${c.identity?.id}`
    );
    await onBoth(async (_unused, other) => {
      const a = await other(hide);
      const b = await other(hide);
      for (const s of [a, b]) {
        await s.seedOwners();
        const seed = items(3);
        seed[1] = { ...seed[1], title: 'hidden from bob' };
        expect((await s.mutate('createItem', seed, 'alice')).errors).toBeUndefined();
      }
      const ups = [
        { id: 'i000', title: 'bob 0' },
        { id: 'i001', title: 'bob 1' },
        { id: 'i002', title: 'bob 2' }
      ];
      const env = a.strip(await a.mutate('updateItem', ups, 'bob'));
      expect(env.data.updateItem).toEqual(await b.sequential('updateItem', ups, 'bob'));
      const dels = [{ id: 'i001' }, { id: 'i002' }];
      const del = a.strip(await a.mutate('deleteItem', dels, 'bob'));
      expect(del.data.deleteItem).toEqual(await b.sequential('deleteItem', dels, 'bob'));
      return { env, del };
    });
  });

  it('deleteBatch with a restrict edge on element 2 → restrict_violation present, batched_frame_rolled_back at [key,"2"]', async () => {
    await onBoth(async (s) => {
      await s.seedOwners();
      expect(
        (await s.mutate('createItem', { id: 'x', title: 'x', owner: 'o2' })).errors
      ).toBeUndefined();
      const env = s.strip(
        await s.mutate('deleteOwner', [{ id: 'o0' }, { id: 'o1' }, { id: 'o2' }, { id: 'o3' }])
      );
      expect(env.errors.map((e) => e.code)).toContain('restrict_violation');
      expect(env.errors).toContainEqual(
        expect.objectContaining({ code: 'batched_frame_rolled_back', path: ['deleteOwner', '2'] })
      );
      expect(await s.liveIds('Owner')).toHaveLength(10);
      return env;
    });
  });

  it('batch and single resolution agree: raw uuid, shortId, tombstoned shortId, numeric-looking id', async () => {
    await onBoth(async (a, other) => {
      const b = await other();
      const uuid = '0190f5f2-0000-7000-8000-000000000001';
      for (const s of [a, b]) {
        await s.seedOwners();
        // shortIds 1..5; '3' is a raw id AND the shortId of 'x7'.
        const seed = [uuid, 'dead', 'x7', '3', 'y'].map((id) => ({ id, title: id, owner: 'o0' }));
        expect((await s.mutate('createItem', seed)).errors).toBeUndefined();
        expect((await s.mutate('deleteItem', { id: 'dead' })).errors).toBeUndefined();
      }
      const dels = [{ id: uuid }, { id: '5' }, { id: '2' }, { id: '3' }, { id: 'nope' }];
      const env = a.strip(await a.mutate('deleteItem', dels));
      expect(env.data.deleteItem).toEqual([
        { id: uuid, deleted: true },
        { id: 'y', deleted: true },
        { id: '2', deleted: false },
        { id: '3', deleted: true },
        { id: 'nope', deleted: false }
      ]);
      expect(env.data.deleteItem).toEqual(await b.sequential('deleteItem', dels));
      return env;
    });
  });

  // pg only: memory enforces no unique index, so there is nothing to compare it with.
  describe.skipIf(!POSTGRES_URL)('a unique index conflict in a batch (pg)', () => {
    /**
     * `Slot` has a unique index on `code`. `perElement` takes the batch
     * resolvers off the entries, so an array runs the per-element loop:
     * sequential dispatch, the reference.
     */
    async function slots(perElement: boolean) {
      const ns = fresh();
      const ds = new PgDataset({
        namespace: ns,
        sql: sql as Sql,
        typeDefLookup: () => ({
          fields: { code: { kind: 'scalar', type: 'string' } },
          indexes: [{ fields: ['code'], unique: true, where: 'live', name: `${ns}_code_uq` }]
        })
      });
      await ds.ensureTypeStorage('Slot');
      const registry = new Registry();
      installAutoCrud(registry, 'Slot', ds, new MemoryEdgesStore({ now: () => NOW }), {
        fields: { id: field.string(), code: field.string() }
      });
      if (perElement) {
        for (const op of ['createSlot', 'updateSlot']) {
          delete (registry.get(op) as { batch?: unknown }).batch;
        }
      }
      const datasets = new MemoryDatasetRegistry();
      datasets.set(ns, ds);
      const engine = new Engine({
        namespaces: new Map<string, NamespaceConfig>([[ns, { registry }]]),
        datasets,
        edges: new MemoryEdgesStore({ now: () => NOW })
      });
      const mutate = async (op: string, params: Params | Params[]) => {
        const env = await engine.mutate({
          frame: {
            [`${ns}/${op}`]: Array.isArray(params)
              ? params.map((p) => ({ params: p, fields: { id: true, code: true } }))
              : { params, fields: { id: true, code: true } }
          },
          ctx: ctx()
        });
        return {
          data: norm(env.data[`${ns}/${op}`]),
          errors: (env.errors ?? []).map((e) => ({
            code: e.code,
            path: e.path?.map((x) => x.replace(`${ns}/`, '')),
            message: e.message.replaceAll(ns, '<ns>')
          }))
        };
      };
      expect(
        (
          await mutate('createSlot', [
            { id: 'a', code: 'x' },
            { id: 'b', code: 'y' },
            { id: 'c', code: 'z' }
          ])
        ).errors
      ).toEqual([]);
      return { mutate, ds };
    }

    const cases: Array<[string, string, Params[], string]> = [
      [
        'create: conflict with an existing row',
        'createSlot',
        [
          { id: 'd', code: 'w' },
          { id: 'e', code: 'x' },
          { id: 'f', code: 'v' }
        ],
        '1'
      ],
      [
        'create: two elements collide',
        'createSlot',
        [
          { id: 'd', code: 'w' },
          { id: 'e', code: 'v' },
          { id: 'f', code: 'v' }
        ],
        '2'
      ],
      [
        'update: conflict with an existing row',
        'updateSlot',
        [
          { id: 'a', code: 'w' },
          { id: 'b', code: 'z' }
        ],
        '1'
      ],
      [
        'update: two elements collide',
        'updateSlot',
        [
          { id: 'a', code: 'm' },
          { id: 'b', code: 'n' },
          { id: 'c', code: 'm' }
        ],
        '2'
      ]
    ];
    for (const [name, op, params, at] of cases) {
      it(`${name}: unique_violation at its index, as sequential`, async () => {
        const batched = await slots(false);
        const loop = await slots(true);
        const env = await batched.mutate(op, params);
        expect(env.errors.map(({ code, path }) => ({ code, path }))).toEqual([
          { code: 'unique_violation', path: [op] },
          { code: 'batched_frame_rolled_back', path: [op, at] }
        ]);
        expect(env).toEqual(await loop.mutate(op, params));
        const live = (await batched.ds.read('Slot', {})).rows.map(
          (r) => `${String(r.id)}=${String(r.code)}`
        );
        expect(live.sort()).toEqual(['a=x', 'b=y', 'c=z']);
      });
    }
  });

  describe.skipIf(!POSTGRES_URL)('statements a batch sends (pg)', () => {
    /** A `tables` type-table catalog lookup (`loadTypeTable`). */
    const CATALOG = /FROM substrate_type_(tables|fields)\b/;
    /** Per call of `sent`, on `tables`: the catalog lookups it dropped. */
    let lookups: number[] = [];
    /**
     * Every statement `fn` sends, transaction plumbing included. On `tables`
     * the type-table catalog lookups are counted apart: whether one is sent
     * depends on when the cache's async catalog notification lands, so they
     * are bounded per type below rather than compared exactly.
     */
    async function sent(fn: () => Promise<unknown>): Promise<string[]> {
      statements = [];
      await fn();
      if (!TABLES) return statements;
      lookups.push(statements.filter((q) => CATALOG.test(q)).length);
      return statements.filter((q) => !CATALOG.test(q));
    }

    it('create, update and delete send the same statements for 5 elements as for 50', async () => {
      const counts: Record<string, number[]> = {};
      lookups = [];
      for (const n of [5, 50]) {
        const s = await stack('pg', fresh());
        await s.seedOwners();
        const created = await sent(() => s.mutate('createItem', items(n)));
        const ids = items(n).map((p) => p.id as string);
        const updated = await sent(() =>
          s.mutate(
            'updateItem',
            ids.map((id, i) => ({ id, owner: `o${(i + 1) % 10}` }))
          )
        );
        const byShort = await sent(() =>
          s.mutate(
            'updateItem',
            ids.map((_, i) => ({ id: String(i + 1), title: 'by short' }))
          )
        );
        const deleted = await sent(() =>
          s.mutate(
            'deleteItem',
            ids.map((id) => ({ id }))
          )
        );
        for (const [k, v] of Object.entries({ created, updated, byShort, deleted })) {
          counts[k] = [...(counts[k] ?? []), v.length];
        }
      }
      for (const [k, [five, fifty]] of Object.entries(counts)) {
        expect({ k, fifty }).toEqual({ k, fifty: five });
      }
      // Catalog lookups are per type, never per element: measured [7, 2, 0, 0]
      // (create, update, byShort, delete) for 5 and for 50 alike, the create
      // making Item's table. A late notification can add one reload (two).
      if (TABLES) expect(Math.max(...lookups), JSON.stringify(lookups)).toBeLessThanOrEqual(9);
    });
  });
});
