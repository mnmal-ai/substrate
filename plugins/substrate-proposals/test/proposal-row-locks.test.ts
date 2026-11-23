/**
 * The proposal row gates check a stored row under a row lock. The write lands
 * on the row the check read, whatever its id names by the time it runs, from
 * a single write or an array; a store that can neither lock a row nor runs
 * the check inside one of its one-at-a-time transactions is refused; a
 * mutate array locks its rows in id order, so two arrays naming the same rows
 * queue rather than deadlock; and a check that a type has no stored rows
 * refuses while a row of it is being written (pg, skipped when POSTGRES_URL
 * is absent).
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
import { isLiveProposal } from '../src/row-lock.js';
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

/**
 * `ds` as a store that locks rows, as pg does: a row lock that runs `during`
 * the first time it is taken, as a write committing meanwhile, and a held
 * stored-rows check.
 */
function lockingWhile(ds: Dataset, during: () => Promise<unknown>): Dataset {
  let pending: (() => Promise<unknown>) | undefined = during;
  return over(ds, {
    lockForUpdate: async () => {
      const run = pending;
      pending = undefined;
      await run?.();
    },
    hasRowsLocked: async (type: string) =>
      (await ds.read(type, { includeDeleted: true, limit: 1 })).rows.length > 0
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
    /** Calls `key`'s array resolver straight, one element per params, over `dataset`. */
    function callArray(
      key: string,
      ctx: Partial<RequestContext>,
      list: Array<Record<string, unknown>>,
      dataset: Dataset
    ): Promise<unknown> {
      const batch = registry?.get(key)?.batch;
      if (batch === undefined) throw new Error(`no array resolver for ${key}`);
      return batch(
        { ...ctx, namespace: 'ext' } as RequestContext,
        list.map((params) => ({ params, dataset }) as ResolverArgs)
      );
    }
    const read = async (type: string, id: string): Promise<Row | undefined> =>
      (await ext.read(type, { id })).rows[0];
    const shortIdOf = async (type: string, id: string): Promise<string> =>
      String((await read(type, id))?.shortId);
    return { engine, ext, create, call, callArray, read, shortIdOf };
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

  it('writes, from an array, the rows the array locked, whatever their ids name by then', async () => {
    const { ext, create, callArray, read, shortIdOf } = await boot();
    const id = await create('FieldProposal', {
      targetType: 'Order',
      fieldName: 'checked',
      fieldSpecJson: clean
    });
    const shortId = await shortIdOf('FieldProposal', id);
    // A row created under the short id while the array waited for its locks.
    const racing = lockingWhile(ext, () =>
      ext.write('FieldProposal', [
        { ...base, id: shortId, targetType: 'Order', fieldName: 'other', fieldSpecJson: clean }
      ])
    );
    await callArray('updateFieldProposal', READER, [{ id: shortId, applied: true }], racing);
    expect(await read('FieldProposal', shortId)).toMatchObject({ applied: false });
    expect(await read('FieldProposal', id)).toMatchObject({ applied: true });
  });

  it('refuses a check it cannot hold the row still for, memory outside a transaction included', async () => {
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
      // A store that can neither lock nor run one transaction at a time, then
      // memory outside a transaction, where a write can interleave.
      for (const dataset of [unlocked, ext]) {
        await expect(call(key, READER, params, dataset), key).rejects.toMatchObject({
          code: 'policy_denied'
        });
      }
      await expect(
        ext.withTransaction((tx) => call(key, READER, params, tx)),
        key
      ).resolves.toMatchObject({ id: params.id });
    }
  });

  it('refuses a stored-rows check it cannot hold still, memory outside a transaction included', async () => {
    const { ext, call } = await boot();
    const params = { ...base, typeName: 'Fresh', fieldsJson: `{"n":${clean}}`, applied: true };
    for (const dataset of [over(ext, { serialTransactions: undefined }), ext]) {
      await expect(call('createTypeProposal', READER, params, dataset)).rejects.toMatchObject({
        code: 'policy_denied',
        message: expect.stringContaining("cannot hold 'Fresh' still")
      });
    }
    await expect(
      ext.withTransaction((tx) => call('createTypeProposal', READER, params, tx))
    ).resolves.toMatchObject({ typeName: 'Fresh' });
  });
});

const POSTGRES_URL = process.env.POSTGRES_URL;
const EXT = 'klockext';
const TRIALS = 20;

describe.skipIf(!POSTGRES_URL)('proposal gates racing other writes (pg)', () => {
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

  /**
   * Runs `gate` while another transaction holds a new row of `type` written
   * but uncommitted; returns the gate's first error.
   */
  async function gateDuringInsert(type: string, gate: () => Promise<PackEnvelope>) {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let written!: () => void;
    const wrote = new Promise<void>((r) => {
      written = r;
    });
    const insert = ext.withTransaction(async (tx) => {
      await tx.write(type, [{ n: 1 }]);
      written();
      await held;
    });
    await wrote;
    try {
      return (await gate()).errors?.[0];
    } finally {
      release();
      await insert;
    }
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

  it('never leaves a field proposal live on a type with rows, from a retarget racing a return to live', async () => {
    for (const typeName of ['Stored', 'Empty']) {
      const env = await mutate('propose_type', {
        params: { typeName, fields: { n: JSON.parse(clean) } },
        fields: { id: true }
      });
      expect(env.errors).toBeUndefined();
    }
    await storageSettled();
    expect((await mutate('createStored', { params: { n: 1 }, fields: { id: true } })).errors).toBe(
      undefined
    );
    const tally: Record<string, number> = {};
    const violations: string[] = [];
    for (let i = 0; i < TRIALS; i++) {
      for (const order of ['AB', 'BA'] as const) {
        // Archived on the empty type, so neither write alone needs the drop capability.
        const created = await mutate('createFieldProposal', {
          params: {
            ...base,
            applied: true,
            archived: true,
            targetType: 'Empty',
            fieldName: `f${order}${i}`,
            fieldSpecJson: clean
          },
          fields: { id: true }
        });
        expect(created.errors).toBeUndefined();
        const id = (created.data[`${EXT}/createFieldProposal`] as { id: string }).id;
        const retarget = () =>
          mutate('updateFieldProposal', {
            params: { id, targetType: 'Stored' },
            fields: { id: true }
          });
        const unarchive = () =>
          mutate('updateFieldProposal', { params: { id, archived: false }, fields: { id: true } });
        const [a, b] =
          order === 'AB'
            ? await Promise.all([retarget(), unarchive()])
            : (await Promise.all([unarchive(), retarget()])).reverse();
        const row = (await ext.read('FieldProposal', { id })).rows[0] as Row;
        const outcome = `${order} retarget=${a?.errors?.[0]?.code ?? 'ok'} unarchive=${b?.errors?.[0]?.code ?? 'ok'} live=${isLiveProposal(row)} target=${String(row.targetType)}`;
        tally[outcome] = (tally[outcome] ?? 0) + 1;
        if (isLiveProposal(row) && row.targetType === 'Stored') violations.push(outcome);
      }
    }
    expect(violations, JSON.stringify(tally, null, 1)).toEqual([]);
  }, 180_000);
  it('refuses an applied TypeProposal for a type whose first row is being written', async () => {
    const err = await gateDuringInsert('Ghost', () =>
      mutate('createTypeProposal', {
        params: { ...base, typeName: 'Ghost', fieldsJson: `{"n":${clean}}`, applied: true },
        fields: { id: true }
      })
    );
    expect(err).toMatchObject({
      code: 'policy_denied',
      message: expect.stringContaining("'Ghost' is being written")
    });
  });

  it('refuses a live FieldProposal on a type whose row is being written', async () => {
    const env = await mutate('propose_type', {
      params: { typeName: 'Quiet', fields: { n: JSON.parse(clean) } },
      fields: { id: true }
    });
    expect(env.errors).toBeUndefined();
    await storageSettled();
    const err = await gateDuringInsert('Quiet', () =>
      mutate('createFieldProposal', {
        params: {
          ...base,
          applied: true,
          targetType: 'Quiet',
          fieldName: 'late',
          fieldSpecJson: clean
        },
        fields: { id: true }
      })
    );
    expect(err).toMatchObject({
      code: 'policy_denied',
      message: expect.stringContaining("'Quiet' is being written")
    });
  });
});
