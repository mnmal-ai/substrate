/**
 * Proposal records are schema in waiting: boot replays every row marked
 * applied. So writing one needs the propose capability, one bad row must not
 * stop the boot, and a narrowed enum must stay narrowed across a restart.
 */

import { Engine, loadPlugins, MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type { RequestContext, ResolverArgs } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { createNoopPubSub, createProposalsPlugin } from '../src/index.js';

const T0 = new Date('2026-05-06T00:00:00Z');
const T1 = new Date('2026-05-07T00:00:00Z');

function row(
  over: { id?: string } & Record<string, unknown>
): { id: string } & Record<string, unknown> {
  return {
    id: 'unset',
    proposedBy: 'home',
    proposedAt: T0,
    proposedReason: 'seed',
    applied: true,
    appliedAt: T0,
    supersededByCode: false,
    archived: false,
    ...over
  };
}

async function boot(
  dataset: MemoryDataset,
  control = new MemoryDataset({ namespace: '_system_proposals' })
) {
  const datasets = new MemoryDatasetRegistry();
  datasets.set('app', dataset);
  datasets.set('_system_proposals', control);
  // Datasets a replayed NamespaceProposal could name, so only the name check refuses them.
  datasets.set('a/b', new MemoryDataset({ namespace: 'a/b' }));
  const plugin = createProposalsPlugin({
    ownedNamespaces: ['app'],
    pubsub: createNoopPubSub(),
    datasetFor: (ns) => datasets.get(ns)
  });
  const edges = new MemoryEdgesStore({ now: () => T0 });
  const loaded = await loadPlugins({
    plugins: [plugin],
    datasetFor: (ns) => datasets.get(ns),
    edges
  });
  const engine = new Engine({ namespaces: loaded.namespaces, datasets, edges });
  await loaded.runOnStart(engine);
  return { engine, loaded };
}

function ctx(capabilities: string[]): Partial<RequestContext> {
  return {
    identity: { id: 'a', tokenId: 'a', grants: { '*': capabilities } },
    now: T0,
    headers: {},
    meta: {}
  };
}

describe('proposal records', () => {
  it('cannot be written without the propose capability', async () => {
    const { engine } = await boot(new MemoryDataset({ namespace: 'app' }));
    const env = await engine.mutate({
      frame: {
        'app/createTypeProposal': {
          params: row({ typeName: 'Smuggled', fieldsJson: '{}' }),
          fields: { id: true }
        }
      },
      ctx: ctx(['read', 'mutate'])
    });
    expect(env.errors?.[0]?.code).toBe('policy_denied');
  });

  it('in the control plane cannot be written without the propose capability', async () => {
    const { engine } = await boot(new MemoryDataset({ namespace: 'app' }));
    const env = await engine.mutate({
      frame: {
        '_system_proposals/createNamespaceProposal': {
          params: row({ ns: 'smuggled' }),
          fields: { id: true }
        }
      },
      ctx: ctx(['read', 'mutate'])
    });
    expect(env.errors?.[0]?.code).toBe('policy_denied');
  });

  it('are validated on replay as at propose time', async () => {
    // A propose-capability holder can write rows directly, skipping the resolver.
    const ds = new MemoryDataset({ namespace: 'app' });
    const str = { kind: 'scalar', type: 'string' };
    await ds.write('TypeProposal', [
      row({ id: 'slash', typeName: 'a/b', fieldsJson: JSON.stringify({ t: str }) }),
      row({ id: 'nofields', typeName: 'Empty', fieldsJson: '{}' }),
      row({
        id: 'ctl',
        typeName: 'IntoControl',
        fieldsJson: JSON.stringify({
          r: { kind: 'crossRef', ns: '_system_proposals', type: 'NamespaceProposal' }
        })
      }),
      row({ id: 'ok', typeName: 'Fine', fieldsJson: JSON.stringify({ t: str }) })
    ]);
    await ds.write('FieldProposal', [
      row({
        id: 'ext',
        targetType: 'Fine',
        fieldName: 'r',
        fieldSpecJson: JSON.stringify({ kind: 'crossRef', ns: 'elsewhere', type: 'X' })
      })
    ]);
    const { engine } = await boot(ds);
    const registry = engine.registryFor('app');
    expect(registry?.has('Fine')).toBe(true);
    for (const name of ['a/b', 'Empty', 'IntoControl']) expect(registry?.has(name)).toBe(false);
    expect(registry?.get('Fine')?.fields.r).toBeUndefined();
  });

  it('never replay a namespace propose_namespace would refuse', async () => {
    const control = new MemoryDataset({ namespace: '_system_proposals' });
    await control.write('NamespaceProposal', [
      row({ id: 'slash', ns: 'a/b' }),
      row({ id: 'ctl', ns: '_system_proposals' })
    ]);
    const { engine } = await boot(new MemoryDataset({ namespace: 'app' }), control);
    expect(engine.registryFor('a/b')).toBeUndefined();
  });

  it('do not stop the boot when one is malformed', async () => {
    const ds = new MemoryDataset({ namespace: 'app' });
    await ds.write('TypeProposal', [
      row({ id: 'bad', typeName: 'Broken', fieldsJson: '{not json' }),
      row({
        id: 'good',
        typeName: 'Fine',
        fieldsJson: '{"title":{"kind":"scalar","type":"string"}}'
      })
    ]);
    const { engine } = await boot(ds);
    expect(engine.registryFor('app')?.has('Fine')).toBe(true);
    expect(engine.registryFor('app')?.has('Broken')).toBe(false);
  });

  it('keep a narrowed enum narrowed across a restart', async () => {
    const ds = new MemoryDataset({ namespace: 'app' });
    const wide = { kind: 'scalar', type: 'string', enum: ['open', 'done', 'wontfix'] };
    const narrow = { kind: 'scalar', type: 'string', enum: ['open', 'done'] };
    await ds.write('TypeProposal', [
      row({ id: 't', typeName: 'Task', fieldsJson: JSON.stringify({ status: wide }) })
    ]);
    await ds.write('FieldProposal', [
      row({
        id: 'f',
        targetType: 'Task',
        fieldName: 'status',
        fieldSpecJson: JSON.stringify(narrow),
        valueMapJson: JSON.stringify({ wontfix: 'done' }),
        appliedAt: T1
      })
    ]);
    const { engine } = await boot(ds);
    const status = engine.registryFor('app')?.get('Task')?.fields.status as { enum?: string[] };
    expect(status.enum).toEqual(['open', 'done']);
  });

  it('keep an unset indexed unset across store and replay', async () => {
    const ds = new MemoryDataset({ namespace: 'app' });
    const fields = {
      title: { kind: 'scalar', type: 'string' },
      body: { kind: 'scalar', type: 'string', indexed: false },
      code: { kind: 'scalar', type: 'string', indexed: true }
    };
    await ds.write('TypeProposal', [
      row({ id: 'n', typeName: 'Note', fieldsJson: JSON.stringify(fields) })
    ]);
    const { engine } = await boot(ds);
    const replayed = engine.registryFor('app')?.get('Note')?.fields as Record<
      string,
      { indexed?: boolean }
    >;
    expect('indexed' in (replayed.title ?? {})).toBe(false);
    expect(replayed.body?.indexed).toBe(false);
    expect(replayed.code?.indexed).toBe(true);
  });
});

describe('removing a TypeProposal (#1792, #1954)', () => {
  const str = JSON.stringify({ t: { kind: 'scalar', type: 'string' } });
  const propose = ['read', 'mutate', 'substrate.propose'];

  async function seeded(withRows: boolean) {
    const ds = new MemoryDataset({ namespace: 'app' });
    await ds.write('TypeProposal', [row({ id: 'tp', typeName: 'Stored', fieldsJson: str })]);
    if (withRows) await ds.write('Stored', [{ id: 's1', t: 'x' }]);
    return { ds, ...(await boot(ds)) };
  }

  const removals: Array<[string, Record<string, unknown>]> = [
    ['app/deleteTypeProposal', { id: 'tp' }],
    ['app/updateTypeProposal', { id: 'tp', archived: true }],
    // Each changes what boot replays for the type (#1954).
    ['app/updateTypeProposal', { id: 'tp', applied: false }],
    ['app/updateTypeProposal', { id: 'tp', typeName: 'Empty' }],
    ['app/updateTypeProposal', { id: 'tp', fieldsJson: '{}' }],
    // Not on the benign list, so gated too.
    ['app/updateTypeProposal', { id: 'tp', supersededByCode: true }]
  ];

  it('of a type with storage needs the drop capability', async () => {
    for (const [key, params] of removals) {
      const { ds, engine } = await seeded(true);
      const denied = await engine.mutate({
        frame: { [key]: { params, fields: { id: true } } },
        ctx: ctx(propose)
      });
      expect(denied.errors?.[0]?.code).toBe('policy_denied');
      // An array takes the same guard.
      const batched = await engine.mutate({
        frame: { [key]: [{ params, fields: { id: true } }] },
        ctx: ctx(propose)
      });
      expect(batched.errors?.[0]?.code).toBe('policy_denied');
      const kept = (await ds.read('TypeProposal', { id: 'tp' })).rows[0];
      expect(kept).toMatchObject({
        archived: false,
        applied: true,
        typeName: 'Stored',
        fieldsJson: str
      });
      const allowed = await engine.mutate({
        frame: { [key]: { params, fields: { id: true } } },
        ctx: ctx([...propose, 'admin'])
      });
      expect(allowed.errors).toBeUndefined();
    }
  });

  it('by filter is refused, so it cannot route around the guard', async () => {
    const { engine } = await seeded(true);
    for (const [key, params] of [
      ['app/deleteManyTypeProposal', { where: { typeName: { eq: 'Stored' } } }],
      [
        'app/updateManyTypeProposal',
        { where: { typeName: { eq: 'Stored' } }, set: { archived: true } }
      ]
    ] as const) {
      const env = await engine.mutate({
        frame: { [key]: { params, fields: { count: true } } },
        ctx: ctx(propose)
      });
      expect(env.errors?.[0]).toBeDefined();
    }
  });

  it('of a type with no storage needs only the propose capability', async () => {
    for (const [key, params] of removals) {
      const { engine } = await seeded(false);
      const env = await engine.mutate({
        frame: { [key]: { params, fields: { id: true } } },
        ctx: ctx(propose)
      });
      expect(env.errors).toBeUndefined();
    }
  });

  it('updates touching only benign fields still need only the propose capability', async () => {
    const { engine } = await seeded(true);
    const env = await engine.mutate({
      frame: {
        'app/updateTypeProposal': {
          params: { id: 'tp', proposedReason: 'clarified', proposedBy: 'someone' },
          fields: { id: true }
        }
      },
      ctx: ctx(propose)
    });
    expect(env.errors).toBeUndefined();
  });

  it('checks the stored typeName, so a rename cannot point the check at an empty type', async () => {
    // 'Empty' has no rows; the proposal's stored type 'Stored' does.
    const { ds, engine } = await seeded(true);
    const env = await engine.mutate({
      frame: {
        'app/updateTypeProposal': { params: { id: 'tp', typeName: 'Empty' }, fields: { id: true } }
      },
      ctx: ctx(propose)
    });
    expect(env.errors?.[0]?.code).toBe('policy_denied');
    expect((await ds.read('TypeProposal', { id: 'tp' })).rows[0]?.typeName).toBe('Stored');
  });

  it('fails closed on a removal with no id or no dataset to check', async () => {
    const { ds, loaded } = await seeded(true);
    const registry = loaded.namespaces.get('app')?.registry;
    const call = (key: string, args: Partial<ResolverArgs>) =>
      registry
        ?.get(key)
        ?.resolver({ ...ctx(propose), namespace: 'app' } as RequestContext, args as ResolverArgs);
    await expect(
      call('updateTypeProposal', { params: { applied: false }, dataset: ds })
    ).rejects.toMatchObject({
      code: 'policy_denied'
    });
    await expect(call('deleteTypeProposal', { params: { id: 'tp' } })).rejects.toMatchObject({
      code: 'policy_denied'
    });
    await expect(
      call('updateTypeProposal', { params: { id: 'tp', archived: true } })
    ).rejects.toMatchObject({
      code: 'policy_denied'
    });
  });
});
