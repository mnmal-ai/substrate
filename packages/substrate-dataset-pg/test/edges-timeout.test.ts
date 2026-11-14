/**
 * #1836: an edges-store query cancelled by a role- or database-level
 * statement_timeout is refused `query_timeout`, not a raw 57014 (a 500). The
 * query is held up on a lock another connection owns.
 */

import { QUERY_TIMEOUT, ResolverFrameError } from '@mnmal-ai/substrate-types';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgEdgesStore } from '../src/index.js';
import { runMigrations } from '../src/migrate.js';

const POSTGRES_URL = process.env.POSTGRES_URL;
const TIMEOUT_MS = 200;
const REF = { ns: 'edges_timeout', type: 'T', id: 'r1' };

describe.skipIf(!POSTGRES_URL)('edges store timeout (pg)', () => {
  let sql: ReturnType<typeof postgres>;
  let limited: ReturnType<typeof postgres>;
  let locker: ReturnType<typeof postgres>;
  let edges: PgEdgesStore;

  beforeAll(async () => {
    if (!POSTGRES_URL) return;
    sql = postgres(POSTGRES_URL, { onnotice: () => {} });
    await runMigrations(sql);
    // A session-level setting stands in for a role or database one.
    limited = postgres(POSTGRES_URL, {
      max: 1,
      onnotice: () => {},
      connection: { statement_timeout: TIMEOUT_MS }
    });
    locker = postgres(POSTGRES_URL, { max: 1, onnotice: () => {} });
    edges = new PgEdgesStore({ sql: limited });
  });

  afterAll(async () => {
    if (!POSTGRES_URL) return;
    await sql`DELETE FROM edges WHERE from_ns = ${REF.ns} OR to_ns = ${REF.ns}`;
    await Promise.all([sql.end(), limited.end(), locker.end()]);
  });

  async function underLock(fn: () => Promise<void>): Promise<void> {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    let locked: () => void = () => {};
    const gotLock = new Promise<void>((r) => (locked = r));
    const holder = locker.begin(async (tx) => {
      await tx`LOCK TABLE edges IN ACCESS EXCLUSIVE MODE`;
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

  it('refuses a read and a write held past the statement timeout as query_timeout', async () => {
    await underLock(async () => {
      for (const attempt of [
        () => edges.findEdgesTo(REF),
        () => edges.write({ from: REF, to: REF, fieldName: 'f', policy: 'orphan' })
      ]) {
        const err = await attempt().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ResolverFrameError);
        expect(err).toMatchObject({ code: QUERY_TIMEOUT });
        expect((err as ResolverFrameError).details).toBeUndefined();
      }
    });
    await expect(edges.findEdgesTo(REF)).resolves.toEqual([]);
  });
});
