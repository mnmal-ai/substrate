/**
 * A proposed type may reference a type defined in code: `ext` is owned by the
 * proposals plugin, `app` is a code-defined namespace beside it.
 */

import { Engine, loadPlugins, MemoryEdgesStore } from '@mnmal-ai/substrate-core';
import { MemoryDataset, MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import type {
  CoordinatorPlugin,
  Dataset,
  PackEnvelope,
  RequestContext
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { CONTROL_NAMESPACE } from '../src/control-plane.js';
import type { CrossRefSpec, FieldSpecJson } from '../src/field-spec-json.js';
import { createNoopPubSub, createProposalsPlugin } from '../src/index.js';

const T0 = new Date('2026-11-19T00:00:00Z');

async function boot(): Promise<Engine> {
  const datasets = new MemoryDatasetRegistry();
  for (const ns of [CONTROL_NAMESPACE, 'ext', 'app']) {
    datasets.set(ns, new MemoryDataset({ namespace: ns }));
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
  const engine = new Engine({ namespaces: loaded.namespaces, datasets, edges });
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
});
