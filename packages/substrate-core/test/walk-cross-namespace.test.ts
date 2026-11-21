/**
 * Walks that cross namespaces through the engine. `ext` and `app` are memory
 * siblings of one root, `other` is a store of its own and `orders` is bridged;
 * both `ext` and `app` declare an `Invoice`. Each hop is checked in its own
 * namespace: the caller's read grant first, then the far type, the store, the
 * store's walks capability and the far type's policy. A namespace the caller
 * cannot read is refused the same way whatever is in it, before its dataset is
 * touched.
 */

import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { row } from '@mnmal-ai/substrate-policy';
import type {
  BridgeClient,
  BridgeRegistry,
  FieldDef,
  Identity,
  OrderedBy,
  PackEnvelope,
  Policy,
  ReadParams,
  ReadResult,
  RegistryEntryResolver,
  Row
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { Engine, MemoryEdgesStore, type NamespaceConfig, Registry } from '../src/index.js';

const num: FieldDef = { kind: 'scalar', type: 'number' };
const str: FieldDef = { kind: 'scalar', type: 'string' };
const ref = (ns: string, type: string): FieldDef => ({
  kind: 'crossRef',
  ns,
  type,
  onDelete: 'set_null'
});
const allow: Policy = () => ({ allow: true });
const meta = (at: string) => ({ createdAt: at, updatedAt: at, createdBy: null, updatedBy: null });
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads the dataset the engine hands it, lifting `_agg` and nested walks out as autoCRUD's list does. */
const listOf =
  (type: string): RegistryEntryResolver =>
  async (_ctx, args): Promise<ReadResult> => {
    const p = args.params ?? {};
    const read: ReadParams = {};
    if (p.where !== undefined) read.where = p.where as NonNullable<ReadParams['where']>;
    if (p.orderBy !== undefined) read.orderBy = p.orderBy as NonNullable<ReadParams['orderBy']>;
    if (p.aggregate !== undefined)
      read.aggregate = p.aggregate as NonNullable<ReadParams['aggregate']>;
    if (p.groupBy !== undefined) read.groupBy = p.groupBy as NonNullable<ReadParams['groupBy']>;
    const fields = (args.fields ?? {}) as Record<string, unknown>;
    if (fields._agg !== undefined) read.agg = fields._agg as NonNullable<ReadParams['agg']>;
    const nested = Object.entries(fields).filter(([, v]) => isObj(v) && Object.hasOwn(v, '_walk'));
    if (nested.length > 0)
      read.nested = Object.fromEntries(nested) as NonNullable<ReadParams['nested']>;
    if (args.dataset === undefined) throw new Error(`no dataset for ${type}`);
    return args.dataset.read(type, read);
  };

const ordersSchema = {
  orders: {
    schemaVersion: 'remote',
    types: { Order: { fields: { payment: ref('ext', 'Payment') } } },
    mutations: {}
  }
};
const bridgeClient: BridgeClient = {
  name: 'orders',
  baseUrl: 'http://peer.test',
  federatedSchema: async () => ordersSchema,
  query: async () => ({ schemaVersion: 'remote', data: {}, shapes: {} }),
  mutate: async () => ({ schemaVersion: 'remote', data: {}, shapes: {} }),
  readRow: async () => null,
  isReachable: () => true,
  dispose: () => {}
};
const bridges: BridgeRegistry = {
  has: (n) => n === 'orders',
  get: (n) => (n === 'orders' ? bridgeClient : undefined),
  isUnreachable: () => false,
  entries: () => [['orders', bridgeClient]]
};

interface BuildOptions {
  /** Policies by `<ns>/<Type>`. */
  policies?: Record<string, Policy>;
  /** Whether the `app` handle says it answers walks. */
  appWalks?: boolean;
}

async function build({ policies = {}, appWalks = true }: BuildOptions = {}) {
  const stored = new WeakSet<object>();
  const registries = { ext: new Registry(), app: new Registry(), other: new Registry() };
  const type = (
    ns: keyof typeof registries,
    name: string,
    fields: Record<string, FieldDef>,
    extra: { isStored?: boolean; orderedBy?: OrderedBy } = {}
  ) => {
    const isStored = extra.isStored ?? true;
    const resolver: RegistryEntryResolver = isStored ? listOf(name) : async () => [];
    if (isStored) stored.add(resolver);
    registries[ns].register(name, {
      fields,
      resolver,
      policy: policies[`${ns}/${name}`] ?? allow,
      ...(extra.orderedBy !== undefined ? { orderedBy: extra.orderedBy } : {})
    });
  };
  type(
    'ext',
    'Payment',
    {
      amount: num,
      invoice: ref('app', 'Invoice'),
      local: ref('ext', 'Invoice'),
      prev: ref('ext', 'Payment'),
      ghost: ref('app', 'Nope'),
      hit: ref('app', 'Hit'),
      lost: ref('nowhere', 'Thing'),
      far: ref('other', 'Ledger'),
      remote: ref('orders', 'Order')
    },
    { orderedBy: { amount: 'asc' } }
  );
  type('ext', 'Invoice', { number: str, total: num });
  type('app', 'Invoice', { number: str, total: num, lastPayment: ref('ext', 'Payment') });
  type('app', 'Hit', { score: num, payment: ref('ext', 'Payment') }, { isStored: false });
  type('other', 'Ledger', { payment: ref('ext', 'Payment') });
  const namespaces = new Map<string, NamespaceConfig>(
    Object.entries(registries).map(([ns, registry]) => [ns, { registry }])
  );
  const lookupFor = (ns: string) => (t: string, f: string) =>
    namespaces.get(ns)?.registry.get(t)?.fields[f];

  const ext = new MemoryDataset({
    namespace: 'ext',
    walkReference: true,
    fieldDefLookup: lookupFor('ext'),
    fieldDefLookupFor: lookupFor
  });
  const app = ext.forNamespace('app') as MemoryDataset;
  const other = new MemoryDataset({
    namespace: 'other',
    walkReference: true,
    fieldDefLookup: lookupFor('other')
  });
  // Every property the engine reads off the `app` handle, methods included.
  const touched: PropertyKey[] = [];
  const appSpy = new Proxy(app, {
    get(target, p) {
      touched.push(p);
      if (p === 'capabilities' && !appWalks) return { ...target.capabilities, walks: false };
      const v: unknown = Reflect.get(target, p, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    }
  });
  const datasets = new MemoryDatasetRegistry();
  datasets.set('ext', ext);
  datasets.set('app', appSpy);
  datasets.set('other', other);
  const engine = new Engine({
    namespaces,
    datasets,
    edges: new MemoryEdgesStore({ now: () => new Date('2026-11-20T00:00:00Z') }),
    sweepHooks: { bridges },
    isStoredEntry: (e) => stored.has(e.resolver)
  });
  await engine.refreshBridgeSchemas();

  await app.write('Invoice', [
    { id: 'i1', number: 'INV-1', total: 100 },
    { id: 'i2', number: 'INV-2', total: 50 }
  ] as never);
  await ext.write('Invoice', [{ id: 'x1', number: 'EXT-1', total: 1 }] as never);
  // createdAt desc reads p1 first; Payment's natural order (amount asc) reads p2 first.
  await ext.write('Payment', [
    { id: 'p1', amount: 30, invoice: 'i1', local: 'x1', _metadata: meta('2026-11-20T00:00:02Z') },
    { id: 'p2', amount: 20, invoice: 'i1', _metadata: meta('2026-11-20T00:00:01Z') }
  ] as never);
  touched.length = 0;
  return { engine, touched, registries, datasets };
}

const as = (grants: Record<string, string[]> | null) => ({
  identity: (grants === null ? null : { id: 'caller', kind: 'agent', grants }) as Identity | null
});
const reader = as({ '*': ['read'] });
const probe = as({ ext: ['read'] });

const DENIED = { code: 'policy_denied', message: 'this walk is not permitted' };
const rows = (env: PackEnvelope, key: string) => env.data[key] as Row[];

describe('the operator questions across ext/Payment and app/Invoice', () => {
  it('payments with their invoice number (nested out)', async () => {
    const { engine } = await build();
    const env = await engine.query({
      frame: {
        'ext/Payment': {
          params: { orderBy: [{ id: 'asc' }] },
          fields: { id: true, inv: { _walk: { out: 'invoice' }, fields: { number: true } } }
        }
      },
      ctx: reader
    });
    expect(env.errors).toBeUndefined();
    expect(rows(env, 'ext/Payment').map((r) => [r.id, r.inv])).toEqual([
      ['p1', [{ id: 'i1', number: 'INV-1' }]],
      ['p2', [{ id: 'i1', number: 'INV-1' }]]
    ]);
  });

  it('invoices with no payment (none + in)', async () => {
    const { engine } = await build();
    const env = await engine.query({
      frame: {
        'app/Invoice': {
          params: { where: { _walk: { in: 'ext/Payment.invoice', quantifier: 'none' } } },
          fields: { id: true }
        }
      },
      ctx: reader
    });
    expect(env.errors).toBeUndefined();
    expect(rows(env, 'app/Invoice').map((r) => r.id)).toEqual(['i2']);
  });

  it('total paid per invoice (_agg + in)', async () => {
    const { engine } = await build();
    const env = await engine.query({
      frame: {
        'app/Invoice': {
          params: { orderBy: [{ id: 'asc' }] },
          fields: { id: true, _agg: { paid: { in: 'ext/Payment.invoice', sum: 'amount' } } }
        }
      },
      ctx: reader
    });
    expect(env.errors).toBeUndefined();
    expect(rows(env, 'app/Invoice').map((r) => [r.id, r._agg])).toEqual([
      ['i1', { paid: 50 }],
      ['i2', { paid: null }]
    ]);
  });

  it('a valid crossing walk resolves through the policy gate, never "does not resolve"', async () => {
    const { engine } = await build();
    for (const where of [
      { _walk: { out: 'invoice', where: { number: { eq: 'INV-1' } } } },
      { _walk: { out: 'prev', where: { _walk: { out: 'invoice' } } } },
      { _agg: { out: 'invoice', count: true }, gte: 1 }
    ]) {
      const env = await engine.query({
        frame: { 'ext/Payment': { params: { where }, fields: { id: true } } },
        ctx: reader
      });
      expect(JSON.stringify(env.errors ?? [])).not.toContain('does not resolve');
      expect(env.errors).toBeUndefined();
    }
  });
});

describe('a namespace the caller cannot read', () => {
  const targets: Array<Record<string, unknown>> = [
    { in: 'app/Invoice.lastPayment' }, // an existing type and field
    { in: 'app/Nope.lastPayment' }, // a missing type
    { in: 'app/Invoice.nope' }, // a missing field
    { in: 'app/Hit.payment' }, // a virtual type
    { in: 'other/Ledger.payment' }, // a namespace on another store
    { in: 'orders/Order.payment' }, // a bridged namespace
    { in: 'nowhere/Thing.payment' }, // a namespace that does not exist
    { out: 'invoice' },
    { out: 'ghost' },
    { out: 'hit' },
    { out: 'far' },
    { out: 'remote' },
    { out: 'lost' }
  ];
  const forms: Array<[string, (t: Record<string, unknown>) => Record<string, unknown>, string[]]> =
    [
      ['where', (t) => ({ params: { where: { _walk: t } } }), ['where', '_walk']],
      [
        'nested',
        (t) => ({ fields: { id: true, x: { _walk: t, fields: { id: true } } } }),
        ['fields', 'x', '_walk']
      ],
      [
        'where _agg',
        (t) => ({ params: { where: { _agg: { ...t, count: true }, gte: 1 } } }),
        ['where', '_agg']
      ],
      [
        'fields _agg',
        (t) => ({ fields: { id: true, _agg: { n: { ...t, count: true } } } }),
        ['fields', '_agg', 'n']
      ],
      [
        'as',
        (t) => ({
          params: {
            where: {
              AND: [{ _walk: { as: 'I', ...t } }, { amount: { gte: { $ref: 'I.total' } } }]
            }
          }
        }),
        ['where', 'AND', '0', '_walk']
      ],
      [
        'inside a walk',
        (t) => ({ params: { where: { _walk: { out: 'prev', where: { _walk: t } } } } }),
        ['where', '_walk', 'where', '_walk']
      ]
    ];

  it('gets one refusal for every target and form, and its dataset is never touched', async () => {
    const { engine, touched } = await build();
    for (const [form, frameOf, path] of forms) {
      const seen = new Set<string>();
      for (const t of targets) {
        const env = await engine.query({
          frame: { 'ext/Payment': { fields: { id: true }, ...frameOf(t) } },
          ctx: probe
        });
        expect(env.data, `${form} ${JSON.stringify(t)}`).not.toHaveProperty('ext/Payment');
        seen.add(JSON.stringify([env.errors, env._diagnostics ?? null]));
      }
      expect(seen.size, form).toBe(1);
      expect(JSON.parse([...seen][0] as string), form).toEqual([
        [{ ...DENIED, path: ['ext/Payment', ...path] }],
        null
      ]);
    }
    expect(touched).toEqual([]);
  });

  it('a reader of every namespace does touch it (the spy works)', async () => {
    const { engine, touched } = await build();
    await engine.query({
      frame: { 'ext/Payment': { params: { where: { _walk: { out: 'invoice' } } }, fields: {} } },
      ctx: reader
    });
    expect(touched.length).toBeGreaterThan(0);
  });

  it("'*' grants read everywhere; an explicit entry beats '*'", async () => {
    const { engine } = await build();
    const frame = {
      'ext/Payment': { params: { where: { _walk: { out: 'invoice' } } }, fields: { id: true } }
    };
    const ok = await engine.query({ frame, ctx: reader });
    expect(ok.errors).toBeUndefined();
    expect(rows(ok, 'ext/Payment').map((r) => r.id)).toEqual(['p2', 'p1']);
    const env = await engine.query({ frame, ctx: as({ app: ['mutate'], '*': ['read'] }) });
    expect(env.errors).toEqual([{ ...DENIED, path: ['ext/Payment', 'where', '_walk'] }]);
  });
});

describe('after the grant passes', () => {
  it('another store and a bridged namespace are refused walk_cross_store', async () => {
    const { engine } = await build();
    for (const ctx of [reader, as(null)]) {
      for (const walk of [
        { out: 'far' },
        { in: 'other/Ledger.payment' },
        { out: 'remote' },
        { in: 'orders/Order.payment' }
      ]) {
        const env = await engine.query({
          frame: { 'ext/Payment': { params: { where: { _walk: walk } }, fields: { id: true } } },
          ctx
        });
        expect(env.errors, JSON.stringify(walk)).toEqual([
          expect.objectContaining({
            code: 'walk_cross_store',
            path: ['ext/Payment', 'where', '_walk', 'out' in walk ? 'out' : 'in']
          })
        ]);
      }
    }
  });

  it('a disposed sibling is not walkable, though its walk group still holds it', async () => {
    const { engine, datasets } = await build();
    datasets.dispose('app');
    const env = await engine.query({
      frame: {
        'ext/Payment': { params: { where: { _walk: { out: 'invoice' } } }, fields: { id: true } }
      },
      ctx: reader
    });
    expect(env.data).not.toHaveProperty('ext/Payment');
    expect(env.errors?.map((e) => e.code)).toEqual(['walk_cross_store']);
  });

  it('a virtual far type is refused walk_unknown_ref', async () => {
    const { engine } = await build();
    for (const walk of [{ out: 'hit' }, { in: 'app/Hit.payment' }]) {
      const env = await engine.query({
        frame: { 'ext/Payment': { params: { where: { _walk: walk } }, fields: { id: true } } },
        ctx: reader
      });
      expect(env.errors?.[0]?.code).toBe('walk_unknown_ref');
    }
  });

  it('a far store that does not answer walks is refused at the hop', async () => {
    const { engine } = await build({ appWalks: false });
    const env = await engine.query({
      frame: {
        'ext/Payment': { params: { where: { _walk: { out: 'invoice' } } }, fields: { id: true } }
      },
      ctx: reader
    });
    expect(env.errors).toEqual([
      expect.objectContaining({
        code: 'walks_unsupported_store',
        path: ['ext/Payment', 'where', '_walk']
      })
    ]);
  });

  it('a far-type policy deny is policy_denied at the hop path', async () => {
    const { engine } = await build({
      policies: { 'app/Invoice': () => ({ allow: false, reason: 'no invoices' }) }
    });
    const env = await engine.query({
      frame: {
        'ext/Payment': {
          fields: { id: true, inv: { _walk: { out: 'invoice' }, fields: { number: true } } }
        }
      },
      ctx: reader
    });
    expect(env.errors).toEqual([
      expect.objectContaining({
        code: 'policy_denied',
        message: 'no invoices',
        path: ['ext/Payment', 'fields', 'inv', '_walk']
      })
    ]);
  });

  it('a far row policy is row_policy_blocks_walk', async () => {
    const { engine } = await build({ policies: { 'app/Invoice': row(() => true) } });
    const env = await engine.query({
      frame: {
        'ext/Payment': { params: { where: { _walk: { out: 'invoice' } } }, fields: { id: true } }
      },
      ctx: reader
    });
    expect(env.errors).toEqual([
      expect.objectContaining({
        code: 'row_policy_blocks_walk',
        path: ['ext/Payment', 'where', '_walk']
      })
    ]);
  });
});

describe('a walked group key goes through the walk gate', () => {
  const grouped = (key = 'invoice.number') => ({
    'ext/Payment': {
      params: { aggregate: { n: { count: true }, paid: { sum: 'amount' } }, groupBy: { g: key } },
      fields: { id: true }
    }
  });
  const at = ['ext/Payment', 'groupBy', 'g'];

  it('groups by a field of the row in another namespace, under the federated schemaVersion', async () => {
    const { engine, registries } = await build();
    const before = await engine.query({ frame: grouped(), ctx: reader });
    expect(before.errors).toBeUndefined();
    expect(before.data['ext/Payment']).toEqual({ groups: [{ g: 'INV-1', n: 2, paid: 50 }] });
    registries.app.register('Credit', { fields: { amount: num }, resolver: async () => [] });
    const after = await engine.query({ frame: grouped(), ctx: reader });
    expect(after.schemaVersion).not.toBe(before.schemaVersion);
  });

  it('is refused like an out walk into a namespace the caller cannot read, untouched', async () => {
    const { engine, touched } = await build();
    for (const key of ['invoice.number', 'ghost.x', 'hit.score', 'far.payment', 'lost.x']) {
      const env = await engine.query({ frame: grouped(key), ctx: probe });
      expect(env.data, key).not.toHaveProperty('ext/Payment');
      expect(env.errors, key).toEqual([{ ...DENIED, path: at }]);
    }
    expect(touched).toEqual([]);
  });

  it('a far store without walks, a far policy deny and a far row policy refuse at the key', async () => {
    const cases: Array<[BuildOptions, Record<string, unknown>]> = [
      [{ appWalks: false }, { code: 'walks_unsupported_store' }],
      [
        { policies: { 'app/Invoice': () => ({ allow: false, reason: 'no invoices' }) } },
        { code: 'policy_denied', message: 'no invoices' }
      ],
      [{ policies: { 'app/Invoice': row(() => true) } }, { code: 'row_policy_blocks_walk' }]
    ];
    for (const [options, error] of cases) {
      const { engine } = await build(options);
      const env = await engine.query({ frame: grouped(), ctx: reader });
      expect(env.data).not.toHaveProperty('ext/Payment');
      expect(env.errors).toEqual([expect.objectContaining({ ...error, path: at })]);
    }
  });
});

describe('each far type in its own namespace (app/Invoice and ext/Invoice share a name)', () => {
  const deny: Policy = () => ({ allow: false, reason: 'denied here' });
  const walkTo = (...outs: string[]) => ({
    'ext/Payment': {
      params: { where: { AND: outs.map((out) => ({ _walk: { out } })) } },
      fields: { id: true }
    }
  });

  it('evaluates each walked type in its own namespace', async () => {
    const extDenied = await build({ policies: { 'ext/Invoice': deny } });
    const ok = await extDenied.engine.query({ frame: walkTo('invoice'), ctx: reader });
    expect(ok.errors).toBeUndefined();
    const no = await extDenied.engine.query({ frame: walkTo('local'), ctx: reader });
    expect(no.errors?.[0]).toMatchObject({ code: 'policy_denied', message: 'denied here' });

    const appDenied = await build({ policies: { 'app/Invoice': deny } });
    const local = await appDenied.engine.query({ frame: walkTo('local'), ctx: reader });
    expect(local.errors).toBeUndefined();
    const both = await appDenied.engine.query({ frame: walkTo('local', 'invoice'), ctx: reader });
    expect(both.errors).toEqual([
      expect.objectContaining({
        code: 'policy_denied',
        path: ['ext/Payment', 'where', 'AND', '1', '_walk']
      })
    ]);
  });

  it("a nested walk list reads in its far type's natural order", async () => {
    const { engine } = await build();
    const env = await engine.query({
      frame: {
        'app/Invoice': {
          params: { where: { id: { eq: 'i1' } } },
          fields: { id: true, pays: { _walk: { in: 'ext/Payment.invoice' }, fields: { id: true } } }
        }
      },
      ctx: reader
    });
    expect(env.errors).toBeUndefined();
    expect(rows(env, 'app/Invoice')[0]?.pays).toEqual([{ id: 'p2' }, { id: 'p1' }]);
  });

  it('a nested selection reports unknown fields of the far type, not the same-named seed one', async () => {
    const { engine } = await build();
    const env = await engine.query({
      frame: {
        'ext/Payment': {
          fields: {
            id: true,
            inv: { _walk: { out: 'invoice' }, fields: { lastPayment: true, nope: true } }
          }
        }
      },
      ctx: reader
    });
    expect(env._diagnostics?.['ext/Payment']).toEqual({ unknownProjectionFields: ['inv.nope'] });
  });

  it('a far where may filter by metadata names, rewritten on the far type', async () => {
    const { engine } = await build();
    const env = await engine.query({
      frame: {
        'ext/Payment': {
          params: { where: { _walk: { out: 'invoice', where: { createdBy: { eq: null } } } } },
          fields: { id: true }
        }
      },
      ctx: reader
    });
    expect(env.errors).toBeUndefined();
    expect(rows(env, 'ext/Payment').map((r) => r.id)).toEqual(['p2', 'p1']);
  });
});

describe('schema and envelope', () => {
  it('a crossing frame carries a schemaVersion that moves with the far namespace', async () => {
    const { engine, registries } = await build();
    const crossing = {
      'ext/Payment': {
        fields: { id: true, inv: { _walk: { out: 'invoice' }, fields: { number: true } } }
      }
    };
    const plain = { 'ext/Payment': { fields: { id: true } } };
    const before = await engine.query({ frame: crossing, ctx: reader });
    const plainBefore = await engine.query({ frame: plain, ctx: reader });
    expect(before.errors).toBeUndefined();
    registries.app.register('Credit', { fields: { amount: num }, resolver: async () => [] });
    const after = await engine.query({ frame: crossing, ctx: reader });
    const plainAfter = await engine.query({ frame: plain, ctx: reader });
    expect(after.schemaVersion).not.toBe(before.schemaVersion);
    expect(plainAfter.schemaVersion).toBe(plainBefore.schemaVersion);
    expect(plainAfter.schemaVersion).toBe(engine.schemaFor('ext').schemaVersion);
  });

  it("app/Invoice's inboundRefs list only same-namespace refs", async () => {
    const { engine } = await build();
    expect(engine.schemaFor('app').types.Invoice?.inboundRefs).toBeUndefined();
    expect(engine.schemaFor('ext').types.Invoice?.inboundRefs).toEqual([
      { type: 'Payment', field: 'local' }
    ]);
  });
});
