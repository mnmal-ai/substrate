/**
 * Federation enrollment acceptance test.
 *
 * pg-gated, and the gating is the point: `runEnroll` writes the invite row
 * direct-to-pg exactly as the CLI does, and the SAME database backs the
 * composed server that redeems it. A memory dataset would skip the one seam
 * that matters — that the CLI and the running binary agree on the `_system`
 * store.
 *
 * `runJoin` is driven through an adapter that forwards to `server.inject`
 * rather than a listening socket. That exercises all of runJoin (keypair,
 * request shape, response mapping, file write, failure ordering) without
 * binding a port. The bridged-read half — that an issued credential resolves
 * a federated query with `_completeness` absent — is covered by
 * bridges.test.ts and the two-instance verification in
 * ops/commodity/federation.md; duplicating it here would add a second full
 * server for no new coverage.
 *
 * POSTGRES_URL must name a *_test / *_dev database; `test/_setup.ts` refuses
 * anything production-looking before this file loads.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import {
  type ComposeResult,
  compose,
  KEY_TYPE,
  SYSTEM_NAMESPACE,
  signEdDSA
} from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { PgDataset, runMigrations } from '@mnmal-ai/substrate-dataset-pg';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { SubstrateResponse } from '@mnmal-ai/substrate-types';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPgDataset } from '../src/admin/dataset.js';
import { runEnroll } from '../src/cli/federate/enroll.js';
import type { HttpJsonFn } from '../src/cli/federate/http.js';
import { runJoin } from '../src/cli/federate/join.js';
import { fixturePlugin } from './_fixtures/fixture-plugin.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

/** The origin baked into the token. Never dialled — inject() answers instead. */
const ORIGIN = 'https://callee.test';

function bodyToString(res: SubstrateResponse): string {
  const b = res.body;
  if (b === undefined || b === null) return '';
  if (typeof b === 'string') return b;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  if (b instanceof Uint8Array) return Buffer.from(b).toString('utf8');
  return '';
}

describe.skipIf(!POSTGRES_URL)('federation enrollment end to end', () => {
  let sql: Sql;
  let server: MemorySubstrateServer;
  let composed: ComposeResult;
  let dir: string;

  /**
   * Forward runJoin's HTTP call into the composed server via `inject()`.
   * `MemorySubstrateServer.inject` takes `path` (not `url`) and a `Buffer | null`
   * `body` (not `payload`) — see `_system-routes.test.ts`'s `post` helper.
   */
  const inject: HttpJsonFn = async (url, opts) => {
    const headers: Record<string, string> = { ...opts?.headers };
    let body: Buffer | null = null;
    if (opts?.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = Buffer.from(JSON.stringify(opts.body), 'utf8');
    }
    const res = await server.inject({
      method: opts?.method ?? 'GET',
      path: url.slice(ORIGIN.length),
      headers,
      ...(body !== null ? { body } : {})
    });
    const raw = bodyToString(res);
    let parsedBody: unknown;
    try {
      parsedBody = raw.length > 0 ? JSON.parse(raw) : undefined;
    } catch {
      parsedBody = undefined;
    }
    return { status: res.status, body: parsedBody, raw };
  };

  beforeAll(async () => {
    dir = mkdtempSync(pathJoin(tmpdir(), 'federate-e2e-'));
    // `POSTGRES_URL` is defined here — describe.skipIf skipped the suite otherwise.
    sql = postgres(POSTGRES_URL as string);
    await runMigrations(sql);
    server = new MemorySubstrateServer();
    composed = await compose({
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'demo' }),
      // The `_system` override is what puts the CLI and the server on the same
      // store — without it compose allocates its own in-memory `_system`.
      datasets: { [SYSTEM_NAMESPACE]: new PgDataset({ namespace: SYSTEM_NAMESPACE, sql }) },
      coordinators: [fixturePlugin],
      auth: { keys: [], adminCapability: 'admin' },
      // Required whenever `auth` is set (compose throws otherwise) — signs SSE
      // stream tickets. Unused by this test but must be present and >=16 chars.
      streamTicketSecret: 'federate-e2e-test-stream-ticket-secret'
    });
    await server.start();
  });

  afterAll(async () => {
    await composed?.stop();
    await sql?.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it('mints, redeems, scopes the key to the invite, and refuses a replay', async () => {
    const enrolled = await runEnroll(
      {
        origin: ORIGIN,
        namespaces: ['demo'],
        capabilities: ['read'],
        ttlMs: 900_000
      },
      { SUBSTRATE_DATABASE_URL: POSTGRES_URL as string },
      openPgDataset,
      async () => 'enabled'
    );

    const keyOut = pathJoin(dir, 'peer.key');
    const joined = await runJoin(
      { token: enrolled.token, name: 'peer-b', keyOut },
      { httpJson: inject, hostname: () => 'caller-host' }
    );
    expect(joined.namespaces).toEqual(['demo']);
    expect(joined.capabilities).toEqual(['read']);

    // The row the callee actually stored carries the INVITE's scope, not
    // anything the caller asked for. Filter by the specific kid this test
    // minted — this database is shared with other pg-gated suites.
    const keys = await new PgDataset({ namespace: SYSTEM_NAMESPACE, sql }).read(KEY_TYPE, {
      where: { kid: { eq: joined.kid } },
      limit: 1
    });
    expect(keys.rows[0]?.namespaces).toBe('demo');
    expect(keys.rows[0]?.capabilities).toBe('read');

    // whoami reports the INTERSECTION: the token below over-claims (wildcard
    // namespace + mutate/admin capabilities it was never granted), and the
    // row narrows it. This is the property the runbook asserts and that
    // `substrate federate check` depends on to name a scope fault.
    const privateKeyPem = readFileSync(keyOut, 'utf8');
    const overclaiming = signEdDSA(
      {
        sub: joined.kid,
        // EdDSA tokens require an explicit `exp` — verifyBearerToken
        // hard-rejects one without it.
        exp: Math.floor(Date.now() / 1000) + 60,
        ns: ['*'],
        capabilities: ['read', 'mutate', 'admin']
      },
      privateKeyPem,
      // Third arg is `{ kid }`, not a bare string.
      { kid: joined.kid }
    );
    const who = await inject(`${ORIGIN}/substrate/v1/whoami`, {
      headers: { authorization: `Bearer ${overclaiming}` }
    });
    expect(who.status).toBe(200);
    expect(who.body).toEqual({
      authEnabled: true,
      // `{ id, grants }`; the grant carries the intersection.
      identity: {
        id: joined.kid,
        grants: { demo: ['read'] }
      }
    });

    // Replay: the same token is spent. Single-use is the entire security
    // model, so this assertion is load-bearing.
    await expect(
      runJoin(
        { token: enrolled.token, name: 'peer-b', keyOut: pathJoin(dir, 'second.key') },
        { httpJson: inject, hostname: () => 'caller-host' }
      )
    ).rejects.toThrow(/single use/);
    expect(existsSync(pathJoin(dir, 'second.key'))).toBe(false);
  });
});
