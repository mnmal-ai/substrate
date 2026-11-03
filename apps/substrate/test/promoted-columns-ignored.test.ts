/**
 * `NamespaceDefinition.promotedColumns` is deprecated and ignored (Task 16):
 * every declared scalar is a column of its type table, so a namespace that
 * still declares a promoted column boots, writes and filters as one that does
 * not, with no error and no column of the promoted name.
 *
 * Skipped unless POSTGRES_URL is set.
 */

import { randomBytes } from 'node:crypto';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { type PgDataset, runMigrations, typeTableRef } from '@mnmal-ai/substrate-dataset-pg';
import { pgTestSchemaName, pgTestSchemaUrl } from '@mnmal-ai/substrate-dataset-pg/testing';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import type { CoordinatorPlugin } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPluginDatasetMap } from '../src/serve/wiring.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = 'promoted_ignored';

describe.skipIf(!POSTGRES_URL)('promotedColumns (pg)', () => {
  let schema: string;
  let sql: Sql;

  beforeAll(async () => {
    const name = `apps/substrate-promoted-ignored-${randomBytes(4).toString('hex')}`;
    schema = pgTestSchemaName(name);
    sql = postgres(pgTestSchemaUrl(POSTGRES_URL as string, name), { onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql?.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await sql?.end({ timeout: 5 });
  });

  it('promotedColumns on a namespace is ignored; its fields are columns', async () => {
    const def = defineNamespace(
      NS,
      { Alert: { fields: { severity: field.string(), note: field.string() } } },
      { promotedColumns: { severity: { column: 'severity', kind: 'text' } } }
    );
    const plugin = { name: NS, namespaces: [def] } as unknown as CoordinatorPlugin;
    const datasets = buildPluginDatasetMap(
      [plugin],
      new MemoryDataset({ namespace: 'default' }),
      sql,
      null,
      () => () => undefined
    );
    const ds = datasets[NS] as PgDataset;
    await ds.write('Alert', [
      { id: 'a1', severity: 'high', note: 'x' },
      { id: 'a2', severity: 'low', note: 'y' }
    ]);

    const ref = await typeTableRef(sql, NS, 'Alert');
    const columns = await sql<{ name: string }[]>`
      SELECT attname::text AS name FROM pg_attribute
      WHERE attrelid = ${ref?.from as string}::regclass AND attnum > 0 AND NOT attisdropped`;
    expect(columns.map((c) => c.name)).toContain('f_severity');
    expect(columns.map((c) => c.name)).not.toContain('severity');
    // The writer keeps the row's own `id` in `extra`; nothing else lands there.
    const stored = await sql.unsafe(
      `SELECT id, f_severity, extra - 'id' AS extra FROM ${ref?.from} ORDER BY id`
    );
    expect(stored).toEqual([
      { id: 'a1', f_severity: 'high', extra: {} },
      { id: 'a2', f_severity: 'low', extra: {} }
    ]);

    const { rows } = await ds.read('Alert', {
      where: { severity: { eq: 'high' } },
      orderBy: [{ severity: 'asc' }]
    });
    expect(rows.map((r) => [r.id, r.severity, r.note])).toEqual([['a1', 'high', 'x']]);
  });
});
