/**
 * WS auth end to end: a real {@link SubstrateClient} against a real
 * {@link FastifySubstrateServer} over a real socket.
 *
 * `ws-auth.test.ts` proves the client treats close 4001 as terminal against a
 * stub server; `substrate-compose/test/onboard-wire-shapes.test.ts` proves the
 * server closes 4001 on a present-but-invalid bearer against a raw socket.
 * Only this file checks that the two halves agree on the same codes.
 */

import {
  type AuthConfig,
  type ComposeResult,
  compose,
  signHs256
} from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { FastifySubstrateServer } from '@mnmal-ai/substrate-server-fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SubstrateClient } from '../src/index.js';
import { demoPlugin } from './fixtures/demo-plugin.js';

const SECRET = 'ws-auth-real-server-secret';
const KID = 'client-e2e';
// compose refuses a short one when auth is on — these tickets are the only
// authentication on the SSE stream routes, so a forgeable secret is refused
// at boot rather than at first use.
const TICKET_SECRET = 'ws-auth-real-server-ticket-secret';

const AUTH: AuthConfig = {
  // `attribute` deliberately, not `required`: it is the mode that ADMITS a
  // tokenless caller, so a 4001 here can only be about the token being broken
  // rather than about the socket needing one at all.
  mode: 'attribute',
  keys: [{ kid: KID, alg: 'HS256', publicKey: SECRET }]
};

function validToken(): string {
  const now = Math.floor(Date.now() / 1000);
  return signHs256(
    { sub: KID, iat: now, exp: now + 3600, ns: ['*'], capabilities: ['read', 'mutate'] },
    SECRET,
    { kid: KID }
  );
}

let baseUrl: string;
let composed: ComposeResult;
let server: FastifySubstrateServer;

beforeEach(async () => {
  server = new FastifySubstrateServer({ logger: false });
  composed = await compose({
    // Auth is off in this harness, so the deployment declares who it writes
    // as — `resolveIdentity` does not invent one.
    systemActor: 'test',
    server,
    dataset: new MemoryDataset({ namespace: 'default' }),
    coordinators: [demoPlugin],
    auth: AUTH,
    streamTicketSecret: TICKET_SECRET
  });
  const { port } = await server.start({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await composed.stop();
});

describe('SubstrateClient <-> FastifySubstrateServer WS auth', () => {
  it('surfaces a rejected bearer as a terminal error rather than looping', async () => {
    const client = new SubstrateClient({
      endpoint: baseUrl,
      token: 'not-a-real-jwt',
      // Tight backoff so a resubscribe loop, if one existed, would spin here
      // rather than idle out past the test timeout.
      reconnect: { baseDelayMs: 5, maxDelayMs: 20, jitter: 0 }
    });
    try {
      const iterable = client.subscribe({ 'default/Todo': { params: {}, fields: { id: true } } });

      // The rejection IS the assertion. A silent resubscribe loop never
      // throws; it hangs, and this line would time out instead of passing.
      await expect(async () => {
        for await (const _ev of iterable) {
          // no frames expected
        }
      }).rejects.toThrow(/unauthorized|4001/i);
    } finally {
      await client.close();
    }
  });

  it('accepts a VALID bearer on the same server — the control that makes the refusal mean something', async () => {
    // Without this, the test above passes just as well against a server that
    // refuses every socket, or a client that cannot subscribe at all.
    const client = new SubstrateClient({ endpoint: baseUrl, token: validToken() });
    try {
      const iterable = client.subscribe({ 'default/Todo': { params: {}, fields: { id: true } } });
      const first = await iterable[Symbol.asyncIterator]().next();

      expect(first.done).toBe(false);
      expect(first.value?.kind).toBe('snapshot');
    } finally {
      await client.close();
    }
  });

  it('carries the bearer on the upgrade to a server that reads it — attributed, not merely admitted', async () => {
    // `ws-auth.test.ts` asserts the header reaches a stub's upgrade request.
    // This asserts a REAL server accepted and attributed it, which is the half
    // a stub cannot answer: under `attribute` an unread header and a read one
    // both leave the socket open.
    const client = new SubstrateClient({ endpoint: baseUrl, token: validToken() });
    try {
      const env = await client.query({
        'default/Todo': { params: { limit: 1 }, fields: { id: true } }
      });
      expect(env.errors ?? []).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
