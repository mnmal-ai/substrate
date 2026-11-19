/**
 * A proposed type may reference a type defined in code: `ext` is owned by the
 * proposals plugin, `app` is a code-defined namespace beside it.
 */

import { Engine, loadPlugins, MemoryEdgesStore, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import type {
  CoordinatorPlugin,
  Dataset,
  Identity,
  PackEnvelope,
  RequestContext
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { CONTROL_NAMESPACE } from '../src/control-plane.js';
import type { CrossRefSpec, FieldSpecJson } from '../src/field-spec-json.js';
import { createNoopPubSub, createProposalsPlugin } from '../src/index.js';

const T0 = new Date('2026-11-19T00:00:00Z');

/**
 * Boot over `ext` (seeded or empty). Every store answers walks, so walk
 * refusals come from the grammar, not the store. `virt/Hit` is a virtual
 * type: its namespace has a dataset, but autoCRUD stores none of its rows.
 */
async function boot(ext = new MemoryDataset({ namespace: 'ext', walkReference: true })) {
  // As compose builds it: any namespace asked for gets a dataset, a virtual one too.
  const datasets = new MemoryDatasetRegistry({
    factory: (ns: string) => new MemoryDataset({ namespace: ns, walkReference: true })
  });
  datasets.set('ext', ext);
  for (const ns of [CONTROL_NAMESPACE, 'app']) {
    datasets.set(ns, new MemoryDataset({ namespace: ns, walkReference: true }));
  }
  const datasetFor = (ns: string): Dataset | undefined => datasets.get(ns);
  const app: CoordinatorPlugin = {
    name: 'app',
    contractVersion: '>=1.0.0-alpha.0 <2.0.0',
    namespaces: [defineNamespace('app', { Invoice: { fields: { number: field.string() } } })]
  };
  const proposals = createProposalsPlugin({ ownedNamespaces: ['ext'], pubsub: createNoopPubSub() });
  const edges = new MemoryEdgesStore({ now: () => T0 });
  const loaded = await loadPlugins({ plugins: [proposals, app], datasetFor, edges });
  const virt = new Registry();
  virt.register('Hit', { resolver: async () => [] });
  const namespaces = new Map([...loaded.namespaces, ['virt', { registry: virt }]]);
  const engine = new Engine({ namespaces, datasets, edges });
  await loaded.runOnStart(engine);
  return engine;
}

function as(grants: Record<string, string[]>): Partial<RequestContext> {
  return { identity: { id: 'agent', tokenId: 'agent', grants }, now: T0, headers: {}, meta: {} };
}
const PROPOSER = as({ '*': ['read', 'mutate', 'substrate.propose'] });
const EXT_ONLY = { ext: ['read', 'mutate', 'substrate.propose'] };

const ref = (over: Partial<CrossRefSpec> = {}): CrossRefSpec => ({
  kind: 'crossRef',
  ns: 'app',
  type: 'Invoice',
  ...over
});

function proposeType(
  engine: Engine,
  typeName: string,
  fields: Record<string, FieldSpecJson>,
  ctx = PROPOSER
): Promise<PackEnvelope> {
  return engine.mutate({
    frame: { 'ext/propose_type': { params: { typeName, fields }, fields: { id: true } } },
    ctx
  });
}

function proposeField(
  engine: Engine,
  fieldName: string,
  fieldSpec: FieldSpecJson,
  ctx = PROPOSER
): Promise<PackEnvelope> {
  return engine.mutate({
    frame: {
      'ext/propose_field': {
        params: { targetType: 'Order', fieldName, fieldSpec },
        fields: { id: true }
      }
    },
    ctx
  });
}

/** The single refusal in `env`, as code and message. */
function refusal(env: PackEnvelope): { code: unknown; message: unknown } {
  expect(env.errors).toHaveLength(1);
  return { code: env.errors?.[0]?.code, message: env.errors?.[0]?.message };
}

const amount: FieldSpecJson = { kind: 'scalar', type: 'number' };

describe('a proposed reference to a code-defined type', () => {
  it('accepts a reference to a code-defined type', async () => {
    const engine = await boot();
    expect(
      (await proposeType(engine, 'Payment', { amount, invoice: ref() })).errors
    ).toBeUndefined();
    expect(engine.registryFor('ext')?.get('Payment')?.fields.invoice).toMatchObject({
      kind: 'crossRef',
      ns: 'app',
      type: 'Invoice',
      onDelete: 'set_null'
    });
    for (const onDelete of ['cascade', 'orphan'] as const) {
      const typeName = `Payment_${onDelete}`;
      const env = await proposeType(engine, typeName, { amount, invoice: ref({ onDelete }) });
      expect(env.errors).toBeUndefined();
      expect(engine.registryFor('ext')?.get(typeName)?.fields.invoice).toMatchObject({ onDelete });
    }
  });

  it('refuses restrict on a non-owned target', async () => {
    const engine = await boot();
    const env = await proposeType(engine, 'Payment', { invoice: ref({ onDelete: 'restrict' }) });
    const { code, message } = refusal(env);
    expect(code).toBe('invalid_field_spec');
    expect(message).toContain("'restrict' is not allowed on a reference to 'app/Invoice'");
    expect(message).toContain("'invoice'");
    expect(engine.registryFor('ext')?.has('Payment')).toBe(false);
  });

  it('refuses an unknown target', async () => {
    const engine = await boot();
    const { code, message } = refusal(
      await proposeType(engine, 'Payment', { invoice: ref({ type: 'Nope' }) })
    );
    expect(code).toBe('invalid_field_spec');
    expect(message).toContain("no type 'app/Nope'");
  });

  it('refuses a target namespace the proposer cannot read', async () => {
    const engine = await boot();
    const known = refusal(await proposeType(engine, 'Payment', { invoice: ref() }, as(EXT_ONLY)));
    expect(known.code).toBe('invalid_field_spec');
    expect(known.message).toContain("you cannot read namespace 'app'");
    // The same answer whether or not the type exists, so the refusal is no existence probe.
    const unknown = refusal(
      await proposeType(engine, 'Payment', { invoice: ref({ type: 'Nope' }) }, as(EXT_ONLY))
    );
    expect(unknown).toEqual(known);

    const readable = as({ ...EXT_ONLY, '*': ['read'] });
    expect(
      (await proposeType(engine, 'Payment', { invoice: ref() }, readable)).errors
    ).toBeUndefined();
  });

  it('applies the same rules to propose_field', async () => {
    const engine = await boot();
    expect((await proposeType(engine, 'Order', { amount })).errors).toBeUndefined();

    expect(
      refusal(await proposeField(engine, 'invoice', ref({ onDelete: 'restrict' }))).message
    ).toContain("'restrict' is not allowed on a reference to 'app/Invoice'");
    expect(refusal(await proposeField(engine, 'invoice', ref({ type: 'Nope' }))).message).toContain(
      "no type 'app/Nope'"
    );
    expect(refusal(await proposeField(engine, 'invoice', ref(), as(EXT_ONLY))).message).toContain(
      "you cannot read namespace 'app'"
    );

    expect((await proposeField(engine, 'invoice', ref())).errors).toBeUndefined();
    expect(engine.registryFor('ext')?.get('Order')?.fields.invoice).toMatchObject({
      ns: 'app',
      type: 'Invoice',
      onDelete: 'set_null'
    });
  });

  it('refuses a type with no storage behind it', async () => {
    const engine = await boot();
    const { code, message } = refusal(
      await proposeType(engine, 'Payment', { hit: ref({ ns: 'virt', type: 'Hit' }) })
    );
    expect(code).toBe('invalid_field_spec');
    expect(message).toContain("'virt/Hit' is not a stored type");
  });

  it('lets an explicit grant entry beat the wildcard', async () => {
    const engine = await boot();
    const grants = { ...EXT_ONLY, app: ['mutate'], '*': ['read'] };
    expect(
      refusal(await proposeType(engine, 'Payment', { invoice: ref() }, as(grants))).message
    ).toContain("you cannot read namespace 'app'");
  });
});

/** A TypeProposal row as a direct write would carry it. */
function typeRow(typeName: string, fields: Record<string, FieldSpecJson>, applied = true) {
  return {
    typeName,
    fieldsJson: JSON.stringify(fields),
    proposedBy: 'agent',
    proposedAt: T0,
    proposedReason: 'direct',
    applied,
    appliedAt: applied ? T0 : null,
    supersededByCode: false,
    archived: false
  };
}

function write(
  engine: Engine,
  key: string,
  params: Record<string, unknown>,
  ctx = PROPOSER
): Promise<PackEnvelope> {
  return engine.mutate({ frame: { [`ext/${key}`]: { params, fields: { id: true } } }, ctx });
}

describe('a proposal row written directly', () => {
  it('meets the same rules as propose_type and propose_field', async () => {
    const engine = await boot();
    const extOnly = as(EXT_ONLY);
    const unreadable = "you cannot read namespace 'app'";

    expect(
      refusal(await write(engine, 'createTypeProposal', typeRow('Fresh', { x: ref() }), extOnly))
        .message
    ).toContain(unreadable);
    // An array runs each element through the same check.
    const batched = await engine.mutate({
      frame: {
        'ext/createTypeProposal': [{ params: typeRow('Fresh', { x: ref() }), fields: { id: true } }]
      },
      ctx: extOnly
    });
    expect(batched.errors?.[0]?.message).toContain(unreadable);
    expect(
      refusal(
        await write(
          engine,
          'createTypeProposal',
          typeRow('Fresh', { x: ref({ onDelete: 'restrict' }) })
        )
      ).message
    ).toContain("'restrict' is not allowed on a reference to 'app/Invoice'");

    // A type proposed by the row itself, or not yet replayed, is an owned target.
    const fresh = await write(
      engine,
      'createTypeProposal',
      typeRow('Fresh', { x: ref(), self: ref({ ns: 'ext', type: 'Fresh' }) }, false)
    );
    expect(fresh.errors).toBeUndefined();
    const id = (fresh.data['ext/createTypeProposal'] as { id: string }).id;
    expect(
      refusal(
        await write(
          engine,
          'updateTypeProposal',
          { id, fieldsJson: JSON.stringify({ x: ref() }) },
          extOnly
        )
      ).message
    ).toContain(unreadable);

    const fieldRow = {
      targetType: 'Fresh',
      fieldName: 'y',
      fieldSpecJson: JSON.stringify(ref()),
      proposedBy: 'agent',
      proposedAt: T0,
      proposedReason: 'direct',
      applied: false,
      appliedAt: null,
      supersededByCode: false,
      archived: false
    };
    expect(
      refusal(await write(engine, 'createFieldProposal', fieldRow, extOnly)).message
    ).toContain(unreadable);
    const field = await write(engine, 'createFieldProposal', fieldRow);
    expect(field.errors).toBeUndefined();
    const fieldId = (field.data['ext/createFieldProposal'] as { id: string }).id;
    expect(
      refusal(
        await write(engine, 'updateFieldProposal', {
          id: fieldId,
          fieldSpecJson: JSON.stringify(ref({ onDelete: 'restrict' }))
        })
      ).message
    ).toContain("'restrict' is not allowed on a reference to 'app/Invoice'");
  });

  it('checks the references of a row left live against whoever leaves it so', async () => {
    const engine = await boot();
    const extOnly = as(EXT_ONLY);
    const unreadable = "you cannot read namespace 'app'";
    const created = async (key: string, params: Record<string, unknown>): Promise<string> => {
      const env = await write(engine, key, params);
      expect(env.errors).toBeUndefined();
      return (env.data[`ext/${key}`] as { id: string }).id;
    };

    // Written unapplied, and applied but superseded, by a reader of `app`.
    const id = await created('createTypeProposal', typeRow('Fresh', { x: ref() }, false));
    const sup = await created('createTypeProposal', {
      ...typeRow('Sup', { x: ref() }),
      supersededByCode: true
    });
    const live = [
      { id, applied: true },
      { id: sup, supersededByCode: false }
    ];
    for (const params of live) {
      expect(refusal(await write(engine, 'updateTypeProposal', params, extOnly)).message).toContain(
        unreadable
      );
    }
    // Reference-neutral fields, or flags that leave the row unapplied, need no read.
    for (const params of [
      { id, proposedReason: 'why' },
      { id, applied: false }
    ]) {
      expect((await write(engine, 'updateTypeProposal', params, extOnly)).errors).toBeUndefined();
    }
    for (const params of live) {
      expect((await write(engine, 'updateTypeProposal', params)).errors).toBeUndefined();
    }
    // Renaming a live row leaves its references live under the new name.
    expect(
      refusal(await write(engine, 'updateTypeProposal', { id, typeName: 'Other' }, extOnly)).message
    ).toContain(unreadable);

    const fieldRow = (over: Record<string, unknown>) => ({
      targetType: 'Fresh',
      fieldName: 'y',
      fieldSpecJson: JSON.stringify(ref()),
      proposedBy: 'agent',
      proposedAt: T0,
      proposedReason: 'direct',
      applied: false,
      appliedAt: null,
      supersededByCode: false,
      archived: false,
      ...over
    });
    const fid = await created('createFieldProposal', fieldRow({}));
    const fsup = await created(
      'createFieldProposal',
      fieldRow({ applied: true, supersededByCode: true })
    );
    const stored = await engine.datasetFor('ext')?.read('FieldProposal', { id: fid });
    const shortId = stored?.rows[0]?.shortId;
    expect(typeof shortId).toBe('number');
    const liveFields = [
      { id: fid, applied: true },
      { id: fsup, supersededByCode: false }
    ];
    // A numeric id (here a short id) reaches the row as the update resolver does.
    for (const params of [...liveFields, { id: shortId, applied: true }]) {
      expect(
        refusal(await write(engine, 'updateFieldProposal', params, extOnly)).message
      ).toContain(unreadable);
    }
    // A row that cannot be loaded is refused, never checked on the update alone.
    expect(
      refusal(await write(engine, 'updateFieldProposal', { id: 'missing', applied: true })).code
    ).toBe('policy_denied');
    for (const params of liveFields) {
      expect((await write(engine, 'updateFieldProposal', params)).errors).toBeUndefined();
    }
  });

  it('checks an update that rewrites a spec whatever the row is left as', async () => {
    const engine = await boot();
    const extOnly = as(EXT_ONLY);
    const unreadable = "you cannot read namespace 'app'";
    const created = async (key: string, params: Record<string, unknown>): Promise<string> => {
      const env = await write(engine, key, params);
      expect(env.errors).toBeUndefined();
      return (env.data[`ext/${key}`] as { id: string }).id;
    };
    const id = await created('createTypeProposal', typeRow('Fresh', { x: ref() }, false));
    const live = await created('createTypeProposal', typeRow('Live', { n: amount }));
    const fid = await created('createFieldProposal', {
      targetType: 'Fresh',
      fieldName: 'y',
      fieldSpecJson: JSON.stringify(ref()),
      proposedBy: 'agent',
      proposedAt: T0,
      proposedReason: 'direct',
      applied: false,
      appliedAt: null,
      supersededByCode: false,
      archived: false
    });

    const refused: Array<[string, Record<string, unknown>]> = [
      ['updateTypeProposal', { id, typeName: 'Renamed' }],
      [
        'updateTypeProposal',
        { id: live, fieldsJson: JSON.stringify({ x: ref() }), applied: false }
      ],
      ['updateFieldProposal', { id: fid, fieldName: 'z' }],
      ['updateFieldProposal', { id: fid, targetType: 'Other' }],
      ['updateFieldProposal', { id: fid, fieldSpecJson: JSON.stringify(ref()) }],
      // An undefined value is a key not sent, as the update resolver reads it.
      ['updateTypeProposal', { id, applied: true, archived: undefined }]
    ];
    for (const [key, params] of refused) {
      expect(refusal(await write(engine, key, params, extOnly)).message, key).toContain(unreadable);
    }
    expect(
      (await write(engine, 'updateTypeProposal', { id, applied: true })).errors
    ).toBeUndefined();
    expect(
      (
        await write(
          engine,
          'updateTypeProposal',
          { id, proposedReason: 'why', applied: undefined },
          extOnly
        )
      ).errors
    ).toBeUndefined();
  });

  it('is applied at boot only when its target exists and is not restrict', async () => {
    // Written straight to the store, past every check but apply's.
    const ext = new MemoryDataset({ namespace: 'ext', walkReference: true });
    await ext.write('TypeProposal', [
      { id: 'fine', ...typeRow('Fine', { invoice: ref() }) },
      { id: 'restricted', ...typeRow('Restricted', { invoice: ref({ onDelete: 'restrict' }) }) },
      { id: 'gone', ...typeRow('Gone', { invoice: ref({ type: 'Nope' }) }) }
    ]);
    const registry = (await boot(ext)).registryFor('ext');
    expect(registry?.has('Fine')).toBe(true);
    expect(registry?.has('Restricted')).toBe(false);
    expect(registry?.has('Gone')).toBe(false);
  });
});

describe('a read across the reference', () => {
  it('returns the stored id only, and refuses a walk into the other namespace', async () => {
    const engine = await boot();
    expect(
      (await proposeType(engine, 'Payment', { amount, invoice: ref() })).errors
    ).toBeUndefined();
    const invoice = await engine.mutate({
      frame: { 'app/createInvoice': { params: { number: 'INV-1' }, fields: { id: true } } },
      ctx: PROPOSER
    });
    const invoiceId = (invoice.data['app/createInvoice'] as { id: string }).id;
    const payment = await engine.mutate({
      frame: {
        'ext/createPayment': { params: { amount: 5, invoice: invoiceId }, fields: { id: true } }
      },
      ctx: PROPOSER
    });
    expect(payment.errors).toBeUndefined();

    const extReader = as({ ext: ['read'] });
    const read = await engine.query({
      frame: { 'ext/Payment': { params: {}, fields: { id: true, invoice: { number: true } } } },
      ctx: extReader
    });
    expect(read.errors).toBeUndefined();
    expect((read.data['ext/Payment'] as Array<{ invoice: unknown }>)[0]?.invoice).toBe(invoiceId);
    expect(JSON.stringify(read.data)).not.toContain('INV-1');

    const walks: Array<[string, Record<string, unknown>, Partial<RequestContext>]> = [
      [
        'ext/Payment',
        { params: { where: { _walk: { out: 'invoice', where: { number: { eq: 'INV-1' } } } } } },
        extReader
      ],
      [
        'ext/Payment',
        { fields: { id: true, inv: { _walk: { out: 'invoice' }, fields: { number: true } } } },
        extReader
      ],
      [
        'app/Invoice',
        { params: { where: { _walk: { in: 'ext/Payment.invoice' } } } },
        as({ app: ['read'] })
      ]
    ];
    for (const [key, frame, ctx] of walks) {
      const env = await engine.query({ frame: { [key]: { fields: { id: true }, ...frame } }, ctx });
      expect(env.errors?.[0]?.code, key).toBe('walk_cross_namespace');
      expect(env.data[key], key).toBeUndefined();
    }
  });
});

describe('a write naming an id in the other namespace', () => {
  it('needs read there, and refuses the same way whether or not the id exists', async () => {
    const engine = await boot();
    expect(
      (await proposeType(engine, 'Payment', { amount, invoice: ref() })).errors
    ).toBeUndefined();
    const invoice = await engine.mutate({
      frame: { 'app/createInvoice': { params: { number: 'INV-1' }, fields: { id: true } } },
      ctx: PROPOSER
    });
    const invoiceId = (invoice.data['app/createInvoice'] as { id: string }).id;
    const created = await engine.mutate({
      frame: {
        'ext/createPayment': { params: { amount: 1, invoice: invoiceId }, fields: { id: true } }
      },
      ctx: PROPOSER
    });
    const paymentId = (created.data['ext/createPayment'] as { id: string }).id;
    const missingId = '01900000-0000-7000-8000-000000000000';

    // Every autoCRUD write that can set the reference, single and batched.
    const writes = (id: string): Array<[string, unknown]> => [
      ['ext/createPayment', { params: { amount: 5, invoice: id }, fields: { id: true } }],
      ['ext/createPayment', [{ params: { amount: 5, invoice: id }, fields: { id: true } }]],
      ['ext/updatePayment', { params: { id: paymentId, invoice: id }, fields: { id: true } }],
      [
        'ext/updateManyPayment',
        { params: { where: { id: { eq: paymentId } }, set: { invoice: id } } }
      ]
    ];
    const run = (key: string, frame: unknown, ctx: Partial<RequestContext>) =>
      engine.mutate({ frame: { [key]: frame } as never, ctx });

    const existing = writes(invoiceId);
    const missing = writes(missingId);
    // Not covering `app`, and covering it without read: each gets the read gate's own answer.
    const unreaders: Array<[Partial<RequestContext>, string]> = [
      [as(EXT_ONLY), 'unauthorized_namespace'],
      [as({ ...EXT_ONLY, app: ['mutate'] }), 'unauthorized_capability']
    ];
    for (const [ctx, code] of unreaders) {
      const readGate = (
        await engine.query({ frame: { 'app/Invoice': { fields: { id: true } } }, ctx })
      ).errors?.[0];
      expect(readGate?.code).toBe(code);
      for (const [i, [key, frame]] of existing.entries()) {
        const known = await run(key, frame, ctx);
        const unknown = await run(key, missing[i]?.[1], ctx);
        expect(known.errors?.[0], key).toMatchObject({
          code,
          message: `crossRef 'invoice': ${readGate?.message}`,
          path: [key]
        });
        expect(unknown.errors, key).toEqual(known.errors);
        expect(unknown.data, key).toEqual(known.data);
      }
    }

    // A reader, an identity with no grant and no identity at all pass the read gate, so the
    // referent is looked up. A write with no identity is then refused as unattributed whatever
    // it names, so only a missing id shows its verdict there.
    const reader = as({ ...EXT_ONLY, app: ['read'] });
    const noGrant: Partial<RequestContext> = {
      ...PROPOSER,
      identity: { id: 'agent', tokenId: 'agent' } as unknown as Identity
    };
    const noIdentity: Partial<RequestContext> = { ...PROPOSER, identity: null };
    for (const ctx of [reader, noGrant, noIdentity]) {
      const readGate = await engine.query({
        frame: { 'app/Invoice': { fields: { id: true } } },
        ctx
      });
      expect(readGate.errors).toBeUndefined();
      for (const [key, frame] of missing) {
        expect((await run(key, frame, ctx)).errors?.[0]?.code, key).toBe('missing_referent');
      }
    }
    for (const ctx of [reader, noGrant]) {
      for (const [key, frame] of existing) {
        expect((await run(key, frame, ctx)).errors, key).toBeUndefined();
      }
    }
  });
});
