/**
 * Actions born with a proposed type: `propose_type` takes `actions`, checks
 * each against the proposed fields and every `then` chain as compose checks
 * it, and publishes them with the type for every caller at once. They come
 * back after a restart and survive a later field proposal, a type whose
 * action another chains to cannot be archived, and `define` treats a born
 * name as declared.
 *
 * `shop` (`kborn` on Postgres) declares Ticket in code, with `close`; the
 * plugin owns `lab` (`kbornown`), then `lab2`, which replays after it. A
 * chain into a type born in `lab2` is let through when `lab` replays first,
 * as its target is not back yet. A `then` chain runs inside one transaction
 * scope, and each memory dataset is its own, so the chained target is a type
 * born first in the owned namespace. The Postgres suite is skipped when
 * POSTGRES_URL is absent.
 */

import { Engine, loadPlugins, MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { PgDataset, PgEdgesStore } from '@mnmal-ai/substrate-dataset-pg';
import { autoCrudOptionsOf, defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import type {
  ActionDecl,
  ActResponse,
  CoordinatorPlugin,
  Dataset,
  EdgesStore,
  Identity,
  Row
} from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROMOTE_USES, type ProposalActionLayer, USE_SPACING_MS } from '../src/action-layer.js';
import { CONTROL_NAMESPACE } from '../src/control-plane.js';
import { createNoopPubSub, createProposalsPlugin, storageSettled } from '../src/index.js';
import { deleteNamespaces } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
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
    'agent-r': { '*': [...both, 'substrate.propose'] },
    'agent-c': { [w.own]: both },
    'agent-a': { [w.ns]: both, [w.own]: both, [CONTROL_NAMESPACE]: ['mutate'] },
    'agent-o': { [w.own]: [...both, 'admin', 'substrate.propose'] }
  };
  return grants[agent] ?? {};
}

const ctxOf = (w: World, agent: string) => ({
  identity: { id: agent, tokenId: agent, grants: grantsOf(w, agent) },
  now: new Date(w.clock.ms),
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

const layers = new WeakMap<Engine, ProposalActionLayer>();

/** The owned namespace listed, and so replayed, after `w.own`. */
const later = (w: World): string => `${w.own}2`;

async function boot(w: World): Promise<Engine> {
  const datasetFor = (n: string): Dataset | undefined => w.datasets.get(n);
  const loaded = await loadPlugins({
    plugins: [
      createProposalsPlugin({
        ownedNamespaces: [w.own, later(w)],
        pubsub: createNoopPubSub(),
        datasetFor,
        now: () => new Date(w.clock.ms)
      }),
      ticketPlugin(w.ns)
    ],
    edges: w.edges,
    datasetFor
  });
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

const str = { kind: 'scalar', type: 'string' } as const;
const WIDGET = { name: str, status: str };
const archive: ActionDecl = { past: 'archived', set: { status: 'archived' } };

/** An update that runs `action` on each record its optional list param `items` names. */
function forEach(list: string, action: string): ActionDecl {
  return {
    params: { items: { list, optional: true } },
    // biome-ignore lint/suspicious/noThenProperty: `then` is the action declaration's key
    then: [{ action, each: { param: 'items' } }]
  };
}

/** Box's create action, which archives each Widget of `widgetNs` it is given. */
function pack(widgetNs: string): ActionDecl {
  const each = forEach(`${widgetNs}/Widget`, `${widgetNs}/Widget.archive`);
  return {
    ...each,
    kind: 'create',
    params: { ...each.params, label: { type: str } },
    set: { label: { param: 'label' } }
  };
}

/** A propose_type as `agent`; resolves to its error code, or 'ok' once its storage is ready. */
async function proposeType(
  engine: Engine,
  w: World,
  typeName: string,
  fields: Record<string, unknown>,
  actions?: Record<string, unknown>,
  ns = w.own
): Promise<string> {
  const env = await engine.mutate({
    frame: {
      [`${ns}/propose_type`]: {
        params: { typeName, fields, proposedReason: 'r', ...(actions ? { actions } : {}) },
        fields: { id: true }
      }
    },
    ctx: ctxOf(w, 'agent-r')
  });
  await storageSettled();
  return env.errors?.[0]?.code ?? 'ok';
}

function act(
  engine: Engine,
  w: World,
  agent: string,
  sketch: string,
  namespace = w.own
): Promise<ActResponse> {
  return engine.act({ sketch, namespace, ctx: ctxOf(w, agent) });
}

function owned(w: World): Dataset {
  const dataset = w.datasets.get(w.own);
  if (dataset === undefined) throw new Error('no owned dataset');
  return dataset;
}

async function typeProposal(w: World, typeName: string): Promise<Row | undefined> {
  const { rows } = await owned(w).read('TypeProposal', {
    where: { typeName: { eq: typeName } },
    includeDeleted: true,
    limit: 10
  });
  return rows[0];
}

/** Archives a TypeProposal as `agent`; resolves to the error, or 'ok'. */
async function archiveProposal(
  engine: Engine,
  w: World,
  agent: string,
  typeName: string
): Promise<{ code: string; message?: string } | 'ok'> {
  const row = await typeProposal(w, typeName);
  const env = await engine.mutate({
    frame: {
      [`${w.own}/updateTypeProposal`]: {
        params: { id: row?.id, archived: true },
        fields: { id: true }
      }
    },
    ctx: ctxOf(w, agent)
  });
  const err = env.errors?.[0];
  return err === undefined ? 'ok' : { code: String(err.code), message: err.message };
}

/** Publishes the coined word `shop/Ticket.reopen`: defined, then used 5 times an hour apart. */
async function publishReopen(engine: Engine, w: World): Promise<void> {
  const shop = (sketch: string) => act(engine, w, 'agent-a', sketch, w.ns);
  expect(await shop('define Ticket.reopen reopened status=open')).toMatchObject({ ok: true });
  for (let i = 0; i < PROMOTE_USES; i++) {
    expect(await shop('create Ticket title=t status=closed as $t; reopen Ticket $t')).toMatchObject(
      { ok: true }
    );
    await layers.get(engine)?.settled();
    w.clock.ms += USE_SPACING_MS;
  }
  expect(engine.schemaFor(w.ns).types.Ticket?.actions?.reopen).toMatchObject({ coined: true });
}

/** Each refused case: Gadget's actions, after any setup it needs. */
const refused: Record<string, (engine: Engine, w: World) => Promise<Record<string, ActionDecl>>> = {
  'field fit': async () => ({ archive: { set: { status: 7 } } }),
  'missing then target': async (_engine, w) => ({
    sweep: forEach(`${w.own}/Widget`, `${w.own}/Widget.vanish`)
  }),
  cycle: async (_engine, w) => ({
    cascade: forEach(`${w.own}/Gadget`, `${w.own}/Gadget.cascade`)
  }),
  'coined then target': async (engine, w) => {
    await publishReopen(engine, w);
    return { reopenAll: forEach(`${w.ns}/Ticket`, `${w.ns}/Ticket.reopen`) };
  }
};

function bornActions(world: () => World, restart: (w: World) => World): void {
  let w: World;
  let engine: Engine;

  beforeEach(async () => {
    w = world();
    engine = await boot(w);
  });

  it('publishes born actions with the type, for every caller at once', async () => {
    expect(await proposeType(engine, w, 'Widget', WIDGET, { archive })).toBe('ok');
    const action = engine.schemaFor(w.own).types.Widget?.actions?.archive;
    expect(action).toMatchObject({ kind: 'update', past: 'archived' });
    expect(action?.coined).toBeUndefined();
    const run = await act(
      engine,
      w,
      'agent-c',
      'create Widget name=w status=live as $w; archive Widget $w'
    );
    expect(run).toMatchObject({
      ok: true,
      ack: expect.stringContaining(`archived ${w.own}/Widget #`)
    });
    expect((await owned(w).read('Widget', {})).rows).toMatchObject([{ status: 'archived' }]);
    expect(JSON.parse(String((await typeProposal(w, 'Widget'))?.actionsJson))).toEqual({
      archive
    });
  });

  it('accepts a create action whose then targets a declared action', async () => {
    expect(await proposeType(engine, w, 'Widget', WIDGET, { archive })).toBe('ok');
    expect(await proposeType(engine, w, 'Box', { label: str }, { pack: pack(w.own) })).toBe('ok');
    expect(
      await act(
        engine,
        w,
        'agent-c',
        'create Widget name=a status=live as $a; create Widget name=b status=live as $b; pack Box label=both items=$a,$b'
      )
    ).toMatchObject({ ok: true });
    expect((await owned(w).read('Box', {})).rows).toMatchObject([{ label: 'both' }]);
    expect((await owned(w).read('Widget', {})).rows.map((r) => r.status)).toEqual([
      'archived',
      'archived'
    ]);
  });

  it.each(Object.keys(refused))('refuses %s', async (name) => {
    expect(await proposeType(engine, w, 'Widget', WIDGET, { archive })).toBe('ok');
    const actions = await (refused[name] as (typeof refused)[string])(engine, w);
    expect(await proposeType(engine, w, 'Gadget', WIDGET, actions)).toBe('invalid_params');
    expect(await typeProposal(w, 'Gadget')).toBeUndefined();
    expect(engine.schemaFor(w.own).types.Gadget).toBeUndefined();
  });

  it('keeps born actions after a restart and a later field proposal', async () => {
    expect(await proposeType(engine, w, 'Widget', WIDGET, { archive })).toBe('ok');
    const env = await engine.mutate({
      frame: {
        [`${w.own}/propose_field`]: {
          params: {
            targetType: 'Widget',
            fieldName: 'note',
            fieldSpec: { ...str, nullable: true },
            proposedReason: 'r'
          },
          fields: { id: true }
        }
      },
      ctx: ctxOf(w, 'agent-r')
    });
    expect(env.errors).toBeUndefined();
    await storageSettled();

    w = restart(w);
    engine = await boot(w);
    const widget = engine.schemaFor(w.own).types.Widget;
    expect(widget?.fields).toHaveProperty('note');
    expect(widget?.actions?.archive).toMatchObject({ kind: 'update', past: 'archived' });
    expect(
      await act(
        engine,
        w,
        'agent-c',
        'create Widget name=w status=live note=n as $w; archive Widget $w'
      )
    ).toMatchObject({ ok: true });
    expect((await owned(w).read('Widget', {})).rows).toMatchObject([
      { status: 'archived', note: 'n' }
    ]);
  });

  it('replays a type whose then targets a type born in an owned namespace replayed after it', async () => {
    expect(await proposeType(engine, w, 'Widget', WIDGET, { archive }, later(w))).toBe('ok');
    expect(await proposeType(engine, w, 'Box', { label: str }, { pack: pack(later(w)) })).toBe(
      'ok'
    );
    w = restart(w);
    engine = await boot(w);
    expect(engine.schemaFor(w.own).types.Box?.actions?.pack).toMatchObject({ kind: 'create' });
  });

  it('refuses removing a type whose action another type chains to', async () => {
    expect(await proposeType(engine, w, 'Widget', WIDGET, { archive })).toBe('ok');
    expect(await proposeType(engine, w, 'Box', { label: str }, { pack: pack(w.own) })).toBe('ok');
    const refusal = await archiveProposal(engine, w, 'agent-o', 'Widget');
    expect(refusal).toMatchObject({ code: 'action_chained' });
    expect(refusal === 'ok' ? '' : refusal.message).toContain(`${w.own}/Box.pack`);
    expect(await typeProposal(w, 'Widget')).toMatchObject({ archived: false });

    expect(await archiveProposal(engine, w, 'agent-o', 'Box')).toBe('ok');
    w = restart(w);
    engine = await boot(w);
    expect(await archiveProposal(engine, w, 'agent-o', 'Widget')).toBe('ok');
  });

  it('refuses define for a born name', async () => {
    expect(await proposeType(engine, w, 'Widget', WIDGET, { archive })).toBe('ok');
    expect(
      await act(engine, w, 'agent-a', 'define Widget.archive binned status=binned')
    ).toMatchObject({ ok: false, error: { code: 'action_taken' } });
  });
}

describe('actions born with a proposed type (memory)', () => {
  bornActions(
    () => {
      const datasets = new MemoryDatasetRegistry();
      for (const n of ['shop', 'lab', 'lab2', CONTROL_NAMESPACE]) {
        datasets.set(n, new MemoryDataset({ namespace: n }));
      }
      return {
        ns: 'shop',
        own: 'lab',
        datasets,
        edges: new MemoryEdgesStore({ now: () => new Date() }),
        clock: { ms: Date.parse('2026-11-01T00:00:00.000Z') }
      };
    },
    (w) => w
  );
});

describe.skipIf(!POSTGRES_URL)('actions born with a proposed type (pg)', () => {
  const ns = 'kborn';
  const own = 'kbornown';
  let sql: Sql;

  const pgWorld = (clock = { ms: Date.parse('2026-11-01T00:00:00.000Z') }): World => {
    const edges = new PgEdgesStore({ sql });
    const datasets = new MemoryDatasetRegistry();
    for (const n of [ns, own, `${own}2`, CONTROL_NAMESPACE]) {
      datasets.set(n, new PgDataset({ namespace: n, sql, edgesStore: edges }));
    }
    return { ns, own, datasets, edges, clock };
  };
  const clean = async (): Promise<void> => {
    await deleteNamespaces(sql, ns, own, `${own}2`);
    const control = pgWorld().datasets.get(CONTROL_NAMESPACE) as Dataset;
    const { rows } = await control.read('ActionProposal', {
      where: { targetNamespace: { in: [ns, own, `${own}2`] } },
      includeDeleted: true,
      limit: 10000
    });
    await control.purge(
      'ActionProposal',
      rows.map((r) => r.id)
    );
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

  bornActions(
    () => pgWorld(),
    (w) => pgWorld(w.clock)
  );
});
