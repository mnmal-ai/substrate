/**
 * The free-disk guard: its arithmetic over an injected statfs, then, against
 * Postgres, a refused non-unique build or swap leaving the index absent or
 * the old one in place, reported `pending` (`insufficient_disk`).
 *
 * The pg cases are skipped unless POSTGRES_URL is set.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { IndexDecl } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DiskGuard, makeDiskGuard } from '../src/disk-guard.js';
import { PgDataset } from '../src/index.js';

const MB = 1024 * 1024;
const fs = (freeMb: number) => async () => ({ bavail: BigInt(freeMb * 256), bsize: 4096n });

describe('makeDiskGuard', () => {
  it('allows a build that leaves at least the margin free', async () => {
    const guard = makeDiskGuard({ path: '/data', marginBytes: 100 * MB, statfs: fs(300) });
    expect(await guard.check(200 * MB)).toEqual({ ok: true });
  });

  it('refuses one that would eat into the margin, with both numbers', async () => {
    const guard = makeDiskGuard({ path: '/data', marginBytes: 100 * MB, statfs: fs(300) });
    expect(await guard.check(200 * MB + 1)).toEqual({
      ok: false,
      freeBytes: 300 * MB,
      needBytes: 300 * MB + 1
    });
  });

  it('with a zero margin requires only the estimate itself', async () => {
    const guard = makeDiskGuard({ path: '/data', marginBytes: 0, statfs: fs(300) });
    expect(await guard.check(300 * MB)).toEqual({ ok: true });
    expect((await guard.check(300 * MB + 1)).ok).toBe(false);
  });

  it('always allows when no path is set, and never stats', async () => {
    const guard = makeDiskGuard({
      marginBytes: 100 * MB,
      statfs: () => Promise.reject(new Error('statfs called'))
    });
    expect(guard.path).toBeUndefined();
    expect(await guard.check(Number.MAX_SAFE_INTEGER)).toEqual({ ok: true });
  });
});

const POSTGRES_URL = process.env.POSTGRES_URL;
const TYPE = 'T';
let sql: Sql;

beforeAll(async () => {
  if (POSTGRES_URL) sql = postgres(POSTGRES_URL, { onnotice: () => {} });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/** A guard that records each estimate and allows builds only while `allow` is set. */
function switchGuard(): DiskGuard & { allow: boolean; estimates: number[] } {
  return {
    path: '/var/lib/postgresql',
    allow: true,
    estimates: [],
    async check(estimateBytes) {
      this.estimates.push(estimateBytes);
      return this.allow ? { ok: true } : { ok: false, freeBytes: 1, needBytes: estimateBytes + 1 };
    }
  };
}

function fixture(diskGuard: DiskGuard) {
  const ns = `dg_${randomBytes(4).toString('hex')}`;
  const unique = `${ns}_kid_uq`;
  const plain = `${ns}_cert_ix`;
  const declared: { indexes: IndexDecl[] } = {
    indexes: [
      { fields: ['kid'], unique: true, where: 'live', name: unique },
      { fields: ['cert'], name: plain }
    ]
  };
  const ds = new PgDataset({
    namespace: ns,
    sql,
    diskGuard,
    typeDefLookup: () => ({
      fields: {
        kid: { kind: 'scalar', type: 'string' },
        cert: { kind: 'scalar', type: 'string' }
      },
      indexes: declared.indexes
    })
  });
  return { ns, ds, unique, plain, declared };
}

async function indexDef(name: string): Promise<string | undefined> {
  const [row] = await sql<Array<{ def: string }>>`
    SELECT pg_get_indexdef(to_regclass(${name})) AS def WHERE to_regclass(${name}) IS NOT NULL`;
  return row?.def;
}

const described = async (ds: PgDataset, name: string) =>
  (await ds.describeStorage(TYPE)).indexes.find((i) => i.name === name);

describe.skipIf(!POSTGRES_URL)('free-disk check before background index builds', () => {
  it('leaves a refused build absent and pending, while unique builds and reads go on', async () => {
    const guard = switchGuard();
    guard.allow = false;
    const { ns, ds, unique, plain } = fixture(guard);
    await ds.ensureTypeStorage(TYPE);
    expect(await indexDef(unique)).toBeDefined();
    expect(await indexDef(plain)).toBeUndefined();
    expect(await described(ds, plain)).toMatchObject({
      state: 'pending',
      reason: 'insufficient_disk'
    });
    expect((await ds.storageReport({ partitionBudget: 1e6 })).warnings).toContain(
      `index ${plain} on ${ns}/${TYPE} is pending (insufficient_disk): filters it would serve scan until it is valid`
    );
    const id = randomUUID();
    await ds.write(TYPE, [{ id, kid: 'k1', cert: 'c1' }]);
    expect((await ds.read(TYPE, { where: { cert: { eq: 'c1' } } })).rows.map((r) => r.id)).toEqual([
      id
    ]);

    // The next pass, with room, builds it.
    guard.allow = true;
    await ds.ensureTypeStorage(TYPE, { indexes: 'nonUnique' });
    expect(await indexDef(plain)).toBeDefined();
    expect((await described(ds, plain))?.state).toBe('valid');
    expect((await described(ds, plain))?.reason).toBeUndefined();
  });

  it('keeps the old index in place when a swap is refused, estimating from its size', async () => {
    const guard = switchGuard();
    const { ds, plain, declared } = fixture(guard);
    await ds.ensureTypeStorage(TYPE);
    const before = await indexDef(plain);
    expect(before).toBeDefined();

    declared.indexes = [
      { fields: ['kid'], unique: true, where: 'live', name: declared.indexes[0]?.name as string },
      { fields: ['cert'], where: { kid: null }, name: plain }
    ];
    guard.allow = false;
    guard.estimates.length = 0;
    await ds.ensureTypeStorage(TYPE, { indexes: 'nonUnique' });
    expect(await indexDef(plain)).toBe(before);
    expect(await described(ds, plain)).toMatchObject({
      state: 'pending',
      reason: 'insufficient_disk'
    });
    const [size] = await sql<Array<{ n: string }>>`
      SELECT pg_relation_size(to_regclass(${plain}))::text AS n`;
    expect(guard.estimates).toEqual([Number(size?.n)]);
  });

  it('says disk checks are off when the guard has no path', async () => {
    const { ds } = fixture(makeDiskGuard({ marginBytes: 0 }));
    expect((await ds.storageReport({ partitionBudget: 1e6 })).warnings).toContain(
      'free-disk checks before index builds are off: set SUBSTRATE_INDEX_DISK_PATH to the database volume'
    );
  });
});
