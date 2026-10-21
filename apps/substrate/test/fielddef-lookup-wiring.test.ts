/**
 * `fieldDefLookup` must be wired into the production dataset construction
 * path the commodity binary uses (`buildPluginDatasetMap`), so numeric / date /
 * boolean body fields on coordinator-contributed namespaces sort +
 * range-compare by their declared scalar type instead of lexicographically.
 *
 * Exercised END TO END through the same builder `runServe` calls — not
 * `PgDataset` in isolation, whose cast behaviour is pinned by
 * `substrate-dataset-pg/test/where-date-cast.test.ts`. Without the lookup,
 * `ORDER BY (body ->> 'count')` text-compares and sorts '10' < '2'.
 *
 * Skipped unless POSTGRES_URL is set.
 */

import { PgDataset, PgEdgesStore, runMigrations } from '@mnmal-ai/substrate-dataset-pg';
import { defineNamespace } from '@mnmal-ai/substrate-sdk';
import type { CoordinatorPlugin, NamespaceDefinition } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildPluginDatasetMap, makeFieldDefLookupFactory } from '../src/main.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

// Coordinator on a NON-default namespace: buildPluginDatasetMap delegates the
// default namespace to the shared substrate dataset, so the per-namespace pg
// datasets are the construction site under test. `count` is a
// plain numeric body field (NOT one of the promoted native columns), so it
// exercises the `(body ->> 'count')::numeric` cast path.
const METRICS_NS = 'kmetrics';
const metricsDef: NamespaceDefinition = defineNamespace(METRICS_NS, {
  Metric: {
    fields: {
      id: { kind: 'scalar', type: 'string', indexed: true },
      count: { kind: 'scalar', type: 'number' }
    }
  }
});
const metricsPlugin: CoordinatorPlugin = {
  name: 'kmetrics',
  contractVersion: '*',
  namespaces: [metricsDef]
};

describe.skipIf(!POSTGRES_URL)('fieldDefLookup wired into buildPluginDatasetMap', () => {
  let sql: Sql;
  let edges: PgEdgesStore;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    await runMigrations(sql);
    edges = new PgEdgesStore({ sql });
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql`TRUNCATE TABLE rows, short_ids`;
  });

  it('orders a numeric body field numerically, not lexicographically', async () => {
    const defaultDataset = new PgDataset({ namespace: 'default', sql });
    const nsDefs = new Map<string, NamespaceDefinition>([[METRICS_NS, metricsDef]]);
    const datasets = buildPluginDatasetMap(
      [metricsPlugin],
      defaultDataset,
      sql,
      edges,
      makeFieldDefLookupFactory(nsDefs)
    );
    const ds = datasets[METRICS_NS];
    expect(ds).toBeDefined();
    await ds?.write('Metric', [
      { id: 'm2', count: 2 },
      { id: 'm10', count: 10 },
      { id: 'm1', count: 1 },
      { id: 'm100', count: 100 },
      { id: 'm20', count: 20 }
    ]);

    const rows = (await ds?.read('Metric', { orderBy: [{ count: 'asc' }] }))?.rows ?? [];
    // Lexicographic (the bug) yields [1, 10, 100, 2, 20]. Numeric is correct.
    expect(rows.map((r: Record<string, unknown>) => r.count)).toEqual([1, 2, 10, 20, 100]);
  });

  it('range predicate on a numeric body field compares numerically', async () => {
    const defaultDataset = new PgDataset({ namespace: 'default', sql });
    const nsDefs = new Map<string, NamespaceDefinition>([[METRICS_NS, metricsDef]]);
    const datasets = buildPluginDatasetMap(
      [metricsPlugin],
      defaultDataset,
      sql,
      edges,
      makeFieldDefLookupFactory(nsDefs)
    );
    const ds = datasets[METRICS_NS];
    await ds?.write('Metric', [
      { id: 'm2', count: 2 },
      { id: 'm10', count: 10 },
      { id: 'm100', count: 100 }
    ]);

    const rows = (await ds?.read('Metric', { where: { count: { gt: 9 } } }))?.rows ?? [];
    // Text compare (the bug) drops 10 and 100 ('1...' < '9' lexically) and the
    // result set is wrong. Numeric keeps exactly 10 and 100.
    const counts = rows
      .map((r: Record<string, unknown>) => r.count as number)
      .sort((a: number, b: number) => a - b);
    expect(counts).toEqual([10, 100]);
  });
});
