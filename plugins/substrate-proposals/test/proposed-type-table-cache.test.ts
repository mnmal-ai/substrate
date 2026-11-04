/**
 * Warm reads of runtime-proposed types make no catalog query: plain, walk and
 * nested reads all resolve their type tables through the pool's TableCache,
 * and a field proposed later is still seen once its catalog notification lands.
 */

import { Engine, loadPlugins } from '@mnmal-ai/substrate-core';
import { MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import { PgDataset, PgEdgesStore } from '@mnmal-ai/substrate-dataset-pg';
import type { Dataset, NamespaceConfig, QualifiedFrame } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNoopPubSub } from '../src/config.js';
import { createProposalsPlugin, storageSettled } from '../src/index.js';
import { deleteNamespaces } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = 'kproposedcache';
const ctx = {
  identity: {
    id: 'agent-1',
    tokenId: 'agent-1',
    grants: { '*': ['substrate.propose', 'read', 'mutate'] }
  }
};
/** A catalog lookup; a read's version probe (`substrate_type_tables g`) is its guard, not one. */
const CATALOG = /substrate_type_(tables|fields)(?! g\b)/;

describe.skipIf(!POSTGRES_URL)('proposed types read through the TableCache (pg)', () => {
  let sql: Sql;
  let statements: string[] = [];
  let engine: Engine;

  const catalog = () => statements.filter((q) => CATALOG.test(q));
  async function query(frame: QualifiedFrame) {
    const env = await engine.query({ frame, ctx });
    expect(env.errors ?? []).toEqual([]);
    return env.data;
  }
  async function mutate(frame: QualifiedFrame) {
    const env = await engine.mutate({ frame, ctx });
    expect(env.errors ?? []).toEqual([]);
    await storageSettled();
    return env.data;
  }
  /** A read's catalog-version probe (M3), one per type its statement decodes. */
  const probes = (q: string) => q.match(/\bsubstrate_type_tables g\b/g)?.length ?? 0;
  /**
   * Catalog statements a warm `frame` issues: run once to warm, then count the
   * second. Its statements' probes are asserted apart: `probed`, per statement.
   */
  async function warmCatalog(frame: QualifiedFrame, probed: number[]): Promise<string[]> {
    await query(frame);
    statements = [];
    await query(frame);
    expect(statements.map(probes).filter((n) => n > 0)).toEqual(probed);
    return catalog();
  }

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, {
      onnotice: () => {},
      debug: (_conn, q) => {
        statements.push(q);
      }
    });
    await deleteNamespaces(sql, NS, '_system_proposals');
    const edges = new PgEdgesStore({ sql });
    const datasets = new MemoryDatasetRegistry();
    // As serve/wiring.ts's typeDefLookup: a proposed type's fields from the live registry.
    const fieldsOf = (ns: string, type: string) => {
      const entry = engine?.registryFor(ns)?.get(type);
      return entry?.kind === 'type' ? entry.fields : undefined;
    };
    for (const ns of [NS, '_system_proposals']) {
      datasets.set(
        ns,
        new PgDataset({
          namespace: ns,
          sql,
          edgesStore: edges,
          fieldDefLookup: (type, f) => fieldsOf(ns, type)?.[f],
          typeDefLookup: (type, n) => {
            const fields = fieldsOf(n, type);
            return fields === undefined ? undefined : { fields };
          }
        })
      );
    }
    const datasetFor = (ns: string): Dataset | undefined => datasets.get(ns);
    const plugin = createProposalsPlugin({
      ownedNamespaces: [NS],
      pubsub: createNoopPubSub(),
      datasetFor
    });
    const loaded = await loadPlugins({ plugins: [plugin], edges, datasetFor });
    engine = new Engine({
      namespaces: new Map<string, NamespaceConfig>(loaded.namespaces),
      datasets,
      edges
    });
    await loaded.runOnStart(engine);
    await mutate({
      [`${NS}/propose_type`]: {
        params: {
          typeName: 'Person',
          fields: { name: { kind: 'scalar', type: 'string' } },
          proposedReason: 'test'
        },
        fields: { applied: true }
      }
    });
    await mutate({
      [`${NS}/propose_type`]: {
        params: {
          typeName: 'Item',
          fields: {
            title: { kind: 'scalar', type: 'string' },
            owner: { kind: 'crossRef', ns: NS, type: 'Person', nullable: true, indexed: true }
          },
          proposedReason: 'test'
        },
        fields: { applied: true }
      }
    });
    await mutate({
      [`${NS}/createPerson`]: { params: { id: 'p1', name: 'Ann' }, fields: { id: true } }
    });
    await mutate({
      [`${NS}/createItem`]: {
        params: { id: 'i1', title: 'alpha', owner: 'p1' },
        fields: { id: true }
      }
    });
  }, 60_000);

  afterAll(async () => {
    await deleteNamespaces(sql, NS, '_system_proposals');
    await sql.end({ timeout: 5 });
  });

  it('a warm plain read issues no catalog statement', async () => {
    expect(
      await warmCatalog(
        {
          [`${NS}/Item`]: { params: { where: { title: { eq: 'alpha' } } }, fields: { id: true } }
        },
        [1]
      )
    ).toEqual([]);
  });

  it('a warm walk read issues no catalog statement', async () => {
    expect(
      await warmCatalog(
        {
          [`${NS}/Item`]: {
            params: { where: { _walk: { out: 'owner', where: { name: { eq: 'Ann' } } } } },
            fields: { id: true }
          }
        },
        [2]
      )
    ).toEqual([]);
  });

  it('a warm nested read issues no catalog statement', async () => {
    expect(
      await warmCatalog(
        {
          [`${NS}/Item`]: { params: {}, fields: { id: true, owner: { id: true, name: true } } }
        },
        [1]
      )
    ).toEqual([]);
  });

  it('a field proposed later is read once its catalog notification lands', async () => {
    const frame = { [`${NS}/Item`]: { params: {}, fields: { id: true, title: true } } };
    await query(frame);
    await mutate({
      [`${NS}/propose_field`]: {
        params: {
          targetType: 'Item',
          fieldName: 'size',
          fieldSpec: { kind: 'scalar', type: 'number', nullable: true },
          proposedReason: 'test'
        },
        fields: { applied: true }
      }
    });
    await mutate({
      [`${NS}/updateItem`]: { params: { id: 'i1', size: 3 }, fields: { id: true } }
    });
    let size: unknown;
    for (let i = 0; i < 50 && size !== 3; i++) {
      const data = await query({
        [`${NS}/Item`]: { params: { where: { size: { eq: 3 } } }, fields: { id: true, size: true } }
      });
      size = (data[`${NS}/Item`] as Array<{ size?: unknown }>)[0]?.size;
      if (size !== 3) await new Promise((r) => setTimeout(r, 20));
    }
    expect(size).toBe(3);
  });
});
