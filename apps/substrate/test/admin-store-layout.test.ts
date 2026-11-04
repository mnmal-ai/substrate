/**
 * `substrate-admin` on a store serve has never booted: `bootstrap` creates
 * `_system/Key` typed, with `substrate_key_live_kid_uniq` built, so a second
 * live key for one kid is refused before any boot; and every direct-to-pg
 * admin path refuses an old-layout store, naming migrate-store.
 *
 * Each test runs in a fresh schema. Skipped unless POSTGRES_URL is set.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEY_TYPE, SYSTEM_NAMESPACE } from '@mnmal-ai/substrate-compose';
import { UnsupportedStoreLayoutError } from '@mnmal-ai/substrate-dataset-pg';
import { pgTestSchemaName, pgTestSchemaUrl } from '@mnmal-ai/substrate-dataset-pg/testing';
import postgres, { type Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openPgDataset } from '../src/admin/dataset.js';
import { main } from '../src/admin/index.js';
import { buildOldLayout } from './_fixtures/old-layouts.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('substrate-admin before serve has booted (pg)', () => {
  let schema: string;
  let url: string;
  let sql: Sql;
  let tmp: string;

  beforeEach(async () => {
    const name = `apps/substrate-admin-layout-${randomBytes(4).toString('hex')}`;
    schema = pgTestSchemaName(name);
    url = pgTestSchemaUrl(POSTGRES_URL as string, name);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    tmp = mkdtempSync(join(tmpdir(), 'substrate-admin-layout-'));
  });

  afterEach(async () => {
    rmSync(tmp, { recursive: true, force: true });
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await sql.end({ timeout: 5 });
  });

  it('bootstrap creates _system/Key typed with its live-kid index valid, so a second live kid is refused', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      ['bootstrap'],
      { SUBSTRATE_DATABASE_URL: url, SUBSTRATE_ADMIN_KEY_PATH: join(tmp, 'admin.key') },
      (s) => out.push(s),
      (s) => err.push(s)
    );
    expect(code, err.join('')).toBe(0);

    const fields = await sql<{ field: string; state: string }[]>`
      SELECT field, state FROM substrate_type_fields
      WHERE namespace = ${SYSTEM_NAMESPACE} AND type = ${KEY_TYPE} AND field IN ('kid', 'revokedAt')
      ORDER BY field`;
    expect(fields).toEqual([
      { field: 'kid', state: 'column' },
      { field: 'revokedAt', state: 'column' }
    ]);

    const { dataset, close } = await openPgDataset({ SUBSTRATE_DATABASE_URL: url });
    try {
      const storage = await (
        dataset as unknown as {
          describeStorage(t: string): Promise<{ indexes: { name: string; state: string }[] }>;
        }
      ).describeStorage(KEY_TYPE);
      expect(storage.indexes).toContainEqual(
        expect.objectContaining({ name: 'substrate_key_live_kid_uniq', state: 'valid' })
      );
      const key = (id: string) => ({
        id,
        kid: 'dup@host',
        name: id,
        algorithm: 'EdDSA',
        publicKey: 'pk',
        namespaces: '*',
        capabilities: 'read',
        revokedAt: null
      });
      await dataset.write(KEY_TYPE, [key(randomUUID())]);
      await expect(dataset.write(KEY_TYPE, [key(randomUUID())])).rejects.toMatchObject({
        code: 'unique_violation'
      });
    } finally {
      await close();
    }
  });

  for (const layout of ['legacy', 'partitioned'] as const) {
    it(`refuses a ${layout} store with UnsupportedStoreLayoutError naming migrate-store`, async () => {
      await buildOldLayout(sql, layout);
      const err = await openPgDataset({ SUBSTRATE_DATABASE_URL: url }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnsupportedStoreLayoutError);
      expect((err as Error).message).toContain('`substrate-admin migrate-store`');
    });
  }
});
