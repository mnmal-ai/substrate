/**
 * A `restrict` reference and a delete of its target, racing in two
 * transactions: whichever order they interleave in, the store never ends with
 * a live restrict edge to a tombstoned row.
 *
 * Skipped when POSTGRES_URL is absent.
 */

import { Engine, type NamespaceConfig, Registry } from '@mnmal-ai/substrate-core';
import { MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { field, installAutoCrud } from '@mnmal-ai/substrate-sdk';
import type { RequestContext } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTypeTable, PgDataset, PgEdgesStore } from '../src/index.js';
import { dropNamespacesLike } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const PREFIX = 'rrace';

const ctx: RequestContext = {
  identity: { kind: 'agent', id: 't', agentKeyId: 't', grants: { '*': ['read', 'mutate'] } },
  namespace: 'any',
  operation: 'mutate',
  now: new Date(),
  headers: {},
  meta: {}
};

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!POSTGRES_URL)('restrict reference vs delete of its target', () => {
  let sql: Sql;
  let seq = 0;
  const run = Date.now().toString(36);

  beforeAll(() => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
  });
  afterAll(async () => {
    const like = `${PREFIX}%`;
    await sql`DELETE FROM short_ids WHERE namespace LIKE ${like}`;
    await sql`DELETE FROM edges WHERE from_ns LIKE ${like} OR to_ns LIKE ${like}`;
    await dropNamespacesLike(sql, PREFIX);
    await sql.end();
  });

  async function stack() {
    const ns = `${PREFIX}_${run}_${++seq}`;
    const edges = new PgEdgesStore({ sql });
    const dataset = new PgDataset({ namespace: ns, sql, edgesStore: edges });
    const registry = new Registry();
    installAutoCrud(registry, 'Owner', dataset, edges, {
      fields: { id: field.string(), name: field.string() }
    });
    installAutoCrud(registry, 'Item', dataset, edges, {
      fields: {
        id: field.string(),
        owner: field.crossRef(ns, 'Owner', { onDelete: 'restrict' })
      }
    });
    const datasets = new MemoryDatasetRegistry();
    datasets.set(ns, dataset);
    const engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>([[ns, { registry }]]),
      datasets,
      edges
    });
    const mutate = (op: string, params: Record<string, unknown>) =>
      engine.mutate({
        frame: { [`${ns}/${op}`]: { params, fields: { id: true } } },
        ctx
      });
    expect((await mutate('createOwner', { id: 'o1', name: 'owner' })).errors).toBeUndefined();
    const owners = await loadTypeTable(sql, ns, 'Owner');
    if (owners === undefined) throw new Error('no Owner table');
    return { ns, mutate, ownerTable: owners.from };
  }

  it('a delete that starts while a referencing create is open sees its edge and is refused', async () => {
    const { ns, mutate, ownerTable } = await stack();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    // The create's half: the referenced row share-locked and the edge written, not yet committed.
    const create = sql.begin(async (tx) => {
      await tx.unsafe(`SELECT 1 FROM ${ownerTable} WHERE id = 'o1' FOR SHARE`);
      await new PgEdgesStore({ sql: tx as unknown as Sql }).write({
        from: { ns, type: 'Item', id: 'i1' },
        to: { ns, type: 'Owner', id: 'o1' },
        fieldName: 'owner',
        policy: 'restrict'
      });
      await held;
    });
    await pause(100);
    const del = mutate('deleteOwner', { id: 'o1' });
    await pause(300);
    release();
    await create;
    const env = await del;
    expect((env.errors ?? []).map((e) => e.code)).toContain('restrict_violation');
  });

  it('a create that starts while a delete of its target is open is refused once the delete commits', async () => {
    const { mutate, ownerTable } = await stack();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const del = sql.begin(async (tx) => {
      await tx.unsafe(`UPDATE ${ownerTable} SET deleted_at = now() WHERE id = 'o1'`);
      await held;
    });
    await pause(100);
    const create = mutate('createItem', { id: 'i1', owner: 'o1' });
    await pause(300);
    release();
    await del;
    const env = await create;
    expect((env.errors ?? []).map((e) => e.code)).toContain('missing_referent');
  });
});
