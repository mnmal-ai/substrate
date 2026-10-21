/**
 * A tokenless 401 names itself, at the wire.
 *
 * "You sent nothing" must not render as a bare `{ code: 'unauthorized' }`, or
 * a credential problem surfaces to an unattended caller as "substrate offline"
 * rather than as an auth problem.
 *
 * THE LINE THIS SUITE HOLDS. Enriching the tokenless refusal must not enrich
 * the REJECTED-CREDENTIAL one: unknown-kid and bad-signature stay byte-
 * identical on purpose, because distinguishing them tells an attacker which
 * kids exist. There is no oracle in describing a request that was never made.
 * The last two cases here guard that.
 *
 * At the wire rather than at `withAuth`, because the RENDERED body is what
 * the caller sees — the same reason auth-401-diagnosis.test.ts composes a
 * server.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { SubstrateResponse } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';
import { type AuthConfig, signHs256 } from '../src/auth.js';
import { compose } from '../src/compose.js';

const SECRET = 'tokenless-401-secret';
const KID = 'tokenless401';
const TICKET_SECRET = 'tokenless-401-ticket-secret';

function authCfg(mode: 'required' | 'attribute'): AuthConfig {
  return { mode, keys: [{ kid: KID, alg: 'HS256', publicKey: SECRET }] };
}

function bodyOf(res: SubstrateResponse): Record<string, unknown> {
  const b = res.body;
  const text = Buffer.isBuffer(b) ? b.toString('utf8') : String(b ?? '');
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
}

let server: MemorySubstrateServer | null = null;

async function start(mode: 'required' | 'attribute'): Promise<MemorySubstrateServer> {
  server = new MemorySubstrateServer();
  await compose({
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    auth: authCfg(mode),
    streamTicketSecret: TICKET_SECRET
  });
  await server.start();
  return server;
}

afterEach(async () => {
  await server?.stop?.({ grace: 0 });
  server = null;
});

const QUERY_BODY = Buffer.from(
  JSON.stringify({ 'default/Todo': { params: { limit: 1 }, fields: {} } })
);
const MUTATE_BODY = Buffer.from(
  JSON.stringify({ 'default/createTodo': { params: { title: 'x' }, fields: {} } })
);

describe('the tokenless refusal says which fault it is', () => {
  it('names the absent credential on an anonymous WRITE under attribute mode', async () => {
    const srv = await start('attribute');

    const res = await srv.inject({
      method: 'POST',
      path: '/substrate/v1/mutate',
      headers: { 'content-type': 'application/json' },
      body: MUTATE_BODY
    });
    const body = bodyOf(res);

    expect(res.status).toBe(401);
    expect(body.code).toBe('unauthorized');
    expect(String(body.detail)).toContain('no Authorization header was sent');
    // The caller is refused everywhere; being told so is not evidence that
    // nothing will talk to them. Name the route that answers regardless —
    // and not /substrate/v1/onboard, which needs a key once auth is on.
    expect(String(body.detail)).toContain('/substrate/v1/whoami');
    expect(String(body.detail)).not.toContain('/substrate/v1/onboard');
    // `reason` belongs to a REJECTED credential. There is none to diagnose.
    expect(body).not.toHaveProperty('reason');
  });

  it('names it on a tokenless READ under required mode', async () => {
    const srv = await start('required');

    const res = await srv.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: QUERY_BODY
    });

    expect(res.status).toBe(401);
    expect(String(bodyOf(res).detail)).toContain('no Authorization header was sent');
  });

  /**
   * The posture this change must NOT quietly alter: closing anonymous reads is
   * a separate, gated decision, so a tokenless read under attribute mode is
   * still admitted.
   */
  it('still ADMITS a tokenless read under attribute mode', async () => {
    const srv = await start('attribute');

    const res = await srv.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { 'content-type': 'application/json' },
      body: QUERY_BODY
    });

    expect(res.status).toBe(200);
  });

  it('leaves an unknown kid bare — no detail, no kid oracle', async () => {
    // The signature must FAIL to reach the null path. `selectCandidates` falls
    // back to the alg pool when the kid is unknown, so an unknown kid with the
    // CORRECT secret still verifies — and then fails the capability check with
    // 403, which is a different answer to a different question. Same reason
    // auth-401-diagnosis.test.ts signs both of its probes with a wrong secret.
    const srv = await start('required');
    const token = signHs256(
      { sub: 'nobody', exp: Math.floor(Date.now() / 1000) + 300 },
      'wrong-secret',
      {
        kid: 'a-kid-this-server-has-never-heard-of'
      }
    );

    const res = await srv.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: QUERY_BODY
    });

    expect(res.status).toBe(401);
    // Byte-identical to what it was: a rejected credential learns nothing new.
    expect(bodyOf(res)).toEqual({ code: 'unauthorized' });
  });

  it('still names an expired token in reason, without a detail', async () => {
    const srv = await start('required');
    const token = signHs256(
      { sub: 'expired-caller', exp: Math.floor(Date.now() / 1000) - 60 },
      SECRET,
      {
        kid: KID
      }
    );

    const res = await srv.inject({
      method: 'POST',
      path: '/substrate/v1/query',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: QUERY_BODY
    });
    const body = bodyOf(res);

    expect(res.status).toBe(401);
    expect(body.reason).toBe('expired');
    expect(body).not.toHaveProperty('detail');
  });
});
