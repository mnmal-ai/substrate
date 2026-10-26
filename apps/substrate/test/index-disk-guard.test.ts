/**
 * `SUBSTRATE_INDEX_DISK_PATH` as `runServe` reads it: `off` passes no guard,
 * so the storage report (what doctor's storage check reads) stays clean;
 * unset passes a pathless guard that warns checks are off; a path that cannot
 * be statted fails the boot naming the variable.
 *
 * The storage cases are skipped unless POSTGRES_URL is set.
 */

import { randomUUID } from 'node:crypto';
import { PgDataset, runMigrations } from '@mnmal-ai/substrate-dataset-pg';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { indexDiskGuard } from '../src/serve/compose-opts.js';
import { EnvConfigError } from '../src/serve/config.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const OFF_LINE = /^free-disk checks before index builds are off/;

describe('indexDiskGuard', () => {
  it('passes no guard for off', async () => {
    expect(await indexDiskGuard({ indexDiskPath: 'off', indexDiskMarginMb: 2048 })).toBeUndefined();
  });

  it('passes a pathless guard when unset', async () => {
    const guard = await indexDiskGuard({ indexDiskPath: null, indexDiskMarginMb: 2048 });
    expect(guard?.path).toBeUndefined();
  });

  it('fails the boot naming the variable when the path cannot be statted', async () => {
    const missing = `/nonexistent-${randomUUID()}`;
    const boot = indexDiskGuard({ indexDiskPath: missing, indexDiskMarginMb: 2048 });
    await expect(boot).rejects.toThrow(EnvConfigError);
    await expect(boot).rejects.toThrow(`SUBSTRATE_INDEX_DISK_PATH: ${missing} is not readable`);
  });

  it('accepts a path that exists', async () => {
    const guard = await indexDiskGuard({ indexDiskPath: '/', indexDiskMarginMb: 0 });
    expect(guard?.path).toBe('/');
    expect(await guard?.check(0)).toEqual({ ok: true });
  });
});

describe.skipIf(!POSTGRES_URL)('the disk-check warning in the storage report (pg)', () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string, { onnotice: () => {} });
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  async function report(indexDiskPath: 'off' | null) {
    const guard = await indexDiskGuard({ indexDiskPath, indexDiskMarginMb: 2048 });
    const ds = new PgDataset({
      namespace: `kdisk_${randomUUID().slice(0, 8)}`,
      sql,
      ...(guard !== undefined ? { diskGuard: guard } : {})
    });
    return ds.storageReport({ partitionBudget: 1e6 });
  }

  it('off: no warning, so doctor storage passes', async () => {
    const r = await report('off');
    expect(r.warnings.filter((w) => OFF_LINE.test(w))).toEqual([]);
    // Doctor's storage check passes exactly when warnings is empty; legacy has no others.
    if (r.layout === 'legacy') expect(r.warnings).toEqual([]);
  });

  it('unset: warns that disk checks are off', async () => {
    expect((await report(null)).warnings.filter((w) => OFF_LINE.test(w))).toHaveLength(1);
  });
});
