/**
 * `define` and `propose_action`: a coined word is its proposer's at once and
 * no one else's, its name stays unique on its type, a proposer holds at most
 * 20 live pending words in a namespace, and the words come back from their
 * records after a restart. `propose_action` takes raw JSON from any mutate,
 * so it is also tested as untrusted input. Five uses an hour apart promote a
 * word for everyone, at most 10 per type. An admin of the target namespace
 * vetoes or retires a word by archiving its record, code that declares its
 * name supersedes it at boot, a namespace drop retires its words, and a peer
 * engine hears each change.
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
  ActionDecl,
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
import {
  ACTIONS_CHANNEL,
  LAPSE_MS,
  MAX_PENDING_PER_PROPOSER,
  MAX_PUBLISHED_PER_TYPE,
  PROMOTE_USES,
  type ProposalActionLayer,
  USE_SPACING_MS
} from '../src/action-layer.js';
import { CONTROL_NAMESPACE } from '../src/control-plane.js';
import {
  createNoopPubSub,
  createProposalsPlugin,
  type PubSub,
  storageSettled
} from '../src/index.js';
import { deleteNamespaces } from './_layout.js';

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
    'agent-r': { '*': [...both, 'substrate.propose'] },
    // An admin of the target namespace.
    'agent-o': { [w.ns]: [...both, 'admin'], [CONTROL_NAMESPACE]: both },
    // An admin everywhere but the target namespace.
    'agent-x': {
      [w.ns]: both,
      [w.own]: [...both, 'admin'],
      [CONTROL_NAMESPACE]: [...both, 'admin']
    }
  };
  return grants[agent] ?? {};
}

const ctxOf = (w: World, agent: string) => ({
  identity: { id: agent, tokenId: agent, grants: grantsOf(w, agent) },
  now: new Date(w.clock.ms),
  headers: {},
  meta: {}
});

function ticketPlugin(ns: string, actions: Record<string, ActionDecl> = {}): CoordinatorPlugin {
  return {
    name: 'tickets',
    contractVersion: '>=1.0.0-alpha.0 <2.0.0',
    namespaces: [
      defineNamespace(ns, {
        Ticket: {
          fields: {
            title: field.string(),
            status: field.enum(['open', 'closed'], { default: 'open' }),
            openedAt: field.date({ serverSet: 'create', nullable: true })
          },
          actions: { close: { past: 'closed', set: { status: 'closed' } }, ...actions }
        }
      })
    ]
  };
}

/** Each booted engine's action layer, for the tests that drive it directly. */
const layers = new WeakMap<Engine, ProposalActionLayer>();

function layerOf(engine: Engine): ProposalActionLayer {
  const layer = layers.get(engine);
  if (layer === undefined) throw new Error('no action layer');
  return layer;
}

async function boot(
  w: World,
  pubsub: PubSub = createNoopPubSub(),
  ticketActions: Record<string, ActionDecl> = {}
): Promise<Engine> {
  const datasetFor = (n: string): Dataset | undefined => w.datasets.get(n);
  const loaded = await loadPlugins({
    plugins: [
      createProposalsPlugin({
        ownedNamespaces: [w.own],
        pubsub,
        datasetFor,
        now: () => new Date(w.clock.ms)
      }),
      ticketPlugin(w.ns, ticketActions)
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
  const install = engine.setActionLayer.bind(engine);
  engine.setActionLayer = (layer) => {
    layers.set(engine, layer as ProposalActionLayer);
    install(layer);
  };
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

/** A raw propose_action mutate array, one transaction; resolves to its error codes. */
async function proposeArray(
  engine: Engine,
  w: World,
  agent: string,
  list: Array<Record<string, unknown>>
): Promise<string[]> {
  const env = await engine.mutate({
    frame: { [PROPOSE]: list.map((params) => ({ params, fields: { id: true } })) },
    ctx: ctxOf(w, agent)
  });
  return (env.errors ?? []).map((e) => String(e.code));
}

/** The first error a raw propose_action mutate answers. */
async function proposeError(
  engine: Engine,
  w: World,
  agent: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const env = await engine.mutate({
    frame: { [PROPOSE]: { params, fields: { id: true } } },
    ctx: ctxOf(w, agent)
  });
  return env.errors?.[0];
}

function control(w: World): Dataset {
  const dataset = w.datasets.get(CONTROL_NAMESPACE);
  if (dataset === undefined) throw new Error('no control-plane dataset');
  return dataset;
}

/** This world's records: on Postgres the control plane also holds other suites' words. */
async function records(w: World): Promise<Row[]> {
  return (
    await control(w).read('ActionProposal', {
      where: { targetNamespace: { in: [w.ns, w.own] } },
      limit: 1000
    })
  ).rows;
}

async function record(w: World, name: string): Promise<Row | undefined> {
  return (await records(w)).find((r) => r.name === name);
}

/** A client write to the control plane; resolves to its error code, or 'ok'. */
async function controlWrite(
  engine: Engine,
  w: World,
  agent: string,
  key: string,
  params: Record<string, unknown>
): Promise<string> {
  const env = await engine.mutate({
    frame: { [`${CONTROL_NAMESPACE}/${key}`]: { params, fields: { id: true } } },
    ctx: ctxOf(w, agent)
  });
  return env.errors?.[0]?.code ?? 'ok';
}

/** Archives a word's record as `agent`: a veto or a retire. */
const archive = (engine: Engine, w: World, agent: string, row: Row | undefined) =>
  controlWrite(engine, w, agent, 'updateActionProposal', { id: row?.id, archived: true });

/** Engines in one process sharing one PubSub: each notify reaches every listener. */
function loopbackPubSub(): PubSub {
  const handlers = new Map<string, Array<(payload: string) => void | Promise<void>>>();
  return {
    listen: async (channel, handler) => {
      handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
    },
    notify: async (channel, payload) => {
      for (const handler of handlers.get(channel) ?? []) await handler(payload);
    }
  };
}

/** Each run creates a ticket and reopens it, so it needs no short id. */
const REOPEN_NEW = 'create Ticket title=t status=closed as $t; reopen Ticket $t';
const unknownReopen = { ok: false, refusal: { token: 'reopen' } };

/**
 * Two engines on one store and one PubSub: a promotion on one reaches the
 * other without a restart, and so does a retire.
 */
async function peerSeesPromotion(w: World, peerWorld: World): Promise<void> {
  const pubsub = loopbackPubSub();
  const one = await boot(w, pubsub);
  const two = await boot(peerWorld, pubsub);
  expect(await act(one, w, 'agent-a', 'define Ticket.reopen reopened status=open')).toMatchObject({
    ok: true
  });
  expect(await act(two, w, 'agent-c', REOPEN_NEW)).toMatchObject(unknownReopen);
  for (let i = 0; i < PROMOTE_USES; i++) {
    expect(await act(one, w, 'agent-a', REOPEN_NEW)).toMatchObject({ ok: true });
    await layerOf(one).settled();
    w.clock.ms += USE_SPACING_MS;
  }
  expect(two.schemaFor(w.ns).types.Ticket?.actions?.reopen).toMatchObject({ coined: true });
  expect(await act(two, w, 'agent-c', REOPEN_NEW)).toMatchObject({ ok: true });

  expect(await archive(one, w, 'agent-o', await record(w, 'reopen'))).toBe('ok');
  expect(two.schemaFor(w.ns).types.Ticket?.actions?.reopen).toBeUndefined();
  expect(await act(two, w, 'agent-c', REOPEN_NEW)).toMatchObject(unknownReopen);
}

/** A peer that records what it is told. */
function recordingPubSub(sent: Array<[string, string]>): PubSub {
  return {
    listen: async () => {},
    notify: async (channel, payload) => {
      sent.push([channel, payload]);
    }
  };
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
    await layerOf(engine).settled();
    expect(await records(w)).toMatchObject([
      {
        targetNamespace: 'shop',
        targetType: 'Ticket',
        name: 'reopen',
        proposedBy: 'agent-a',
        status: 'pending',
        uses: 1,
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

  it('refuses propose_action that shares its transaction, leaving no word behind', async () => {
    const reopen = reopenParams(w);
    expect(await proposeArray(engine, w, 'agent-a', [reopen, reopen])).toContain(
      'propose_action_not_alone'
    );
    expect(await records(w)).toEqual([]);
    expect(await as('agent-a', 'reopen Ticket #1')).toMatchObject({
      ok: false,
      refusal: { token: 'reopen' }
    });
    expect(await as('agent-c', 'define Ticket.reopen reopened status=open')).toMatchObject({
      ok: true
    });
  });

  it('refuses an array that would take more than the cap in one request', async () => {
    const words = Array.from({ length: MAX_PENDING_PER_PROPOSER + 5 }, (_, i) => ({
      ...reopenParams(w),
      name: `word${i}`
    }));
    expect(await proposeArray(engine, w, 'agent-a', words)).toContain('propose_action_not_alone');
    expect(await records(w)).toEqual([]);
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

  it('refuses a word that sets a readonly or server-set field', async () => {
    const base = reopenParams(w);
    // Param types match the fields exactly, so only the server-set rule can refuse them.
    const shortIdType = { kind: 'scalar', type: 'number', indexed: true };
    const openedType = { kind: 'scalar', type: 'date', nullable: true };
    const decls = [
      { set: { shortId: 7 } },
      { params: { n: { type: shortIdType } }, set: { shortId: { param: 'n' } } },
      { set: { openedAt: { now: true } } },
      { set: { openedAt: '2026-01-01T00:00:00.000Z' } },
      { params: { at: { type: openedType } }, set: { openedAt: { param: 'at' } } }
    ];
    for (const decl of decls) {
      expect([decl, await proposeError(engine, w, 'agent-r', { ...base, decl })]).toMatchObject([
        decl,
        { code: 'invalid_params', message: expect.stringMatching(/is server-set/) }
      ]);
    }
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

  it('tells peers on a channel no namespace channel can match', async () => {
    const sent: Array<[string, string]> = [];
    engine = await boot(w, recordingPubSub(sent));
    expect(await as('agent-a', 'define Ticket.reopen reopened status=open')).toMatchObject({
      ok: true
    });
    const [row] = await records(w);
    expect(sent).toEqual([[ACTIONS_CHANNEL, String(row?.id)]]);
    // Per-namespace channels are `_substrate_proposals_<ns>`.
    expect(ACTIONS_CHANNEL.startsWith('_substrate_proposals_')).toBe(false);
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

describe('evidence', () => {
  let w: World;
  let engine: Engine;
  const as = (agent: string, sketch: string) => act(engine, w, agent, sketch);
  /** One committed run, its use recorded. */
  const use = async (sketch = 'reopen Ticket #1', agent = 'agent-a') => {
    expect(await as(agent, sketch)).toMatchObject({ ok: true });
    await layerOf(engine).settled();
  };

  beforeEach(async () => {
    w = memoryWorld();
    engine = await boot(w);
    expect(await as('agent-a', 'create Ticket title=t status=closed')).toMatchObject({ ok: true });
    expect(await as('agent-a', 'define Ticket.reopen reopened status=open')).toMatchObject({
      ok: true
    });
  });

  it('promotes after 5 uses an hour apart, for everyone', async () => {
    const v0 = engine.schemaFor('shop').schemaVersion;
    for (let i = 0; i < PROMOTE_USES; i++) {
      await use();
      w.clock.ms += USE_SPACING_MS;
    }
    const v1 = engine.schemaFor('shop').schemaVersion;
    expect(v1).not.toBe(v0);
    expect(engine.schemaFor('shop').types.Ticket?.actions?.reopen).toMatchObject({ coined: true });
    expect(await record(w, 'reopen')).toMatchObject({
      status: 'promoted',
      uses: PROMOTE_USES,
      resultingSchemaVersion: v1
    });
    expect(await as('agent-c', 'reopen Ticket #1')).toMatchObject({
      ok: true,
      ack: 'reopened shop/Ticket #1'
    });
  });

  it('counts a burst inside an hour once', async () => {
    for (let i = 0; i < PROMOTE_USES; i++) {
      await use();
      w.clock.ms += 10 * 60_000;
    }
    expect(await record(w, 'reopen')).toMatchObject({ status: 'pending', uses: 1 });
    expect(await as('agent-c', 'reopen Ticket #1')).toMatchObject({
      ok: false,
      refusal: { token: 'reopen' }
    });
  });

  it('keeps an 11th earned word ready until a slot frees, then promotes on its next use', async () => {
    const names = Array.from({ length: MAX_PUBLISHED_PER_TYPE + 1 }, (_, i) => `word${i + 1}`);
    for (const name of names) {
      expect(await as('agent-a', `define Ticket.${name} status=open`)).toMatchObject({ ok: true });
    }
    const everyWord = names.map((name) => `${name} Ticket #1`).join('; ');
    for (let i = 0; i < PROMOTE_USES; i++) {
      await use(everyWord);
      w.clock.ms += USE_SPACING_MS;
    }
    const words = (await records(w)).filter((r) => names.includes(String(r.name)));
    const promoted = words.filter((r) => r.status === 'promoted');
    const [ready, ...others] = words.filter((r) => r.status === 'pending');
    expect(promoted).toHaveLength(MAX_PUBLISHED_PER_TYPE);
    expect(others).toEqual([]);
    if (ready === undefined || promoted[0] === undefined) throw new Error('no ready word');
    expect(ready).toMatchObject({ uses: PROMOTE_USES });
    const name = String(ready.name);

    // A spaced use while the cap is full still counts, and still does not promote.
    await use(`${name} Ticket #1`);
    expect(await record(w, name)).toMatchObject({ status: 'pending', uses: PROMOTE_USES + 1 });

    expect(await archive(engine, w, 'agent-o', promoted[0])).toBe('ok');
    // At the same instant: a ready word needs no spacing.
    await use(`${name} Ticket #1`);
    expect(await record(w, name)).toMatchObject({ status: 'promoted' });
    expect(await as('agent-c', `${name} Ticket #1`)).toMatchObject({ ok: true });
  });

  it('refuses a published word cleanly once its literal no longer fits the field', async () => {
    const proposal = async (key: string, params: Record<string, unknown>) =>
      (
        await engine.mutate({
          frame: { [`${w.own}/${key}`]: { params, fields: { id: true } } },
          ctx: ctxOf(w, 'agent-r')
        })
      ).errors;
    const status = (values: string[]) => ({ kind: 'scalar', type: 'string', enum: values });
    expect(
      await proposal('propose_type', {
        typeName: 'Job',
        fields: { title: { kind: 'scalar', type: 'string' }, status: status(['open', 'closed']) },
        proposedBy: 'agent-r',
        proposedReason: 'jobs'
      })
    ).toBeUndefined();
    expect(await as('agent-r', `create ${w.own}/Job title=j status=closed`)).toMatchObject({
      ok: true
    });
    expect(await as('agent-r', `define ${w.own}/Job.reopen reopened status=open`)).toMatchObject({
      ok: true
    });
    for (let i = 0; i < PROMOTE_USES; i++) {
      await use(`reopen ${w.own}/Job #1`, 'agent-r');
      w.clock.ms += USE_SPACING_MS;
    }
    expect((await records(w)).find((r) => r.targetType === 'Job')).toMatchObject({
      status: 'promoted'
    });

    // `active` joins first: a migration target must fit both vocabularies.
    for (const [values, valueMap] of [
      [['open', 'active', 'closed'], {}],
      [['active', 'closed'], { open: 'active' }]
    ] as const) {
      expect(
        await proposal('propose_field', {
          targetType: 'Job',
          fieldName: 'status',
          fieldSpec: status([...values]),
          valueMap,
          proposedBy: 'agent-r',
          proposedReason: 'rename open to active'
        })
      ).toBeUndefined();
    }
    // The field's own refusal, as a plain update of `status` to `open` gets.
    expect(await as('agent-r', `reopen ${w.own}/Job #1`)).toMatchObject({
      ok: false,
      error: { code: 'invalid_enum_value', message: "'status' must be one of: active, closed" }
    });

    // A proposal stamps the version the engine then serves, the published word included.
    const stamped = async (type: string) =>
      (await w.datasets.get(w.own)?.read(type, { limit: 10 }))?.rows.map(
        (r) => r.resultingSchemaVersion
      );
    expect(await stamped('FieldProposal')).toContain(engine.schemaFor(w.own).schemaVersion);
    expect(
      await proposal('propose_type', {
        typeName: 'Crew',
        fields: { name: { kind: 'scalar', type: 'string' } },
        proposedBy: 'agent-r',
        proposedReason: 'crews'
      })
    ).toBeUndefined();
    expect(await stamped('TypeProposal')).toContain(engine.schemaFor(w.own).schemaVersion);
  });
});

describe('governance', () => {
  let w: World;
  let engine: Engine;
  const as = (agent: string, sketch: string) => act(engine, w, agent, sketch);
  /** Five spaced uses of `name` by its proposer. */
  const promote = async (name: string) => {
    for (let i = 0; i < PROMOTE_USES; i++) {
      expect(await as('agent-a', `${name} Ticket #1`)).toMatchObject({ ok: true });
      await layerOf(engine).settled();
      w.clock.ms += USE_SPACING_MS;
    }
    expect(await record(w, name)).toMatchObject({ status: 'promoted' });
  };

  beforeEach(async () => {
    w = memoryWorld();
    engine = await boot(w);
    expect(await as('agent-a', 'create Ticket title=t status=closed')).toMatchObject({ ok: true });
    expect(await as('agent-a', 'define Ticket.reopen reopened status=open')).toMatchObject({
      ok: true
    });
  });

  it('vetoes a pending word when an admin archives it', async () => {
    expect(await archive(engine, w, 'agent-o', await record(w, 'reopen'))).toBe('ok');
    expect(await record(w, 'reopen')).toMatchObject({ status: 'vetoed', archived: true });
    expect(await as('agent-a', 'reopen Ticket #1')).toMatchObject(unknownReopen);
  });

  it('retires a published word when an admin archives it', async () => {
    await promote('reopen');
    const v0 = engine.schemaFor('shop').schemaVersion;
    expect(await archive(engine, w, 'agent-o', await record(w, 'reopen'))).toBe('ok');
    expect(await record(w, 'reopen')).toMatchObject({ status: 'retired', archived: true });
    expect(engine.schemaFor('shop').schemaVersion).not.toBe(v0);
    expect(engine.schemaFor('shop').types.Ticket?.actions?.reopen).toBeUndefined();
    expect(await as('agent-c', 'reopen Ticket #1')).toMatchObject(unknownReopen);
  });

  it('refuses archive by a non-admin, even a substrate.propose holder, and any other client write', async () => {
    const row = await record(w, 'reopen');
    if (row === undefined) throw new Error('no record');
    const write = (key: string, params: Record<string, unknown>) =>
      controlWrite(engine, w, 'agent-o', key, params);
    expect(await archive(engine, w, 'agent-r', row)).toBe('policy_denied');
    // Admin elsewhere, the control plane included, is not admin of the word's namespace.
    expect(await archive(engine, w, 'agent-x', row)).toBe('policy_denied');
    for (const params of [
      { id: row.id, uses: 99 },
      { id: row.id, archived: true, status: 'promoted' },
      { id: row.id, archived: true, uses: 99 },
      { id: row.id, archived: false }
    ]) {
      expect([params, await write('updateActionProposal', params)]).toEqual([
        params,
        'policy_denied'
      ]);
    }
    expect(await write('deleteActionProposal', { id: row.id })).toBe('policy_denied');
    const { targetNamespace, targetType, declJson, sketch, proposedAt } = row;
    expect(
      await write('createActionProposal', {
        targetNamespace,
        targetType,
        name: 'sneak',
        declJson,
        sketch,
        proposedAt,
        status: 'promoted',
        uses: 0,
        lastUseAt: null,
        promotedAt: null,
        resultingSchemaVersion: null,
        supersededByCode: false,
        archived: false
      })
    ).toBe('policy_denied');
    expect(await records(w)).toMatchObject([{ id: row.id, status: 'pending', archived: false }]);
    expect(await as('agent-a', 'reopen Ticket #1')).toMatchObject({ ok: true });
  });

  it('keeps a vetoed or retired name closed', async () => {
    expect(await archive(engine, w, 'agent-o', await record(w, 'reopen'))).toBe('ok');
    expect(await as('agent-a', 'define Ticket.reopen reopened status=open')).toMatchObject(taken);
    expect(await as('agent-c', 'define Ticket.reopen reopened status=open')).toMatchObject(taken);

    expect(await as('agent-a', 'define Ticket.shut status=closed')).toMatchObject({ ok: true });
    await promote('shut');
    expect(await archive(engine, w, 'agent-o', await record(w, 'shut'))).toBe('ok');
    expect(await record(w, 'shut')).toMatchObject({ status: 'retired' });
    // And after a restart, which reads only live records.
    engine = await boot(w);
    expect(await as('agent-a', 'define Ticket.shut status=closed')).toMatchObject(taken);
    expect(await as('agent-c', 'define Ticket.reopen reopened status=open')).toMatchObject(taken);
  });

  it('leaves a vetoed word alone when a use reaches a layer that has not heard of the veto', async () => {
    const sent: Array<[string, string]> = [];
    engine = await boot(w, recordingPubSub(sent));
    const row = await record(w, 'reopen');
    if (row === undefined) throw new Error('no record');
    // Vetoed in the store; this engine's layer still holds the word as pending.
    await control(w).write('ActionProposal', [{ ...row, status: 'vetoed', archived: true }]);
    const layer = layerOf(engine);
    layer.used('agent-a', [{ type: 'shop/Ticket', name: 'reopen' }], new Date(w.clock.ms));
    await layer.settled();
    expect(await record(w, 'reopen')).toMatchObject({ status: 'vetoed', uses: 0, lastUseAt: null });
    expect(sent).toEqual([]);
  });

  it('marks a word supersededByCode when code now declares its name', async () => {
    engine = await boot(w, createNoopPubSub(), {
      reopen: { past: 'reopened', set: { status: 'open' } }
    });
    expect(await record(w, 'reopen')).toMatchObject({
      status: 'superseded',
      supersededByCode: true,
      archived: true
    });
    expect(engine.schemaFor('shop').types.Ticket?.actions?.reopen?.coined).toBeUndefined();
    expect(await as('agent-c', 'reopen Ticket #1')).toMatchObject({ ok: true });
    expect(await as('agent-a', 'define Ticket.reopen reopened status=open')).toMatchObject(taken);
  });

  it('brings back every live word after a restart, however many records stay live', async () => {
    const long = new Date(w.clock.ms - 2 * LAPSE_MS);
    // Lapsed words stay live records. More than a boot page (1000) of them, older
    // than the word in use, puts that word past the first page.
    await control(w).write(
      'ActionProposal',
      Array.from({ length: 1001 }, (_, i) => ({
        targetNamespace: w.ns,
        targetType: 'Ticket',
        name: `old${i}`,
        declJson: JSON.stringify({ kind: 'update', params: {}, set: { status: 'open' } }),
        sketch: `define Ticket.old${i} status=open`,
        proposedBy: 'agent-c',
        proposedAt: long,
        status: 'pending',
        uses: 0,
        lastUseAt: null,
        promotedAt: null,
        resultingSchemaVersion: null,
        supersededByCode: false,
        archived: false
      })),
      { now: long }
    );
    engine = await boot(w);
    expect(await as('agent-a', 'reopen Ticket #1')).toMatchObject({ ok: true });
  });

  it('archives words on a dropped namespace; drop_type leaves them live', async () => {
    const shop = w.datasets.get(w.ns);
    if (shop === undefined) throw new Error('no shop dataset');
    await shop.dropType('Ticket');
    expect(await record(w, 'reopen')).toMatchObject({ status: 'pending', archived: false });
    expect(await as('agent-a', REOPEN_NEW)).toMatchObject({ ok: true });

    const row = await record(w, 'reopen');
    if (row === undefined) throw new Error('no record');
    const { id: _id, ...word } = row;
    await control(w).write('ActionProposal', [{ ...word, targetNamespace: w.own, name: 'kept' }]);
    // What the drop route does: participants inside its transaction, then the tombstone.
    for (const participant of engine.dropParticipants()) {
      await participant.onDrop(w.ns, (ns) => {
        const ds = w.datasets.get(ns);
        if (ds === undefined) throw new Error(`no dataset ${ns}`);
        return ds;
      });
    }
    engine.tombstoneNamespace(w.ns);
    expect(await record(w, 'reopen')).toMatchObject({ status: 'retired', archived: true });
    expect(await record(w, 'kept')).toMatchObject({ status: 'pending', archived: false });
  });

  it('shows a peer engine a promotion without a restart', async () => {
    const peers = memoryWorld();
    await peerSeesPromotion(peers, peers);
  });
});

/** Deletes the ActionProposal rows targeting `namespaces`; the shared control plane keeps the rest. */
async function clearActionProposals(sql: Sql, ...namespaces: string[]): Promise<void> {
  const control = new PgDataset({
    namespace: CONTROL_NAMESPACE,
    sql,
    edgesStore: new PgEdgesStore({ sql })
  });
  const { rows } = await control.read('ActionProposal', {
    where: { targetNamespace: { in: namespaces } },
    includeDeleted: true,
    limit: 10000
  });
  await control.purge(
    'ActionProposal',
    rows.map((r) => r.id)
  );
}

/**
 * Resolves once a statement waits for backend `holder`'s transaction to end on
 * a row it locked. Waits on its snapshot (an index build) are not row waits.
 */
async function rowWaitOn(sql: Sql, holder: number): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const [waiting] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE ${holder} = ANY(pg_blocking_pids(pid)) AND wait_event = 'transactionid'`;
    if ((waiting?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`nothing waited for a row lock backend ${holder} holds`);
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
    await clearActionProposals(sql, ns, own);
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

  it('counts two concurrent uses of one word once', async () => {
    const sent: Array<[string, string]> = [];
    const w = pgWorld();
    const engine = await boot(w, recordingPubSub(sent));
    expect(
      await act(engine, w, 'agent-a', 'define Ticket.reopen reopened status=open')
    ).toMatchObject({ ok: true });
    sent.length = 0;
    const layer = layerOf(engine);
    const at = new Date(w.clock.ms);
    const reopen = [{ type: `${ns}/Ticket`, name: 'reopen' }];
    layer.used('agent-a', reopen, at);
    layer.used('agent-a', reopen, at);
    await layer.settled();
    expect(await records(w)).toMatchObject([{ status: 'pending', uses: 1 }]);
    // One counted write, so peers are told once.
    expect(sent).toHaveLength(1);
  });

  it('lets two words that earn promotion at once take only the last free slot', async () => {
    const w = pgWorld();
    await boot(w);
    const at = new Date(w.clock.ms);
    const anHourAgo = new Date(at.getTime() - USE_SPACING_MS);
    const word = (name: string, status: string, uses: number) => ({
      targetNamespace: ns,
      targetType: 'Ticket',
      name,
      declJson: JSON.stringify({ kind: 'update', params: {}, set: { status: 'open' } }),
      sketch: `define Ticket.${name} status=open`,
      proposedBy: 'agent-a',
      proposedAt: anHourAgo,
      status,
      uses,
      lastUseAt: anHourAgo,
      promotedAt: null,
      resultingSchemaVersion: null,
      supersededByCode: false,
      archived: false
    });
    await control(w).write('ActionProposal', [
      ...Array.from({ length: MAX_PUBLISHED_PER_TYPE - 1 }, (_, i) =>
        word(`word${i}`, 'promoted', PROMOTE_USES)
      ),
      word('late', 'pending', PROMOTE_USES - 1),
      word('later', 'pending', PROMOTE_USES - 1)
    ]);
    const engine = await boot(pgWorld());
    const layer = layerOf(engine);
    layer.used(
      'agent-a',
      [
        { type: `${ns}/Ticket`, name: 'late' },
        { type: `${ns}/Ticket`, name: 'later' }
      ],
      at
    );
    await layer.settled();
    const rows = await records(w);
    expect(rows.filter((r) => r.status === 'promoted')).toHaveLength(MAX_PUBLISHED_PER_TYPE);
    expect(rows.filter((r) => r.status === 'pending')).toMatchObject([{ uses: PROMOTE_USES }]);
  });

  it('shows a peer engine a promotion without a restart', async () => {
    await peerSeesPromotion(pgWorld(), pgWorld());
  });

  it('marks a word supersededByCode when code now declares its name', async () => {
    const w = pgWorld();
    const engine = await boot(w);
    expect(
      await act(engine, w, 'agent-a', 'define Ticket.reopen reopened status=open')
    ).toMatchObject({ ok: true });
    const again = await boot(pgWorld(), createNoopPubSub(), {
      reopen: { past: 'reopened', set: { status: 'open' } }
    });
    expect(await records(w)).toMatchObject([
      { status: 'superseded', supersededByCode: true, archived: true }
    ]);
    expect(await act(again, w, 'agent-c', REOPEN_NEW)).toMatchObject({ ok: true });
  });

  it('refuses a redefinition a promotion overtakes, and the published word stays as it was', async () => {
    const w = pgWorld();
    const engine = await boot(w);
    expect(
      await act(engine, w, 'agent-a', 'define Ticket.reopen reopened status=open')
    ).toMatchObject({ ok: true });
    const [row] = await records(w);
    if (row === undefined) throw new Error('no record');
    // One connection, so the pid read here is the backend whose transaction holds the lock.
    const holderSql = postgres(POSTGRES_URL as string, { onnotice: () => {}, max: 1 });
    let redefine: Promise<ActResponse> | undefined;
    try {
      const [{ pid }] = await holderSql<[{ pid: number }]>`SELECT pg_backend_pid() AS pid`;
      const holder = new PgDataset({ namespace: CONTROL_NAMESPACE, sql: holderSql });
      // A use holds the record's row lock while it promotes, and the redefinition starts meanwhile.
      await holder.withTransaction(async (tx) => {
        await tx.lockForUpdate?.('ActionProposal', [row.id]);
        redefine = act(engine, w, 'agent-a', 'define Ticket.reopen reopened status=closed');
        await rowWaitOn(sql, pid);
        await tx.write('ActionProposal', [
          { id: row.id, status: 'promoted', uses: PROMOTE_USES, promotedAt: new Date(w.clock.ms) }
        ]);
      });
    } finally {
      await holderSql.end({ timeout: 5 });
    }
    expect(await redefine).toMatchObject(taken);
    expect(await records(w)).toMatchObject([
      { status: 'promoted', uses: PROMOTE_USES, declJson: row.declJson }
    ]);
  });
});
