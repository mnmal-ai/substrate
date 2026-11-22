/**
 * `define` and `propose_action`: a coined word is its proposer's at once and
 * no one else's, its name stays unique on its type, a proposer holds at most
 * 20 live pending words in a namespace, and the words come back from their
 * records after a restart. `propose_action` takes raw JSON from any mutate,
 * so it is also tested as untrusted input.
 *
 * `shop` (`kactdef` on Postgres) declares Ticket in code, with `close`; the
 * plugin owns `lab` (`kactdefown`). The Postgres suite is skipped when
 * POSTGRES_URL is absent.
 */

import { Engine, loadPlugins, MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { PgDataset, PgEdgesStore } from '@mnmal-ai/substrate-dataset-pg';
import { autoCrudOptionsOf, defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import type {
  ActMode,
  ActResponse,
  CoordinatorPlugin,
  Dataset,
  EdgesStore,
  Identity,
  Row
} from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LAPSE_MS, MAX_PENDING_PER_PROPOSER } from '../src/action-layer.js';
import { CONTROL_NAMESPACE } from '../src/control-plane.js';
import { createNoopPubSub, createProposalsPlugin, storageSettled } from '../src/index.js';
import { deleteNamespaces, relationOf } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const VIRTUAL = 'vshop';
const PROPOSE = `${CONTROL_NAMESPACE}/propose_action`;
const both = ['read', 'mutate'];

interface World {
  ns: string;
  own: string;
  datasets: MemoryDatasetRegistry;
  edges: EdgesStore;
  clock: { ms: number };
}

function grantsOf(w: World, agent: string): Identity['grants'] {
  const grants: Record<string, Identity['grants']> = {
    'agent-a': { [w.ns]: both, [CONTROL_NAMESPACE]: ['mutate'] },
    'agent-b': { [w.ns]: both },
    'agent-c': { [w.ns]: both, [CONTROL_NAMESPACE]: ['mutate'] },
    // Reads shop, so `define` compiles and reaches propose_action.
    'agent-d': { [w.ns]: ['read'], [CONTROL_NAMESPACE]: ['mutate'] },
    'agent-e': { [CONTROL_NAMESPACE]: ['mutate'] },
    'agent-r': { '*': both }
  };
  return grants[agent] ?? {};
}

const ctxOf = (w: World, agent: string) => ({
  identity: { id: agent, tokenId: agent, grants: grantsOf(w, agent) },
  headers: {},
  meta: {}
});

function ticketPlugin(ns: string): CoordinatorPlugin {
  return {
    name: 'tickets',
    contractVersion: '>=1.0.0-alpha.0 <2.0.0',
    namespaces: [
      defineNamespace(ns, {
        Ticket: {
          fields: {
            title: field.string(),
            status: field.enum(['open', 'closed'], { default: 'open' })
          },
          actions: { close: { past: 'closed', set: { status: 'closed' } } }
        }
      })
    ]
  };
}

async function boot(w: World): Promise<Engine> {
  const datasetFor = (n: string): Dataset | undefined => w.datasets.get(n);
  const loaded = await loadPlugins({
    plugins: [
      createProposalsPlugin({
        ownedNamespaces: [w.own],
        pubsub: createNoopPubSub(),
        datasetFor,
        now: () => new Date(w.clock.ms)
      }),
      ticketPlugin(w.ns)
    ],
    edges: w.edges,
    datasetFor
  });
  const hits = new Registry();
  hits.register('Hit', {
    kind: 'type',
    fields: { score: field.number() },
    resolver: async () => []
  });
  loaded.namespaces.set(VIRTUAL, { registry: hits, virtual: true });
  const engine = new Engine({
    namespaces: loaded.namespaces,
    datasets: w.datasets,
    edges: w.edges,
    isStoredEntry: (entry) => autoCrudOptionsOf(entry.resolver) !== undefined
  });
  await loaded.runOnStart(engine);
  return engine;
}

function act(
  engine: Engine,
  w: World,
  agent: string,
  sketch: string,
  mode?: ActMode
): Promise<ActResponse> {
  return engine.act({
    sketch,
    namespace: w.ns,
    ctx: ctxOf(w, agent),
    ...(mode !== undefined ? { mode } : {})
  });
}

/** A raw propose_action mutate; resolves to its error code, or 'ok'. */
async function propose(
  engine: Engine,
  w: World,
  agent: string,
  params: Record<string, unknown>
): Promise<string> {
  const env = await engine.mutate({
    frame: { [PROPOSE]: { params, fields: { id: true } } },
    ctx: ctxOf(w, agent)
  });
  return env.errors?.[0]?.code ?? 'ok';
}

function control(w: World): Dataset {
  const dataset = w.datasets.get(CONTROL_NAMESPACE);
  if (dataset === undefined) throw new Error('no control-plane dataset');
  return dataset;
}

async function records(w: World): Promise<Row[]> {
  return (await control(w).read('ActionProposal', { limit: 1000 })).rows;
}

const reopenParams = (w: World) => ({
  namespace: w.ns,
  type: 'Ticket',
  name: 'reopen',
  decl: { kind: 'update', past: 'reopened', params: {}, set: { status: 'open' } },
  sketch: `define ${w.ns}/Ticket.reopen reopened status=open`
});

function memoryWorld(): World {
  const ns = 'shop';
  const own = 'lab';
  const datasets = new MemoryDatasetRegistry();
  for (const n of [ns, own, CONTROL_NAMESPACE])
    datasets.set(n, new MemoryDataset({ namespace: n }));
  return {
    ns,
    own,
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date() }),
    clock: { ms: Date.parse('2026-11-01T00:00:00.000Z') }
  };
}

const taken = { ok: false, error: { code: 'action_taken' } };

describe('propose_action (memory)', () => {
  let w: World;
  let engine: Engine;
  const as = (agent: string, sketch: string, mode?: ActMode) => act(engine, w, agent, sketch, mode);

  beforeEach(async () => {
    w = memoryWorld();
    engine = await boot(w);
    expect(await as('agent-a', 'create Ticket title=t status=closed')).toMatchObject({ ok: true });
  });

  it('lets the proposer use a defined word at once, and no one else', async () => {
    expect(await as('agent-a', 'define Ticket.reopen reopened status=open')).toMatchObject({
      ok: true
    });
    expect(await as('agent-a', 'reopen Ticket #1')).toMatchObject({
      ok: true,
      ack: 'reopened shop/Ticket #1'
    });
    expect(await as('agent-c', 'reopen Ticket #1')).toMatchObject({
      ok: false,
      refusal: { token: 'reopen' }
    });
    expect(await records(w)).toMatchObject([
      {
        targetNamespace: 'shop',
        targetType: 'Ticket',
        name: 'reopen',
        proposedBy: 'agent-a',
        status: 'pending',
        uses: 0,
        archived: false,
        supersededByCode: false
      }
    ]);
  });

  it('refuses agent-b, who has no control-plane grant', async () => {
    expect(await as('agent-b', 'define Ticket.reopen reopened status=open')).toMatchObject({
      ok: false,
      error: { code: 'unauthorized_namespace' }
    });
    expect(await records(w)).toEqual([]);
  });

  it('refuses a caller without mutate on the target namespace', async () => {
    expect(await as('agent-d', 'define Ticket.reopen reopened status=open')).toMatchObject({
      ok: false,
      error: { code: 'unauthorized_capability' }
    });
    expect(await propose(engine, w, 'agent-e', reopenParams(w))).toBe('unauthorized_namespace');
    expect(await records(w)).toEqual([]);
  });

  it('refuses a name taken by a declared action, another pending word, or a built-in', async () => {
    expect(await as('agent-a', 'define Ticket.close shut status=closed')).toMatchObject(taken);
    expect(await as('agent-a', 'define Ticket.reopen reopened status=open')).toMatchObject({
      ok: true
    });
    const clash = await as('agent-c', 'define Ticket.reopen reopened status=open');
    expect(clash).toMatchObject(taken);
    expect(JSON.stringify(clash)).not.toContain('agent-a');
    expect(await propose(engine, w, 'agent-c', { ...reopenParams(w), name: 'update' })).toBe(
      'action_taken'
    );
    expect(await propose(engine, w, 'agent-c', { ...reopenParams(w), name: 'define' })).toBe(
      'action_taken'
    );
    expect(await records(w)).toHaveLength(1);
  });

  it('keeps the count on an identical redefinition and resets it on a different one', async () => {
    expect(await as('agent-a', 'define Ticket.reopen reopened status=open')).toMatchObject({
      ok: true
    });
    const [row] = await records(w);
    if (row === undefined) throw new Error('no record');
    await control(w).write('ActionProposal', [{ ...row, uses: 3 }]);

    expect(await as('agent-a', 'define Ticket.reopen reopened status=open')).toMatchObject({
      ok: true
    });
    expect(await records(w)).toMatchObject([{ id: row.id, uses: 3, declJson: row.declJson }]);

    expect(await as('agent-a', 'define Ticket.reopen reopened status=open title=$')).toMatchObject({
      ok: true
    });
    const [changed] = await records(w);
    expect(changed).toMatchObject({ id: row.id, uses: 0, lastUseAt: null });
    expect(JSON.parse(String(changed?.declJson)).params).toHaveProperty('title');
    expect(await as('agent-a', 'reopen Ticket #1 title=again')).toMatchObject({ ok: true });
  });

  it('refuses the 21st pending word for one proposer in one namespace', async () => {
    for (let i = 1; i <= MAX_PENDING_PER_PROPOSER; i++) {
      expect(await as('agent-a', `define Ticket.word${i} status=open`)).toMatchObject({ ok: true });
    }
    expect(await as('agent-a', 'define Ticket.wordx status=open')).toMatchObject({
      ok: false,
      error: { code: 'pending_cap' }
    });
    // A redefinition takes no new slot, and the cap is the proposer's own.
    expect(await as('agent-a', 'define Ticket.word1 status=closed')).toMatchObject({ ok: true });
    expect(await as('agent-c', 'define Ticket.wordx status=open')).toMatchObject({ ok: true });
  });

  it('lets a lapsed word free its slot but keeps its name reserved', async () => {
    for (let i = 1; i <= MAX_PENDING_PER_PROPOSER; i++) {
      expect(await as('agent-a', `define Ticket.word${i} status=open`)).toMatchObject({ ok: true });
    }
    w.clock.ms += LAPSE_MS + 86_400_000;

    expect(await as('agent-a', 'word1 Ticket #1')).toMatchObject({
      ok: false,
      refusal: { token: 'word1' }
    });
    expect(await as('agent-a', 'define Ticket.wordx status=open')).toMatchObject({ ok: true });
    expect(await as('agent-c', 'define Ticket.word1 status=open')).toMatchObject(taken);
    // Its proposer revives it by defining it again.
    expect(await as('agent-a', 'define Ticket.word1 status=open')).toMatchObject({ ok: true });
    expect(await as('agent-a', 'word1 Ticket #1')).toMatchObject({ ok: true });
  });

  it('stores nothing on a dry-run define', async () => {
    expect(
      await as('agent-a', 'define Ticket.reopen reopened status=open', 'dry-run')
    ).toMatchObject({ ok: true });
    expect(await records(w)).toEqual([]);
    expect(await as('agent-a', 'reopen Ticket #1')).toMatchObject({
      ok: false,
      refusal: { token: 'reopen' }
    });
  });

  it('refuses virtual, _system and proposal-record targets', async () => {
    const at = (namespace: string, type: string) =>
      propose(engine, w, 'agent-r', { ...reopenParams(w), namespace, type });
    expect(await at(VIRTUAL, 'Hit')).toBe('invalid_params');
    expect(await at(CONTROL_NAMESPACE, 'ActionProposal')).toBe('invalid_params');
    expect(await at(w.own, 'TypeProposal')).toBe('invalid_params');
    expect(await at(w.ns, 'Nope')).toBe('unknown_type');
    expect(await records(w)).toEqual([]);
  });

  it('checks a raw propose_action as untrusted input', async () => {
    const base = reopenParams(w);
    const str = field.string();
    const bad: Array<Record<string, unknown>> = [
      { ...base, name: 'constructor' },
      { ...base, name: 'prototype' },
      { ...base, name: 'Reopen' },
      { ...base, sketch: 7 },
      { ...base, decl: [] },
      { ...base, decl: { ...base.decl, kind: 'create' } },
      // biome-ignore lint/suspicious/noThenProperty: `then` is the action declaration's key
      { ...base, decl: { ...base.decl, then: [] } },
      { ...base, decl: { ...base.decl, extra: 1 } },
      { ...base, decl: { params: { ids: { list: `${w.ns}/Ticket` } }, set: { status: 'open' } } },
      {
        ...base,
        decl: { params: { t: { type: str, default: 'x' } }, set: { title: { param: 't' } } }
      },
      {
        ...base,
        decl: { params: { constructor: { type: str } }, set: { title: { param: 'constructor' } } }
      },
      { ...base, decl: { set: { title: { param: 'toString' } } } },
      { ...base, decl: { set: { toString: 'x' } } },
      {
        ...base,
        decl: { params: { n: { type: field.number() } }, set: { title: { param: 'n' } } }
      },
      { ...base, decl: { set: { title: { now: false } } } },
      { ...base, decl: { set: {} } },
      { ...base, decl: { set: { status: 'gone' } } }
    ];
    for (const params of bad) {
      expect([params, await propose(engine, w, 'agent-r', params)]).toEqual([
        params,
        'invalid_params'
      ]);
    }
    // `__proto__` as JSON.parse leaves it: an own key.
    const proto = JSON.parse(
      '{"params":{"__proto__":{"type":{"kind":"scalar","type":"string"}}},"set":{"title":{"param":"__proto__"}}}'
    );
    expect(await propose(engine, w, 'agent-r', { ...base, decl: proto })).toBe('invalid_params');
    expect(Object.prototype).not.toHaveProperty('type');
    expect(await records(w)).toEqual([]);
  });

  it('refuses every client write to an ActionProposal record', async () => {
    expect(await as('agent-a', 'define Ticket.reopen reopened status=open')).toMatchObject({
      ok: true
    });
    const [row] = await records(w);
    const write = async (key: string, params: Record<string, unknown>) =>
      (
        await engine.mutate({
          frame: { [`${CONTROL_NAMESPACE}/${key}`]: { params, fields: { id: true } } },
          ctx: ctxOf(w, 'agent-r')
        })
      ).errors?.[0]?.code;
    if (row === undefined) throw new Error('no record');
    expect(await write('updateActionProposal', { id: row.id, uses: 99 })).toBe('policy_denied');
    expect(await write('updateActionProposal', { id: row.id, archived: true })).toBe(
      'policy_denied'
    );
    expect(await write('deleteActionProposal', { id: row.id })).toBe('policy_denied');
    const { declJson, sketch } = row;
    expect(
      await write('createActionProposal', {
        targetNamespace: w.ns,
        targetType: 'Ticket',
        name: 'sneak',
        declJson,
        sketch,
        proposedAt: new Date(),
        status: 'pending',
        uses: 0,
        lastUseAt: null,
        promotedAt: null,
        resultingSchemaVersion: null,
        supersededByCode: false,
        archived: false
      })
    ).toBe('policy_denied');
    expect(await records(w)).toMatchObject([{ id: row.id, uses: 0, archived: false }]);
  });

  it('brings pending words back after a restart', async () => {
    expect(await as('agent-a', 'define Ticket.reopen reopened status=open')).toMatchObject({
      ok: true
    });
    engine = await boot(w);
    expect(await as('agent-a', 'reopen Ticket #1')).toMatchObject({
      ok: true,
      ack: 'reopened shop/Ticket #1'
    });
    expect(await as('agent-c', 'define Ticket.reopen reopened status=open')).toMatchObject(taken);
  });
});

/** Only this file writes ActionProposal rows; the shared control plane keeps everything else. */
async function clearActionProposals(sql: Sql): Promise<void> {
  const table = await relationOf(sql, CONTROL_NAMESPACE, 'ActionProposal').catch(() => undefined);
  if (table !== undefined) await sql.unsafe(`DELETE FROM ${table}`);
  await sql`DELETE FROM row_ids WHERE namespace = ${CONTROL_NAMESPACE} AND type = 'ActionProposal'`;
}

describe.skipIf(!POSTGRES_URL)('propose_action (pg)', () => {
  const ns = 'kactdef';
  const own = 'kactdefown';
  let sql: Sql;

  const pgWorld = (): World => {
    const edges = new PgEdgesStore({ sql });
    const datasets = new MemoryDatasetRegistry();
    for (const n of [ns, own, CONTROL_NAMESPACE]) {
      datasets.set(n, new PgDataset({ namespace: n, sql, edgesStore: edges }));
    }
    return { ns, own, datasets, edges, clock: { ms: Date.parse('2026-11-01T00:00:00.000Z') } };
  };
  const clean = async (): Promise<void> => {
    await deleteNamespaces(sql, ns, own);
    await clearActionProposals(sql);
  };

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {}, max: 10 });
    await clean();
  });

  beforeEach(clean);

  afterAll(async () => {
    await storageSettled();
    await clean();
    await sql.end({ timeout: 5 });
  });

  it('lets exactly one of two concurrent defines of one name win', async () => {
    // Two instances on one store: neither layer hears the other's define.
    const w = pgWorld();
    const [one, two] = [await boot(w), await boot(pgWorld())];
    const sketch = 'define Ticket.reopen reopened status=open';
    const replies = await Promise.all([
      act(one, w, 'agent-a', sketch),
      act(two, w, 'agent-c', sketch)
    ]);
    expect(replies.filter((r) => r.ok)).toHaveLength(1);
    expect(replies.filter((r) => !r.ok)).toMatchObject([taken]);
    expect(await records(w)).toHaveLength(1);
  });

  it('brings pending words back after a restart', async () => {
    const w = pgWorld();
    const engine = await boot(w);
    expect(
      await act(engine, w, 'agent-a', 'define Ticket.reopen reopened status=open')
    ).toMatchObject({ ok: true });
    const again = await boot(pgWorld());
    expect(
      await act(again, w, 'agent-a', 'create Ticket title=t status=closed as $t; reopen Ticket $t')
    ).toMatchObject({ ok: true });
    expect(
      await act(again, w, 'agent-c', 'define Ticket.reopen reopened status=open')
    ).toMatchObject(taken);
  });
});
