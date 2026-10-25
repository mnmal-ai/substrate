/**
 * Non-unique index builds deferred past boot: `ensureTypeStorage` with
 * `indexes: 'unique'` builds only the unique ones and reports the rest
 * `pending`; `nonUnique` builds them, reported `building` meanwhile, in
 * `describeStorage` and `storageReport` alike; and a cancelled build leaves an
 * INVALID index that the next reconcile drops and rebuilds.
 *
 * A build is held open by a second connection's uncommitted write, which
 * CREATE INDEX CONCURRENTLY waits for.
 *
 * Skipped unless POSTGRES_URL is set.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { IndexDecl } from '@mnmal-ai/substrate-types';
import postgres, { type ReservedSql, type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const TYPE = 'T';

let sql: Sql;

beforeAll(async () => {
  if (POSTGRES_URL) sql = postgres(POSTGRES_URL, { onnotice: () => {} });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

function fixture() {
  const ns = `dib_${randomBytes(4).toString('hex')}`;
  const unique = `${ns}_kid_uq`;
  const plain = `${ns}_cert_ix`;
  const indexes: IndexDecl[] = [
    { fields: ['kid'], unique: true, where: 'live', name: unique },
    { fields: ['cert'], name: plain }
  ];
  const ds = new PgDataset({
    namespace: ns,
    sql,
    typeDefLookup: () => ({
      fields: {
        kid: { kind: 'scalar', type: 'string' },
        cert: { kind: 'scalar', type: 'string' }
      },
      indexes
    })
  });
  return { ns, ds, unique, plain };
}

async function catalogValid(name: string): Promise<boolean | undefined> {
  const [row] = await sql<Array<{ valid: boolean }>>`
    SELECT indisvalid AND indisready AS valid FROM pg_index WHERE indexrelid = to_regclass(${name})`;
  return row?.valid;
}

const stateOf = async (ds: PgDataset, name: string) =>
  (await ds.describeStorage(TYPE)).indexes.find((i) => i.name === name)?.state;

/** The index whose build is running; on the partitioned layout the engine's own come first. */
const building = async (ds: PgDataset) =>
  (await ds.describeStorage(TYPE)).indexes.find((i) => i.state === 'building')?.name;

/** An uncommitted write of the type, which every concurrent build waits for until released. */
async function holdBuilds(ns: string): Promise<{ release(): Promise<void> }> {
  const conn: ReservedSql = await sql.reserve();
  await conn`BEGIN`;
  await conn`INSERT INTO rows (namespace, type, id, body)
    VALUES (${ns}, ${TYPE}, ${randomUUID()}, ${sql.json({ kid: randomUUID() })})`;
  return {
    async release() {
      await conn`COMMIT`;
      conn.release();
    }
  };
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe.skipIf(!POSTGRES_URL)('deferred non-unique index builds', () => {
  it('builds unique indexes first, leaving the rest pending, then building, then valid', async () => {
    const { ns, ds, unique, plain } = fixture();
    await ds.ensureTypeStorage(TYPE, { indexes: 'unique' });
    expect(await catalogValid(unique)).toBe(true);
    expect(await catalogValid(plain)).toBeUndefined();
    expect(await stateOf(ds, unique)).toBe('valid');
    expect(await stateOf(ds, plain)).toBe('pending');
    const report = async () => (await ds.storageReport({ partitionBudget: 1e6 })).warnings;
    expect(await report()).toContain(
      `index ${plain} on ${ns}/${TYPE} is pending: filters it would serve scan until it is valid`
    );

    const hold = await holdBuilds(ns);
    const built = ds.ensureTypeStorage(TYPE, { indexes: 'nonUnique' });
    try {
      await until(async () => (await building(ds)) !== undefined, 'a build to start');
      const running = (await building(ds)) as string;
      expect(await report()).toContain(
        `index ${running} on ${ns}/${TYPE} is building: filters it would serve scan until it is valid`
      );
      expect(['pending', 'building']).toContain(await stateOf(ds, plain));
    } finally {
      await hold.release();
    }
    await built;
    expect(await catalogValid(plain)).toBe(true);
    expect(await stateOf(ds, plain)).toBe('valid');
    expect((await report()).some((w) => w.includes(plain))).toBe(false);
  }, 30_000);

  it('a cancelled build leaves an INVALID index that the next reconcile rebuilds', async () => {
    const { ns, ds } = fixture();
    await ds.ensureTypeStorage(TYPE, { indexes: 'unique' });
    const hold = await holdBuilds(ns);
    const abort = new AbortController();
    const built = ds.ensureTypeStorage(TYPE, { indexes: 'nonUnique', signal: abort.signal });
    let cancelled = '';
    try {
      // The catalog entry exists once the build is waiting.
      await until(async () => {
        cancelled = (await building(ds)) ?? '';
        return cancelled !== '' && (await catalogValid(cancelled)) === false;
      }, 'the build to start');
      abort.abort();
      await built;
    } finally {
      await hold.release();
    }
    expect(await catalogValid(cancelled)).toBe(false);
    expect(await stateOf(ds, cancelled)).toBe('failed');

    await ds.ensureTypeStorage(TYPE, { indexes: 'nonUnique' });
    expect(await catalogValid(cancelled)).toBe(true);
    expect(await stateOf(ds, cancelled)).toBe('valid');
  }, 30_000);
});
