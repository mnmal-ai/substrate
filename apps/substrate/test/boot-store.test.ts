/**
 * `bootStore` runs serve's boot path against a fresh schema without listening,
 * and refuses a store that carries the migrate-store marker.
 *
 * Skipped unless POSTGRES_URL is set.
 */

import { randomBytes } from 'node:crypto';
import {
  detectLayout,
  MIGRATE_STORE_MARKER_TABLE,
  type StorageLayout,
  StoreMigrationInProgressError,
  UnsupportedSchemaNameError
} from '@mnmal-ai/substrate-dataset-pg';
import { pgTestSchemaName, pgTestSchemaUrl } from '@mnmal-ai/substrate-dataset-pg/testing';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import postgres, { type Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootStore } from '../src/serve/boot-store.js';
import { parseEnv } from '../src/serve/config.js';
import { wireStore } from '../src/serve/wiring.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

/** `url` with its startup `options` replaced by `options`, encoded the way postgres.js needs. */
function withOptions(url: string, options: string): string {
  const parsed = new URL(url);
  const params = [...parsed.searchParams.entries()].filter(([key]) => key !== 'options');
  params.push(['options', options]);
  parsed.search = params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return parsed.toString();
}

const ACTOR = { SUBSTRATE_SYSTEM_ACTOR: 'boot-store-test' };

describe.skipIf(!POSTGRES_URL)('bootStore (pg)', () => {
  const layout = (process.env.SUBSTRATE_STORAGE_LAYOUT ?? 'partitioned') as StorageLayout;
  let schema: string;
  let url: string;
  let sql: Sql;

  beforeEach(async () => {
    const name = `apps/substrate-boot-store-${randomBytes(4).toString('hex')}`;
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

  it('boots a store without listening', async () => {
    const start = vi.spyOn(FastifySubstrateServer.prototype, 'start');
    const booted = await bootStore({
      config: parseEnv({ SUBSTRATE_DATABASE_URL: url, SUBSTRATE_SYSTEM_ACTOR: 'boot-store-test' }),
      pluginDir: null,
      layout
    });
    try {
      expect(await detectLayout(sql)).toBe(layout);
      expect(booted.engine.registryFor('_system')?.has('Key')).toBe(true);
      expect(booted.server).toBeInstanceOf(FastifySubstrateServer);
      expect(start).not.toHaveBeenCalled();
    } finally {
      await booted.close();
    }
  });

  it('an explicit layout beats SUBSTRATE_STORAGE_LAYOUT on a fresh store', async () => {
    const previous = process.env.SUBSTRATE_STORAGE_LAYOUT;
    process.env.SUBSTRATE_STORAGE_LAYOUT = 'legacy';
    try {
      const booted = await bootStore({
        config: parseEnv({
          SUBSTRATE_DATABASE_URL: url,
          SUBSTRATE_SYSTEM_ACTOR: 'boot-store-test'
        }),
        pluginDir: null,
        layout: 'partitioned'
      });
      await booted.close();
      expect(await detectLayout(sql)).toBe('partitioned');
    } finally {
      if (previous === undefined) delete process.env.SUBSTRATE_STORAGE_LAYOUT;
      else process.env.SUBSTRATE_STORAGE_LAYOUT = previous;
    }
  });

  it('serve refuses a target that migrate-store has not finished', async () => {
    await sql.unsafe(`CREATE TABLE ${schema}.${MIGRATE_STORE_MARKER_TABLE} (id int)`);
    const config = parseEnv({
      SUBSTRATE_DATABASE_URL: url,
      SUBSTRATE_SYSTEM_ACTOR: 'boot-store-test'
    });
    await expect(bootStore({ config, pluginDir: null, layout })).rejects.toBeInstanceOf(
      StoreMigrationInProgressError
    );
    // migrate-store itself boots past the marker.
    const booted = await bootStore({ config, pluginDir: null, layout, allowMigrating: true });
    await booted.close();
  });
  it('a marker in a sibling schema does not block boot', async () => {
    const sibling = `${schema}_sib`;
    await sql.unsafe(`CREATE SCHEMA ${sibling}`);
    try {
      await sql.unsafe(`CREATE TABLE ${sibling}.${MIGRATE_STORE_MARKER_TABLE} (id int)`);
      const booted = await bootStore({
        config: parseEnv({ SUBSTRATE_DATABASE_URL: url, ...ACTOR }),
        pluginDir: null,
        layout
      });
      await booted.close();
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${sibling} CASCADE`);
    }
  });

  it('refuses a marked store whose schema name needs quoting, by its name', async () => {
    const quoted = `${schema}_Mixed`;
    const quotedUrl = withOptions(POSTGRES_URL as string, `-c search_path="${quoted}",public`);
    await sql.unsafe(`CREATE SCHEMA "${quoted}"`);
    try {
      await sql.unsafe(`CREATE TABLE "${quoted}".${MIGRATE_STORE_MARKER_TABLE} (id int)`);
      await expect(
        bootStore({
          config: parseEnv({ SUBSTRATE_DATABASE_URL: quotedUrl, ...ACTOR }),
          pluginDir: null,
          layout
        })
      ).rejects.toBeInstanceOf(UnsupportedSchemaNameError);
    } finally {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${quoted}" CASCADE`);
    }
  });

  it('wireStore ends its pool when migrations throw', async () => {
    // Only pg_catalog on the path: a non-superuser cannot create there, so the first CREATE fails.
    const app = `boot-store-leak-${randomBytes(4).toString('hex')}`;
    const failing = withOptions(POSTGRES_URL as string, '-c search_path=pg_catalog');
    const parsed = new URL(failing);
    parsed.searchParams.set('application_name', app);
    await expect(wireStore(parsed.toString(), () => () => undefined)).rejects.toThrow();
    const [open] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = ${app}`;
    expect(open?.n).toBe(0);
  });
});
