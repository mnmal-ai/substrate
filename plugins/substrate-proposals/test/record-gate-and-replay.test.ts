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

  it('a fresh applied proposal for a stored name needs the drop capability (#1956)', async () => {
    let n = 0;
    const fresh = (typeName: string, applied: boolean) => ({
      'app/createTypeProposal': {
        params: row({ id: `fresh-${++n}`, typeName, fieldsJson: str, applied }),
        fields: { id: true }
      }
    });
    const { engine } = await seeded(true);
    const denied = await engine.mutate({ frame: fresh('Stored', true), ctx: ctx(propose) });
    expect(denied.errors?.[0]?.code).toBe('policy_denied');
    // Unapplied, or for a name with no rows, stays propose-only.
    expect(
      (await engine.mutate({ frame: fresh('Stored', false), ctx: ctx(propose) })).errors
    ).toBeUndefined();
    expect(
      (await engine.mutate({ frame: fresh('Fresh', true), ctx: ctx(propose) })).errors
    ).toBeUndefined();
    expect(
      (await engine.mutate({ frame: fresh('Stored', true), ctx: ctx([...propose, 'admin']) }))
        .errors
    ).toBeUndefined();
  });

  it('a rename onto a defined name needs the drop capability, whatever the stored name holds', async () => {
    // The stored type 'Empty' has no rows; the target 'Stored' does, or has a live proposal.
    const { ds, engine } = await seeded(true);
    await ds.write('TypeProposal', [row({ id: 'te', typeName: 'Empty', fieldsJson: str })]);
    const onto = (typeName: string) =>
      engine.mutate({
        frame: {
          'app/updateTypeProposal': { params: { id: 'te', typeName }, fields: { id: true } }
        },
        ctx: ctx(propose)
      });
    expect((await onto('Stored')).errors?.[0]?.code).toBe('policy_denied');
    await ds.write('TypeProposal', [row({ id: 'tl', typeName: 'Live', fieldsJson: str })]);
    expect((await onto('Live')).errors?.[0]?.code).toBe('policy_denied');
    expect((await ds.read('TypeProposal', { id: 'te' })).rows[0]?.typeName).toBe('Empty');
    expect((await onto('Free')).errors).toBeUndefined();
  });

  it('a second applied proposal for a name with a live one needs the drop capability', async () => {
    const { ds, engine } = await seeded(false);
    // 'Stored' has no rows here, but proposal 'tp' already defines it.
    expect((await ds.read('Stored', {})).rows).toEqual([]);
    const env = await engine.mutate({
      frame: {
        'app/createTypeProposal': {
          params: row({ id: 'dup', typeName: 'Stored', fieldsJson: '{}', applied: true }),
          fields: { id: true }
        }
      },
      ctx: ctx(propose)
    });
    expect(env.errors?.[0]?.code).toBe('policy_denied');
  });

  it('applying an unapplied proposal for a name with a live one needs the drop capability', async () => {
    const { ds, engine } = await seeded(false);
    await ds.write('TypeProposal', [
      row({ id: 'idle', typeName: 'Stored', fieldsJson: '{}', applied: false })
    ]);
    const apply = (params: Record<string, unknown>) =>
      engine.mutate({
        frame: {
          'app/updateTypeProposal': { params: { id: 'idle', ...params }, fields: { id: true } }
        },
        ctx: ctx(propose)
      });
    expect((await apply({ applied: true })).errors?.[0]?.code).toBe('policy_denied');
    // appliedAt is not benign: it is no lever on replay order, but it is gated all the same.
    expect((await apply({ appliedAt: T0 })).errors).toBeUndefined();
    expect((await ds.read('TypeProposal', { id: 'idle' })).rows[0]?.applied).toBe(false);
  });

  it('boot replay registers the oldest applied definition of a name', async () => {
    const ds = new MemoryDataset({ namespace: 'app' });
    const later = new Date(T0.getTime() + 60_000);
    // Natural order (createdAt desc) would read the newer one first.
    await ds.write('TypeProposal', [
      row({ id: 'old', typeName: 'Twin', fieldsJson: str, _metadata: { createdAt: T0 } })
    ]);
    await ds.write('TypeProposal', [
      row({
        id: 'new',
        typeName: 'Twin',
        fieldsJson: JSON.stringify({ u: { kind: 'scalar', type: 'string' } }),
        // A backdated appliedAt is no lever: replay orders by the server-set createdAt.
        appliedAt: new Date(0),
        _metadata: { createdAt: later }
      })
    ]);
    const { loaded } = await boot(ds);
    const fields = loaded.namespaces.get('app')?.registry.get('Twin')?.fields;
    expect(fields).toHaveProperty('t');
    expect(fields).not.toHaveProperty('u');
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

  it('a return to live, or a rename onto a defined name, needs the drop capability however it is reached', async () => {
    // 'Stored' has rows, 'Free' a live proposal 'tl'; the rest are archived.
    const ds = new MemoryDataset({ namespace: 'app' });
    await ds.write('TypeProposal', [
      row({ id: 'ta', typeName: 'Stored', fieldsJson: str, archived: true }),
      row({ id: 'te', typeName: 'Empty', fieldsJson: str, archived: true }),
      row({ id: 'tl', typeName: 'Free', fieldsJson: str }),
      row({ id: 'tf', typeName: 'Free', fieldsJson: str, archived: true })
    ]);
    await ds.write('Stored', [{ id: 's1', t: 'x' }]);
    const { engine } = await boot(ds);
    const update = (params: Record<string, unknown>, caps = propose) =>
      engine.mutate({
        frame: { 'app/updateTypeProposal': { params, fields: { id: true } } },
        ctx: ctx(caps)
      });
    const refused = [
      { id: 'ta', archived: false },
      { id: 'tf', archived: false },
      { id: 'te', typeName: 'Stored', archived: false },
      { id: 'te', typeName: 'Free', archived: false }
    ];
    for (const params of refused) {
      expect((await update(params)).errors?.[0]?.code, JSON.stringify(params)).toBe(
        'policy_denied'
      );
    }
    // A rename while archived leaves nothing live; the return to live is checked under it.
    expect((await update({ id: 'te', typeName: 'Stored' })).errors).toBeUndefined();
    expect((await update({ id: 'te', archived: false })).errors?.[0]?.code).toBe('policy_denied');
    const archived = (await ds.read('TypeProposal', {})).rows.filter((r) => r.id !== 'tl');
    expect(archived.every((r) => r.archived === true)).toBe(true);
    for (const params of refused.slice(0, 2)) {
      expect((await update(params, [...propose, 'admin'])).errors, JSON.stringify(params)).toBe(
        undefined
      );
    }
  });

  it('finds the proposal as the write does, so every form of its id meets the guard', async () => {
    const ds = new MemoryDataset({ namespace: 'app' });
    const { engine } = await boot(ds);
    const proposed = await engine.mutate({
      frame: {
        'app/propose_type': {
          params: { typeName: 'Kept', fields: { t: { kind: 'scalar', type: 'string' } } },
          fields: { id: true }
        }
      },
      ctx: ctx(propose)
    });
    expect(proposed.errors).toBeUndefined();
    const stored = await engine.mutate({
      frame: { 'app/createKept': { params: { t: 'x' }, fields: { id: true } } },
      ctx: ctx(propose)
    });
    expect(stored.errors).toBeUndefined();
    const id = (proposed.data['app/propose_type'] as { id: string }).id;
    const shortId = (await ds.read('TypeProposal', { id })).rows[0]?.shortId as number;
    for (const form of [id, shortId, String(shortId)]) {
      for (const [key, params] of [
        ['app/updateTypeProposal', { id: form, archived: true }],
        ['app/deleteTypeProposal', { id: form }]
      ] as const) {
        const env = await engine.mutate({
          frame: { [key]: { params, fields: { id: true } } },
          ctx: ctx(propose)
        });
        expect(env.errors?.[0]?.code, `${key} ${typeof form} ${form}`).toBe('policy_denied');
      }
    }
    expect((await ds.read('TypeProposal', { id })).rows[0]).toMatchObject({ archived: false });
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

describe('writing a FieldProposal', () => {
  const str = JSON.stringify({ t: { kind: 'scalar', type: 'string' } });
  const S = JSON.stringify({ kind: 'scalar', type: 'string' });
  const N = JSON.stringify({ kind: 'scalar', type: 'number' });
  const propose = ['read', 'mutate', 'substrate.propose'];
  const admin = [...propose, 'admin'];

  /**
   * 'Stored' has rows (unless `withRows` is false) and 'Empty' none. Live A
   * defines Stored.extra and P Empty.extra; B, archived, defined Stored.old;
   * U, unapplied, proposes Stored.idle. `fp`, a live Stored.more, is created
   * through the engine so it has a short id.
   */
  async function seeded(withRows = true) {
    const ds = new MemoryDataset({ namespace: 'app' });
    await ds.write('TypeProposal', [
      row({ id: 'tpS', typeName: 'Stored', fieldsJson: str }),
      row({ id: 'tpE', typeName: 'Empty', fieldsJson: str })
    ]);
    if (withRows) await ds.write('Stored', [{ id: 's1', t: 'x' }]);
    await ds.write('FieldProposal', [
      row({ id: 'A', targetType: 'Stored', fieldName: 'extra', fieldSpecJson: S }),
      row({ id: 'P', targetType: 'Empty', fieldName: 'extra', fieldSpecJson: S }),
      row({ id: 'B', targetType: 'Stored', fieldName: 'old', fieldSpecJson: S, archived: true }),
      row({ id: 'U', targetType: 'Stored', fieldName: 'idle', fieldSpecJson: S, applied: false })
    ]);
    const booted = await boot(ds);
    const created = await booted.engine.mutate({
      frame: {
        'app/createFieldProposal': {
          params: row({ id: 'fp', targetType: 'Stored', fieldName: 'more', fieldSpecJson: S }),
          fields: { id: true }
        }
      },
      ctx: ctx(admin)
    });
    expect(created.errors).toBeUndefined();
    const shortId = (await ds.read('FieldProposal', { id: 'fp' })).rows[0]?.shortId as number;
    return { ds, shortId, ...booted };
  }

  const write = (engine: Engine, key: string, params: Record<string, unknown>, caps: string[]) =>
    engine.mutate({ frame: { [key]: { params, fields: { id: true } } }, ctx: ctx(caps) });
  const writeArray = (
    engine: Engine,
    key: string,
    params: Record<string, unknown>,
    caps: string[]
  ) => engine.mutate({ frame: { [key]: [{ params, fields: { id: true } }] }, ctx: ctx(caps) });
  const proposals = async (ds: MemoryDataset) =>
    (await ds.read('FieldProposal', {})).rows.map(({ _metadata, ...r }) => r);

  /** Changes to the live `fp` (Stored.more): each drops, redefines, reorders or rewrites it. */
  const changes: Array<[string, Record<string, unknown>]> = [
    ['app/deleteFieldProposal', {}],
    ['app/updateFieldProposal', { archived: true }],
    ['app/updateFieldProposal', { applied: false }],
    ['app/updateFieldProposal', { supersededByCode: true }],
    ['app/updateFieldProposal', { fieldName: 'renamed' }],
    ['app/updateFieldProposal', { targetType: 'Empty' }],
    ['app/updateFieldProposal', { fieldSpecJson: N }],
    ['app/updateFieldProposal', { valueMapJson: '{"x":"y"}' }],
    ['app/updateFieldProposal', { appliedAt: T1 }]
  ];

  it('to change a live proposal of a field on a type with stored rows needs the drop capability, by any form of its id', async () => {
    for (const [key, change] of changes) {
      const { ds, engine, shortId } = await seeded();
      const before = await proposals(ds);
      for (const id of ['fp', shortId, String(shortId)]) {
        const label = `${key} ${JSON.stringify({ id, ...change })}`;
        const single = await write(engine, key, { id, ...change }, propose);
        expect(single.errors?.[0]?.code, label).toBe('policy_denied');
        const array = await writeArray(engine, key, { id, ...change }, propose);
        expect(array.errors?.[0]?.code, `[${label}]`).toBe('policy_denied');
      }
      expect(await proposals(ds), key).toEqual(before);
      expect(
        (await write(engine, key, { id: 'fp', ...change }, admin)).errors,
        key
      ).toBeUndefined();
    }
  });

  /** Writes that leave a proposal live, or create a live one, on 'Stored'. */
  const intoStored: Array<[string, string, Record<string, unknown>]> = [
    [
      'retarget',
      'app/updateFieldProposal',
      { id: 'P', targetType: 'Stored', fieldSpecJson: N, valueMapJson: '{}' }
    ],
    [
      'resurrect',
      'app/updateFieldProposal',
      {
        id: 'B',
        fieldName: 'extra',
        fieldSpecJson: N,
        valueMapJson: '{}',
        archived: false,
        appliedAt: T1
      }
    ],
    ['bare unarchive', 'app/updateFieldProposal', { id: 'B', archived: false }],
    ['apply', 'app/updateFieldProposal', { id: 'U', applied: true }],
    [
      'create',
      'app/createFieldProposal',
      row({ id: 'C', targetType: 'Stored', fieldName: 'fresh', fieldSpecJson: S })
    ],
    [
      'create over a live field',
      'app/createFieldProposal',
      row({ id: 'D', targetType: 'Stored', fieldName: 'extra', fieldSpecJson: N })
    ]
  ];

  it('to leave live, or create live, a proposal on a type with stored rows needs the drop capability', async () => {
    for (const [label, key, params] of intoStored) {
      const { ds, engine } = await seeded();
      const before = await proposals(ds);
      expect((await write(engine, key, params, propose)).errors?.[0]?.code, label).toBe(
        'policy_denied'
      );
      expect((await writeArray(engine, key, params, propose)).errors?.[0]?.code, label).toBe(
        'policy_denied'
      );
      expect(await proposals(ds), label).toEqual(before);
      expect((await write(engine, key, params, admin)).errors, label).toBeUndefined();
    }
  });

  it('needs only the propose capability where no type it affects has stored rows', async () => {
    for (const [key, change] of changes) {
      const { engine } = await seeded(false);
      expect(
        (await write(engine, key, { id: 'fp', ...change }, propose)).errors,
        key
      ).toBeUndefined();
    }
    // Each lands on a field no other live proposal defines.
    for (const [label, key, params] of intoStored.filter(([l]) =>
      ['bare unarchive', 'apply', 'create'].includes(l)
    )) {
      const { engine } = await seeded(false);
      expect((await write(engine, key, params, propose)).errors, label).toBeUndefined();
    }
  });

  it('passes a change boot replay never reads, and any change to a proposal that stays not live', async () => {
    const { engine } = await seeded();
    for (const [key, params] of [
      ['app/updateFieldProposal', { id: 'A', proposedReason: 'clarified', proposedBy: 'someone' }],
      ['app/updateFieldProposal', { id: 'U', fieldSpecJson: N, valueMapJson: '{}' }],
      ['app/updateFieldProposal', { id: 'B', targetType: 'Empty' }],
      ['app/updateFieldProposal', { id: 'U', archived: true }],
      ['app/deleteFieldProposal', { id: 'B' }]
    ] as const) {
      expect((await write(engine, key, params, propose)).errors, JSON.stringify(params)).toBe(
        undefined
      );
    }
  });

  it('lets propose_field write its own proposals on a type with stored rows', async () => {
    const { ds, engine } = await seeded();
    const env = await engine.mutate({
      frame: {
        'app/propose_field': {
          params: {
            targetType: 'Stored',
            fieldName: 'added',
            fieldSpec: { kind: 'scalar', type: 'string', nullable: true }
          },
          fields: { id: true }
        }
      },
      ctx: ctx(propose)
    });
    expect(env.errors).toBeUndefined();
    const where = { fieldName: { eq: 'added' } };
    expect((await ds.read('FieldProposal', { where })).rows[0]).toMatchObject({ applied: true });
  });

  it('by filter is refused, so it cannot route around the guard', async () => {
    const { ds, engine } = await seeded();
    for (const [key, params] of [
      ['app/deleteManyFieldProposal', { where: { targetType: { eq: 'Stored' } } }],
      [
        'app/updateManyFieldProposal',
        { where: { targetType: { eq: 'Stored' } }, set: { archived: true } }
      ]
    ] as const) {
      const env = await engine.mutate({
        frame: { [key]: { params, fields: { count: true } } },
        ctx: ctx(admin)
      });
      expect(env.errors?.[0], key).toBeDefined();
    }
    expect((await ds.read('FieldProposal', { id: 'fp' })).rows[0]).toMatchObject({
      archived: false
    });
  });

  it('fails closed on a change whose proposal cannot be loaded', async () => {
    const { engine } = await seeded();
    for (const [key, params] of [
      ['app/deleteFieldProposal', { id: 'missing' }],
      ['app/updateFieldProposal', { id: 'missing', archived: true }]
    ] as const) {
      expect((await write(engine, key, params, propose)).errors?.[0]?.code, key).toBe(
        'policy_denied'
      );
    }
  });
});
