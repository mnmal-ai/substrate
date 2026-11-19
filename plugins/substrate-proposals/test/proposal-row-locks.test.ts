/**
 * The proposal row gates check a stored row under a row lock. The write lands
 * on the row the check read, whatever its id names by the time it runs; a
 * store that can neither lock a row nor runs one transaction at a time is
 * refused; and a mutate array locks its rows in id order, so two arrays
 * naming the same rows queue rather than deadlock (pg, skipped when
 * POSTGRES_URL is absent).
 */

import { Engine, loadPlugins, MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { PgDataset, PgEdgesStore } from '@mnmal-ai/substrate-dataset-pg';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import type {
  CoordinatorPlugin,
  Dataset,
  PackEnvelope,
  RequestContext,
  ResolverArgs,
  Row
} from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTROL_NAMESPACE } from '../src/control-plane.js';
import { createNoopPubSub, createProposalsPlugin, storageSettled } from '../src/index.js';
import { deleteNamespaces } from './_layout.js';

const T0 = new Date('2026-11-19T00:00:00Z');

function as(id: string, grants: Record<string, string[]>): Partial<RequestContext> {
  return { identity: { id, tokenId: id, grants }, now: T0, headers: {}, meta: {} };
}
/** Reads every namespace and may propose, but holds no `admin`. */
const READER = as('reader', { '*': ['read', 'mutate', 'substrate.propose'] });
const EXT_ONLY = as('ext-only', { ext: ['read', 'mutate', 'substrate.propose'] });

const clean = JSON.stringify({ kind: 'scalar', type: 'number' });
const toInvoice = JSON.stringify({ kind: 'crossRef', ns: 'app', type: 'Invoice' });
const base = {
  proposedBy: 'agent',
  proposedAt: T0,
  proposedReason: 'r',
  applied: false,
  appliedAt: null,
  supersededByCode: false,
  archived: false
};

/** `ds`, with `props` in place of its own members. */
function over(ds: Dataset, props: Record<string, unknown>): Dataset {
  return new Proxy(ds, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in props) return props[prop];
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

/** `ds` with a row lock that runs `during` the first time it is taken, as a write committing meanwhile. */
function lockingWhile(ds: Dataset, during: () => Promise<unknown>): Dataset {
  let pending: (() => Promise<unknown>) | undefined = during;
  return over(ds, {
    lockForUpdate: async () => {
      const run = pending;
      pending = undefined;
      await run?.();
    }
  });
}

describe('a proposal row gate (memory)', () => {
  async function boot() {
    const datasets = new MemoryDatasetRegistry();
    const ext = new MemoryDataset({ namespace: 'ext' });
    datasets.set('ext', ext);
    for (const ns of [CONTROL_NAMESPACE, 'app']) {
      datasets.set(ns, new MemoryDataset({ namespace: ns }));
    }
    const datasetFor = (ns: string): Dataset | undefined => datasets.get(ns);
    const app: CoordinatorPlugin = {
      name: 'app',
      contractVersion: '>=1.0.0-alpha.0 <2.0.0',
      namespaces: [defineNamespace('app', { Invoice: { fields: { number: field.string() } } })]
    };
    const proposals = createProposalsPlugin({
      ownedNamespaces: ['ext'],
      pubsub: createNoopPubSub()
    });
    const edges = new MemoryEdgesStore({ now: () => T0 });
    const loaded = await loadPlugins({ plugins: [proposals, app], datasetFor, edges });
    const engine = new Engine({ namespaces: loaded.namespaces, datasets, edges });
    await loaded.runOnStart(engine);
    const registry = loaded.namespaces.get('ext')?.registry;

    /** Creates a `type` row through the engine; returns its id. */
    async function create(type: string, params: Record<string, unknown>): Promise<string> {
      const env = await engine.mutate({
        frame: { [`ext/create${type}`]: { params: { ...base, ...params }, fields: { id: true } } },
        ctx: READER
      });
      expect(env.errors).toBeUndefined();
      return (env.data[`ext/create${type}`] as { id: string }).id;
    }
    /** Calls `key`'s resolver straight, over `dataset`. */
    function call(
      key: string,
      ctx: Partial<RequestContext>,
      params: Record<string, unknown>,
      dataset: Dataset
    ): Promise<unknown> {
      const entry = registry?.get(key);
      if (entry === undefined) throw new Error(`no ${key}`);
      return Promise.resolve(
        entry.resolver(
          { ...ctx, namespace: 'ext' } as RequestContext,
          {
            params,
            dataset
          } as ResolverArgs
        )
      );
    }
    const read = async (type: string, id: string): Promise<Row | undefined> =>
      (await ext.read(type, { id })).rows[0];
    const shortIdOf = async (type: string, id: string): Promise<string> =>
      String((await read(type, id))?.shortId);
    return { engine, ext, create, call, read, shortIdOf };
  }

  it('writes the row the reference check read, whatever its id names by then', async () => {
    const { ext, create, call, read, shortIdOf } = await boot();
    const id = await create('FieldProposal', {
      targetType: 'Order',
      fieldName: 'checked',
      fieldSpecJson: clean
    });
    const shortId = await shortIdOf('FieldProposal', id);
    // A row created under the short id while the check waited for its lock.
    const racing = lockingWhile(ext, () =>
      ext.write('FieldProposal', [
        { ...base, id: shortId, targetType: 'Order', fieldName: 'other', fieldSpecJson: toInvoice }
      ])
    );
    await call('updateFieldProposal', EXT_ONLY, { id: shortId, applied: true }, racing);
    expect(await read('FieldProposal', shortId)).toMatchObject({ applied: false });
    expect(await read('FieldProposal', id)).toMatchObject({ applied: true });
  });

  it('archives the proposal the removal check read, whatever its id names by then', async () => {
    const { engine, ext, create, call, read, shortIdOf } = await boot();
    // 'Kept' has stored rows, so removing a proposal for it needs admin; 'Idle' has none.
    const proposed = await engine.mutate({
      frame: {
        'ext/propose_type': {
          params: { typeName: 'Kept', fields: { n: JSON.parse(clean) } },
          fields: { id: true }
        }
      },
      ctx: READER
    });
    expect(proposed.errors).toBeUndefined();
    const kept = await engine.mutate({
      frame: { 'ext/createKept': { params: { n: 1 }, fields: { id: true } } },
      ctx: READER
    });
    expect(kept.errors).toBeUndefined();
    const fieldsJson = `{"n":${clean}}`;
    const id = await create('TypeProposal', { typeName: 'Idle', fieldsJson, applied: true });
    const shortId = await shortIdOf('TypeProposal', id);
    const racing = lockingWhile(ext, () =>
      ext.write('TypeProposal', [
        { ...base, id: shortId, typeName: 'Kept', fieldsJson, applied: true }
      ])
    );
    await call('updateTypeProposal', READER, { id: shortId, archived: true }, racing);
    expect(await read('TypeProposal', shortId)).toMatchObject({ archived: false });
    expect(await read('TypeProposal', id)).toMatchObject({ archived: true });
  });

  it('refuses a check over a store that can neither lock the row nor runs one transaction at a time', async () => {
    const { ext, create, call } = await boot();
    const fieldProposal = await create('FieldProposal', {
      targetType: 'Order',
      fieldName: 'checked',
      fieldSpecJson: clean
    });
    const typeProposal = await create('TypeProposal', {
      typeName: 'Idle',
      fieldsJson: `{"n":${clean}}`,
      applied: true
    });
    const unlocked = over(ext, { serialTransactions: undefined });
    const cases: Array<[string, Record<string, unknown>]> = [
      // The reference gate: a flip that leaves the row live.
      ['updateFieldProposal', { id: fieldProposal, applied: true }],
      // The removal gate: an archive by an identity without admin.
      ['updateTypeProposal', { id: typeProposal, archived: true }]
    ];
    for (const [key, params] of cases) {
      await expect(call(key, READER, params, unlocked), key).rejects.toMatchObject({
        code: 'policy_denied'
      });
      await expect(call(key, READER, params, ext), key).resolves.toMatchObject({
        id: params.id
      });
    }
  });
});

const POSTGRES_URL = process.env.POSTGRES_URL;
const EXT = 'klockext';
const TRIALS = 20;

describe.skipIf(!POSTGRES_URL)('two arrays naming the same proposal rows (pg)', () => {
  let sql: Sql;
  let engine: Engine;
  let ext: Dataset;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {}, max: 10 });
    const edges = new PgEdgesStore({ sql });
    const datasets = new MemoryDatasetRegistry();
    for (const ns of [EXT, CONTROL_NAMESPACE]) {
      datasets.set(ns, new PgDataset({ namespace: ns, sql, edgesStore: edges }));
    }
    ext = datasets.get(EXT) as Dataset;
    const datasetFor = (ns: string): Dataset | undefined => datasets.get(ns);
    const proposals = createProposalsPlugin({
      ownedNamespaces: [EXT],
      pubsub: createNoopPubSub(),
      datasetFor
    });
    const loaded = await loadPlugins({ plugins: [proposals], datasetFor, edges });
    engine = new Engine({ namespaces: loaded.namespaces, datasets, edges });
    await loaded.runOnStart(engine);
  }, 60_000);

  afterAll(async () => {
    await storageSettled();
    await deleteNamespaces(sql, EXT);
    await sql.end({ timeout: 5 });
  });

  function mutate(key: string, frame: unknown): Promise<PackEnvelope> {
    return engine.mutate({
      frame: { [`${EXT}/${key}`]: frame } as Record<string, never>,
      ctx: READER
    });
  }

  /** Two fresh rows of `type`. */
  async function pair(type: string, trial: string): Promise<string[]> {
    const rows: Record<string, (name: string) => Record<string, unknown>> = {
      TypeProposal: (name) => ({ typeName: name, fieldsJson: `{"x":${clean}}` }),
      FieldProposal: (name) => ({ targetType: 'Order', fieldName: name, fieldSpecJson: clean })
    };
    const ids: string[] = [];
    for (const side of ['A', 'B']) {
      const row = rows[type]?.(`${side}${trial}`);
      const env = await mutate(`create${type}`, {
        params: { ...base, ...row },
        fields: { id: true }
      });
      expect(env.errors).toBeUndefined();
      ids.push((env.data[`${EXT}/create${type}`] as { id: string }).id);
    }
    return ids;
  }

  const arrayOf = (ids: string[], params: Record<string, unknown>) =>
    ids.map((id) => ({ params: { id, ...params }, fields: { id: true } }));

  it('queues two updates, each made live in the other order, and both complete', async () => {
    const failures: string[] = [];
    for (const type of ['TypeProposal', 'FieldProposal']) {
      for (let i = 0; i < TRIALS; i++) {
        const ids = await pair(type, `u${i}`);
        const results = await Promise.all([
          mutate(`update${type}`, arrayOf(ids, { applied: true })),
          mutate(`update${type}`, arrayOf([...ids].reverse(), { applied: true }))
        ]);
        for (const env of results) {
          for (const e of env.errors ?? []) failures.push(`${type} ${i}: ${e.code} ${e.message}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 180_000);

  it('refuses, and never deadlocks, a delete of rows another array deleted first', async () => {
    // A deadlock surfaces as an internal error; the only refusal expected is
    // the removal gate's, for a proposal the other array already deleted.
    const others: string[] = [];
    for (let i = 0; i < TRIALS; i++) {
      const ids = await pair('TypeProposal', `d${i}`);
      const results = await Promise.all([
        mutate('deleteTypeProposal', arrayOf(ids, {})),
        mutate('deleteTypeProposal', arrayOf([...ids].reverse(), {}))
      ]);
      for (const e of results.flatMap((env) => env.errors ?? [])) {
        if (!e.message.includes('cannot load the proposal'))
          others.push(`${i}: ${e.code} ${e.message}`);
      }
      expect(results.some((env) => env.errors === undefined)).toBe(true);
      for (const id of ids) expect((await ext.read('TypeProposal', { id })).rows).toEqual([]);
    }
    expect(others).toEqual([]);
  }, 180_000);
});
