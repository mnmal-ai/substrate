/**
 * The flip (Task 16): serve boots only the `tables` layout. A `legacy` or
 * `partitioned` store, built from the frozen old-layout DDL, is refused before
 * anything is changed; an empty schema gets the tables baseline.
 *
 * Skipped unless POSTGRES_URL is set.
 */

import { randomBytes } from 'node:crypto';
import { detectLayout, UnsupportedStoreLayoutError } from '@mnmal-ai/substrate-dataset-pg';
import { pgTestSchemaName, pgTestSchemaUrl } from '@mnmal-ai/substrate-dataset-pg/testing';
import postgres, { type Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootStore } from '../src/serve/boot-store.js';
import { parseEnv } from '../src/serve/config.js';
import { buildOldLayout } from './_fixtures/old-layouts.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const ACTOR = { SUBSTRATE_SYSTEM_ACTOR: 'boot-refuses-old-layouts-test' };

/** Every relation in the schema and the ledger's versions, to show a refusal changed nothing. */
async function catalog(sql: Sql): Promise<unknown> {
  const relations = await sql`
    SELECT relname::text AS name, relkind::text AS kind FROM pg_class
    WHERE relnamespace = current_schema()::regnamespace ORDER BY 1`;
  const ledger = await sql`SELECT version, checksum FROM migrations ORDER BY version`;
  return { relations, ledger };
}

describe.skipIf(!POSTGRES_URL)('boot refuses the old layouts (pg)', () => {
  let schema: string;
  let url: string;
  let sql: Sql;

  beforeEach(async () => {
    const name = `apps/substrate-old-layouts-${randomBytes(4).toString('hex')}`;
    schema = pgTestSchemaName(name);
    url = pgTestSchemaUrl(POSTGRES_URL as string, name);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await sql.end({ timeout: 5 });
  });

  const boot = (env: Record<string, string> = {}) =>
    bootStore({
      config: parseEnv({ SUBSTRATE_DATABASE_URL: url, ...ACTOR, ...env }),
      pluginDir: null,
      background: false
    });

  it('legacy store refused at boot with UnsupportedStoreLayoutError naming migrate-store', async () => {
    await buildOldLayout(sql, 'legacy');
    const before = await catalog(sql);
    const err = await boot().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedStoreLayoutError);
    expect((err as UnsupportedStoreLayoutError).layout).toBe('legacy');
    expect((err as Error).message).toBe(
      'this store uses the legacy layout, which this release no longer boots. Copy it into a fresh store with `substrate-admin migrate-store`; the source is only read, so it stays your rollback.'
    );
    expect(await catalog(sql)).toEqual(before);
  });

  it('partitioned store refused likewise', async () => {
    await buildOldLayout(sql, 'partitioned');
    const before = await catalog(sql);
    const err = await boot().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedStoreLayoutError);
    expect((err as UnsupportedStoreLayoutError).layout).toBe('partitioned');
    expect((err as Error).message).toContain('this store uses the partitioned layout');
    expect((err as Error).message).toContain('`substrate-admin migrate-store`');
    expect(await catalog(sql)).toEqual(before);
  });

  it('empty store gets the tables baseline', async () => {
    const booted = await boot();
    try {
      expect(await detectLayout(sql)).toBe('tables');
      const ledger = await sql<{ version: string }[]>`SELECT version FROM migrations ORDER BY 1`;
      expect(ledger.map((r) => r.version)).toEqual([
        '0001t_tables_baseline',
        '0003t_type_table_version',
        '0004t_field_error_version'
      ]);
      expect(await sql`SELECT to_regclass('rows') AS r`).toEqual([{ r: null }]);
    } finally {
      await booted.close();
    }
  });

  it('SUBSTRATE_STORAGE_LAYOUT set → one warning, boot continues', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const booted = await boot({ SUBSTRATE_STORAGE_LAYOUT: 'partitioned' });
    try {
      expect(await detectLayout(sql)).toBe('tables');
    } finally {
      await booted.close();
    }
    vi.restoreAllMocks();
    const warned = writes.filter((w) => w.includes('SUBSTRATE_STORAGE_LAYOUT'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(
      'SUBSTRATE_STORAGE_LAYOUT is no longer read; every store uses per-type tables'
    );
  });
});
