/**
 * A walk read cancelled by the statement timeout is refused `query_timeout`;
 * one cancelled by its caller stays an AbortError. The read is held up on a
 * lock another connection owns, so it is slow without any test-only SQL function.
 */

import { randomBytes } from 'node:crypto';
import {
  QUERY_TIMEOUT,
  type ReadParams,
  ResolverFrameError,
  type WhereClause
} from '@mnmal-ai/substrate-types';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDataset } from '../src/index.js';
import { runMigrations } from '../src/migrate.js';
import { dropNamespace, relationOf } from './_layout.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const NS = `walk_timeout_${randomBytes(4).toString('hex')}`;
const TIMEOUT_MS = 200;
const WALK = { _walk: { in: `${NS}/Observation.cert` } } as unknown as WhereClause;

describe.skipIf(!POSTGRES_URL)('read timeout (pg)', () => {
  let sql: ReturnType<typeof postgres>;
  let reader: ReturnType<typeof postgres>;
  let locker: ReturnType<typeof postgres>;
  let ds: PgDataset;

  beforeAll(async () => {
    if (!POSTGRES_URL) return;
    sql = postgres(POSTGRES_URL, { onnotice: () => {} });
    await runMigrations(sql);
    reader = postgres(POSTGRES_URL, { max: 1, onnotice: () => {} });
    locker = postgres(POSTGRES_URL, { max: 1, onnotice: () => {} });
    ds = new PgDataset({ namespace: NS, sql: reader, statementTimeoutMs: TIMEOUT_MS });
    for (const type of ['Cert', 'Observation']) await ds.ensureTypeStorage(type);
    await ds.read('Cert', {}); // warms the layout cache before the lock is taken
  });

  afterAll(async () => {
    if (!POSTGRES_URL) return;
    await dropNamespace(sql, NS);
    await Promise.all([sql.end(), reader.end(), locker.end()]);
  });

  /** Runs `fn` while another connection holds an exclusive lock on Cert's rows. */
  async function underLock(fn: () => Promise<void>): Promise<void> {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    let locked: () => void = () => {};
    const gotLock = new Promise<void>((r) => (locked = r));
    const holder = locker.begin(async (tx) => {
      await tx.unsafe(`LOCK TABLE ${await relationOf(tx, NS, 'Cert')} IN ACCESS EXCLUSIVE MODE`);
      locked();
      await held;
    });
    await gotLock;
    try {
      await fn();
    } finally {
      release();
      await holder;
    }
  }

  it('refuses a plain read under a role-style statement_timeout as query_timeout, no timeoutMs', async () => {
    // A session-level setting stands in for a role or database one: substrate did not set it.
    const limited = postgres(POSTGRES_URL as string, {
      max: 1,
      onnotice: () => {},
      connection: { statement_timeout: TIMEOUT_MS }
    });
    try {
      const plain = new PgDataset({ namespace: NS, sql: limited });
      await plain.read('Cert', {});
      await underLock(async () => {
        const err = await plain.read('Cert', {}).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ResolverFrameError);
        expect(err).toMatchObject({ code: QUERY_TIMEOUT });
        expect((err as ResolverFrameError).details).toBeUndefined();
      });
      await expect(plain.read('Cert', {})).resolves.toMatchObject({ rows: [] });
    } finally {
      await limited.end();
    }
  });

  it('refuses a walk read that outlives the statement timeout as query_timeout', async () => {
    await underLock(async () => {
      const err = await ds.read('Cert', { where: WALK }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ResolverFrameError);
      expect(err).toMatchObject({ code: QUERY_TIMEOUT, details: { timeoutMs: TIMEOUT_MS } });
    });
    expect((await ds.read('Cert', {})).rows).toEqual([]);
  });

  it('refuses walk projections and a far-row shortId walk that outlive it as query_timeout', async () => {
    const reads: ReadParams[] = [
      {
        nested: { obs: { _walk: { in: `${NS}/Observation.cert` }, fields: { id: true } } } as never
      },
      { agg: { n: { in: `${NS}/Observation.cert`, count: true } } as never },
      { where: { _walk: { in: `${NS}/Observation.cert`, where: { shortId: { eq: 1 } } } } as never }
    ];
    await underLock(async () => {
      for (const params of reads) {
        const err = await ds.read('Cert', params).catch((e: unknown) => e);
        expect(err, JSON.stringify(params)).toBeInstanceOf(ResolverFrameError);
        expect(err).toMatchObject({ code: QUERY_TIMEOUT, details: { timeoutMs: TIMEOUT_MS } });
      }
    });
  });

  it('runs a select read under the statement timeout too', async () => {
    await underLock(async () => {
      const err = await ds
        .read('Cert', { select: { two: { add: [1, 1] } } })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: QUERY_TIMEOUT, details: { timeoutMs: TIMEOUT_MS } });
    });
  });

  it('keeps a caller abort an AbortError, not query_timeout', async () => {
    await underLock(async () => {
      const controller = new AbortController();
      const pending = ds.read('Cert', { where: WALK, signal: controller.signal });
      const outcome = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      setTimeout(() => controller.abort(), 50);
      await outcome;
    });
  });
});
