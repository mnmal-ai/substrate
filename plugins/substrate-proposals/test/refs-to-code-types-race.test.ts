/**
 * Two updates of one proposal row racing on pg, one writing a reference to a
 * code-defined type into its spec and one making the row live: whichever
 * commits first, the row never ends live with a reference that the last
 * identity to write it cannot read. Memory runs one transaction at a time, so
 * only pg can interleave the two.
 *
 * Skipped when POSTGRES_URL is absent.
 */

import { Engine, loadPlugins } from '@mnmal-ai/substrate-core';
import { MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { PgDataset, PgEdgesStore } from '@mnmal-ai/substrate-dataset-pg';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import type {
  CoordinatorPlugin,
  Dataset,
  PackEnvelope,
  RequestContext,
  Row
} from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTROL_NAMESPACE } from '../src/control-plane.js';
import { isLiveProposal } from '../src/cross-ref-targets.js';
import { createNoopPubSub, createProposalsPlugin, storageSettled } from '../src/index.js';
import { deleteNamespaces } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const EXT = 'kracerefs';
const APP = 'kraceapp';
const TRIALS = 40;
const T0 = new Date('2026-11-19T00:00:00Z');

function as(id: string, grants: Record<string, string[]>): Partial<RequestContext> {
  return { identity: { id, tokenId: id, grants }, now: T0, headers: {}, meta: {} };
}
const READER = as('reader', { '*': ['read', 'mutate', 'substrate.propose'] });
const EXT_ONLY = as('ext-only', { [EXT]: ['read', 'mutate', 'substrate.propose'] });

const clean = JSON.stringify({ kind: 'scalar', type: 'number' });
const toInvoice = JSON.stringify({ kind: 'crossRef', ns: APP, type: 'Invoice' });

/** Each proposal type's row, and the spec field A writes the reference into. */
const kinds = {
  TypeProposal: {
    row: (name: string) => ({ typeName: name, fieldsJson: `{"x":${clean}}` }),
    key: 'fieldsJson',
    referencing: `{"x":${toInvoice}}`
  },
  FieldProposal: {
    row: (name: string) => ({ targetType: 'Order', fieldName: name, fieldSpecJson: clean }),
    key: 'fieldSpecJson',
    referencing: toInvoice
  }
};

/**
 * The spec write A races the flip B (`applied: true`, from an identity that
 * cannot read `APP`). A takes a live row out of liveness as it writes, or
 * writes an unapplied row's spec.
 */
const variants = [
  { name: 'ExtUnapplied', writer: EXT_ONLY, live: false },
  { name: 'ExtLive', writer: EXT_ONLY, live: true },
  { name: 'ReaderUnapplied', writer: READER, live: false },
  { name: 'ReaderLive', writer: READER, live: true }
];

describe.skipIf(!POSTGRES_URL)('a spec write racing a flip to live (pg)', () => {
  let sql: Sql;
  let engine: Engine;
  let ext: Dataset;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {}, max: 10 });
    const edges = new PgEdgesStore({ sql });
    const datasets = new MemoryDatasetRegistry();
    for (const ns of [EXT, APP, CONTROL_NAMESPACE]) {
      datasets.set(ns, new PgDataset({ namespace: ns, sql, edgesStore: edges }));
    }
    ext = datasets.get(EXT) as Dataset;
    const datasetFor = (ns: string): Dataset | undefined => datasets.get(ns);
    const app: CoordinatorPlugin = {
      name: 'app',
      contractVersion: '>=1.0.0-alpha.0 <2.0.0',
      namespaces: [defineNamespace(APP, { Invoice: { fields: { number: field.string() } } })]
    };
    const proposals = createProposalsPlugin({
      ownedNamespaces: [EXT],
      pubsub: createNoopPubSub(),
      datasetFor
    });
    const loaded = await loadPlugins({ plugins: [proposals, app], datasetFor, edges });
    engine = new Engine({ namespaces: loaded.namespaces, datasets, edges });
    await loaded.runOnStart(engine);
  }, 60_000);

  afterAll(async () => {
    await storageSettled();
    await deleteNamespaces(sql, EXT, APP);
    await sql.end({ timeout: 5 });
  });

  function write(
    key: string,
    params: Record<string, unknown>,
    ctx: Partial<RequestContext>
  ): Promise<PackEnvelope> {
    return engine.mutate({ frame: { [`${EXT}/${key}`]: { params, fields: { id: true } } }, ctx });
  }

  for (const [type, kind] of Object.entries(kinds)) {
    it(`never leaves a ${type} live with a reference its last writer cannot read`, async () => {
      const outcomes: Record<string, number> = {};
      const violations: string[] = [];
      for (const variant of variants) {
        for (const order of ['AB', 'BA'] as const) {
          for (let i = 0; i < TRIALS; i++) {
            const created = await write(
              `create${type}`,
              {
                ...kind.row(`${variant.name}${order}${i}`),
                proposedBy: 'agent',
                proposedAt: T0,
                proposedReason: 'race',
                applied: variant.live,
                appliedAt: null,
                supersededByCode: false,
                archived: false
              },
              READER
            );
            expect(created.errors).toBeUndefined();
            const id = (created.data[`${EXT}/create${type}`] as { id: string }).id;
            const a = () =>
              write(
                `update${type}`,
                {
                  id,
                  [kind.key]: kind.referencing,
                  ...(variant.live ? { applied: false } : {})
                },
                variant.writer
              );
            const b = () => write(`update${type}`, { id, applied: true }, EXT_ONLY);
            await (order === 'AB' ? Promise.all([a(), b()]) : Promise.all([b(), a()]));

            const row = (await ext.read(type, { id })).rows[0] as Row;
            const referenced = row[kind.key] === kind.referencing;
            const by = (row._metadata as { updatedBy?: { id?: string } }).updatedBy?.id;
            const outcome = `${variant.name} ${order}: live=${isLiveProposal(row)} ref=${referenced} by=${by}`;
            outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
            if (isLiveProposal(row) && referenced && by !== 'reader') violations.push(outcome);
          }
        }
      }
      expect(violations, JSON.stringify(outcomes, null, 1)).toEqual([]);
    }, 180_000);
  }
});
