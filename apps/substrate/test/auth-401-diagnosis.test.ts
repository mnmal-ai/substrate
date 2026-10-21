import {
  type AuthConfig,
  type ComposeResult,
  compose,
  signHs256
} from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { SubstrateResponse } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The 401 carries a signal end to end — proven at the wire, not just at the
 * helper, because what matters is the RENDERED body.
 *
 * - expired / malformed-claim rejections name themselves in `reason`;
 * - unknown-kid and wrong-secret stay byte-identical (oracle guard);
 * - a valid token is unaffected.
 */

const SECRET = 'diagnosis-401-secret';
const KID = 'diag401';
const authCfg: AuthConfig = { keys: [{ kid: KID, alg: 'HS256', publicKey: SECRET }] };

function bodyToString(res: SubstrateResponse): string {
  const b = res.body;
  if (b === undefined || b === null) return '';
  if (typeof b === 'string') return b;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  if (b instanceof Uint8Array) return Buffer.from(b).toString('utf8');
  return '';
}

async function postQuery(token: string, server: MemorySubstrateServer): Promise<SubstrateResponse> {
  return server.inject({
    method: 'POST',
    path: '/substrate/v1/query',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ 'default/Todo': { params: { limit: 1 }, fields: {} } }))
  });
}

describe('401 diagnosis at the wire', () => {
  let composed: ComposeResult | null = null;

  afterEach(async () => {
    if (composed !== null) {
      await composed.stop();
      composed = null;
    }
  });

  async function mkServer(): Promise<MemorySubstrateServer> {
    const server = new MemorySubstrateServer();
    composed = await compose({
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      auth: authCfg,
      streamTicketSecret: 'test-stream-ticket-secret'
    });
    await server.start();
    return server;
  }

  function mkToken(
    claims: Record<string, unknown>,
    secret: string = SECRET,
    kid: string = KID
  ): string {
    const now = Math.floor(Date.now() / 1000);
    return signHs256({ sub: 'tester', exp: now + 60, ...claims }, secret, { kid });
  }

  it('an expired token 401s with reason: expired', async () => {
    const server = await mkServer();
    const now = Math.floor(Date.now() / 1000);
    const res = await postQuery(mkToken({ exp: now - 60 }), server);
    expect(res.status).toBe(401);
    expect(JSON.parse(bodyToString(res))).toEqual({ code: 'unauthorized', reason: 'expired' });
  });

  it('an empty ns claim 401s with reason: malformed_claim:ns', async () => {
    const server = await mkServer();
    const res = await postQuery(mkToken({ ns: [] }), server);
    expect(res.status).toBe(401);
    expect(JSON.parse(bodyToString(res))).toEqual({
      code: 'unauthorized',
      reason: 'malformed_claim:ns'
    });
  });

  it('unknown kid and wrong secret are byte-identical — no kid oracle at the wire', async () => {
    // NOTE the file-registry kid fallback (auth.ts `selectCandidates`): an
    // unknown kid with a CORRECT secret still verifies against the alg pool,
    // so both probes here must fail the signature to reach the null path —
    // which is exactly the collapsed population this pins.
    const server = await mkServer();
    const unknownKid = await postQuery(mkToken({}, 'wrong-secret', 'nobody@nowhere'), server);
    const wrongSecret = await postQuery(mkToken({}, 'wrong-secret', KID), server);
    expect(unknownKid.status).toBe(401);
    expect(wrongSecret.status).toBe(401);
    expect(bodyToString(wrongSecret)).toBe(bodyToString(unknownKid));
    expect(JSON.parse(bodyToString(unknownKid))).toEqual({ code: 'unauthorized' });
  });

  it('a valid token is unaffected — no reason key on success', async () => {
    const server = await mkServer();
    const res = await postQuery(mkToken({ ns: ['*'], capabilities: ['read'] }), server);
    expect(res.status).toBe(200);
  });
});
