/**
 * `Engine.act` on pg: two namespaces on one pool coalesce into one
 * transaction, a failing step rolls every earlier step back, a dry run writes
 * nothing, an int64 past 2^53 lands exactly, a crossRef `#N` or binding
 * stores the real id, and records go to
 * `PgActResultStore`. The memory counterpart is the SDK's `act-engine.test.ts`.
 */

import { Engine, type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import type { ActionDecl, ActResponse, FieldDef, Identity, Row } from '@mnmal-ai/substrate-types';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrate.js';
import { PgActResultStore } from '../src/pg-act-result-store.js';
import { PgDataset } from '../src/pg-dataset.js';
import { PgEdgesStore } from '../src/pg-edges-store.js';
import { clearNamespace, dropNamespace } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const WORK = 'test_act_work';
const JOURNAL = 'test_act_journal';
const OWNER = 'test-act-alice';
const alice: Identity = {
  id: OWNER,
  agentKeyId: `${OWNER}-key`,
  grants: { [WORK]: ['read', 'mutate'], [JOURNAL]: ['read', 'mutate'] }
};
const ctx = { identity: alice };

const defs: Record<string, Record<string, Record<string, FieldDef>>> = {
  [WORK]: {
    Todo: {
      title: field.string(),
      status: field.enum(['open', 'closed'], { default: 'open' }),
      archived: field.boolean({ default: false })
    },
    Note: { title: field.string(), todo: field.crossRef(WORK, 'Todo') },
    Thing: { big: field.int64({ nullable: true }) }
  },
  [JOURNAL]: {
    SessionLog: { summary: field.string(), branch: field.string(), startedAt: field.date() }
  }
};
const close: ActionDecl = { past: 'closed', set: { status: 'closed', archived: true } };
const log: ActionDecl = {
  kind: 'create',
  past: 'logged',
  params: {
    summary: { type: field.string() },
    branch: { type: field.string() },
    closes: { list: `${WORK}/Todo`, optional: true }
  },
  set: { summary: { param: 'summary' }, branch: { param: 'branch' }, startedAt: { now: true } },
  // biome-ignore lint/suspicious/noThenProperty: `then` is the action declaration's key
  then: [{ action: `${WORK}/Todo.close`, each: { param: 'closes' } }]
};

describe.skipIf(!POSTGRES_URL)('Engine.act on pg', () => {
  let sql: ReturnType<typeof postgres>;
  let engine: Engine;
  let results: PgActResultStore;

  const dataset = (ns: string, edges: PgEdgesStore): PgDataset => {
    const types = defs[ns] ?? {};
    return new PgDataset({
      namespace: ns,
      sql,
      edgesStore: edges,
      fieldDefLookup: (type, f) => types[type]?.[f],
      typeDefLookup: (type) => ({ fields: types[type] ?? {} })
    });
  };

  beforeAll(async () => {
    if (!POSTGRES_URL) return;
    sql = postgres(POSTGRES_URL, { onnotice: () => {} });
    await runMigrations(sql);
    const edges = new PgEdgesStore({ sql });
    const work = dataset(WORK, edges);
    const journal = dataset(JOURNAL, edges);
    const workReg = new Registry();
    const journalReg = new Registry();
    const types = defs[WORK] ?? {};
    defineNamespace(WORK, {
      Todo: { fields: types.Todo ?? {}, actions: { close } },
      Note: { fields: types.Note ?? {} },
      Thing: { fields: types.Thing ?? {} }
    }).install({ registry: workReg, dataset: work, edges });
    defineNamespace(JOURNAL, {
      SessionLog: { fields: defs[JOURNAL]?.SessionLog ?? {}, actions: { log } }
    }).install({ registry: journalReg, dataset: journal, edges });
    const datasets = new MemoryDatasetRegistry();
    datasets.set(WORK, work);
    datasets.set(JOURNAL, journal);
    results = new PgActResultStore({ sql });
    engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([
        [WORK, { registry: workReg }],
        [JOURNAL, { registry: journalReg }]
      ]),
      datasets,
      edges,
      act: { results }
    });
  });

  beforeEach(async () => {
    for (const ns of [WORK, JOURNAL]) await clearNamespace(sql, ns);
    await sql`DELETE FROM act_results WHERE record->>'owner' = ${OWNER}`;
  });

  afterAll(async () => {
    if (!POSTGRES_URL) return;
    for (const ns of [WORK, JOURNAL]) await dropNamespace(sql, ns);
    await sql`DELETE FROM act_results WHERE record->>'owner' = ${OWNER}`;
    await sql.end();
  });

  /** Creates a row through the engine and returns it with its shortId. */
  async function create(type: string, params: Record<string, unknown>): Promise<Row> {
    const key = `${WORK}/create${type}`;
    const env = await engine.mutate({
      frame: { [key]: { params, fields: { id: true, shortId: true } } },
      ctx
    });
    expect(env.errors).toBeUndefined();
    return env.data[key] as Row;
  }

  async function read(type: string, id: unknown): Promise<Row | undefined> {
    const key = `${WORK}/${type}`;
    const env = await engine.query({
      frame: { [key]: { params: { where: { id: { eq: id } } } } },
      ctx
    });
    expect(env.errors).toBeUndefined();
    return (env.data[key] as Row[])[0];
  }

  const resultOf = (r: ActResponse): string => {
    if (!('result' in r) || r.result === null) throw new Error(`no result: ${JSON.stringify(r)}`);
    return r.result;
  };

  it('commits a composite across both namespaces in one transaction', async () => {
    const a = await create('Todo', { title: 'a' });
    const b = await create('Todo', { title: 'b' });
    const r = await engine.act({
      sketch: `log SessionLog summary=s branch=b closes=#${a.shortId},#${b.shortId}`,
      ctx
    });
    expect(r).toMatchObject({
      ok: true,
      ack: expect.stringMatching(
        new RegExp(
          `^logged ${JOURNAL}/SessionLog #\\d+; closed ${WORK}/Todo #${a.shortId} #${b.shortId}$`
        )
      )
    });
    for (const t of [a, b]) {
      expect(await read('Todo', t.id)).toMatchObject({ status: 'closed', archived: true });
    }
    const rec = await engine.actResult(resultOf(r), alice);
    expect(rec?.steps).toHaveLength(3);
    expect(rec?.plan.steps).toHaveLength(3);
  });

  it('rolls an earlier step back when a later one fails', async () => {
    const a = await create('Todo', { title: 'a' });
    const r = await engine.act({ sketch: `close Todo #${a.shortId}; close Todo #999999999`, ctx });
    expect(r).toMatchObject({ ok: false, error: { step: 2, code: 'not_found' } });
    expect(await read('Todo', a.id)).toMatchObject({ status: 'open', archived: false });
    expect((await engine.actResult(resultOf(r), alice))?.error?.step).toBe(2);

    const across = await engine.act({
      sketch: `log SessionLog summary=s branch=b closes=#${a.shortId},#999999999`,
      ctx
    });
    expect(across).toMatchObject({ ok: false, error: { step: 3, code: 'not_found' } });
    const logs = await engine.query({ frame: { [`${JOURNAL}/SessionLog`]: { params: {} } }, ctx });
    expect(logs.data[`${JOURNAL}/SessionLog`]).toEqual([]);
    expect(await read('Todo', a.id)).toMatchObject({ status: 'open' });
  });

  it('writes nothing in a dry run', async () => {
    const a = await create('Todo', { title: 'a' });
    const r = await engine.act({
      sketch: `create Note title=x; close Todo #${a.shortId}`,
      mode: 'dry-run',
      ctx
    });
    expect(r).toMatchObject({ ok: true, ack: expect.stringMatching(/^dry run: created /) });
    const notes = await engine.query({ frame: { [`${WORK}/Note`]: { params: {} } }, ctx });
    expect(notes.data[`${WORK}/Note`]).toEqual([]);
    expect(await read('Todo', a.id)).toMatchObject({ status: 'open' });
  });

  it('writes an int64 past 2^53 exactly', async () => {
    const t = await create('Thing', { big: null });
    const r = await engine.act({ sketch: `update Thing #${t.shortId} big=9007199254740993`, ctx });
    expect(r).toMatchObject({ ok: true });
    expect((await read('Thing', t.id))?.big).toBe(9007199254740993n);
  });

  it('stores the real id for a crossRef shortId and for a binding', async () => {
    const a = await create('Todo', { title: 'a' });
    const r = await engine.act({ sketch: `create Note title=x todo=#${a.shortId}`, ctx });
    expect(r).toMatchObject({ ok: true });
    const byShortId = await engine.query({
      frame: { [`${WORK}/Note`]: { params: { where: { title: { eq: 'x' } } } } },
      ctx
    });
    expect((byShortId.data[`${WORK}/Note`] as Row[])[0]?.todo).toBe(a.id);

    const bound = await engine.act({
      sketch: 'create Todo title=b as $t; create Note title=y todo=$t',
      ctx
    });
    expect(bound).toMatchObject({ ok: true });
    const env = await engine.query({
      frame: {
        [`${WORK}/Note`]: { params: { where: { title: { eq: 'y' } } } },
        [`${WORK}/Todo`]: { params: { where: { title: { eq: 'b' } } } }
      },
      ctx
    });
    const todo = (env.data[`${WORK}/Todo`] as Row[])[0];
    expect(todo?.id).toBeDefined();
    expect((env.data[`${WORK}/Note`] as Row[])[0]?.todo).toBe(todo?.id);
  });
});
