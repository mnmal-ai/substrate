/**
 * `GET /substrate/v1/config` — the knob report over the wire.
 *
 * Answers on demand what a RUNNING process resolved each knob to; the
 * environment is only the input.
 *
 * ADMIN-GATED, unlike `/substrate/v1/metrics`: this says how a deployment is BUILT
 * (store kind, auth mode, proxy allowlist), which is a map for anyone probing it.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import { describe, expect, it } from 'vitest';
import { type AuthConfig, signHs256 } from '../src/auth.js';
import { compose } from '../src/compose.js';
import type { ConfigReport } from '../src/routes/config-echo.js';

const SECRET = 'config-echo-test-secret';
const KID = 'config-echo';
const ADMIN_CAP = 'admin';

const authCfg: AuthConfig = {
  keys: [{ kid: KID, alg: 'HS256', publicKey: SECRET }],
  adminCapability: ADMIN_CAP
};

function token(capabilities: string[]): string {
  const now = Math.floor(Date.now() / 1000);
  return signHs256({ sub: 'tester', exp: now + 60, capabilities, ns: ['*'] }, SECRET, { kid: KID });
}

const REPORT: ConfigReport = {
  sweepIntervalMs: { env: 'SUBSTRATE_SWEEP_INTERVAL_MS', value: 300_000, source: 'default' },
  port: { env: 'PORT', value: 3100, source: 'explicit' },
  bodyLimit: { env: 'SUBSTRATE_BODY_LIMIT_BYTES', value: null, source: 'default' }
};

async function mk(opts: { auth?: AuthConfig; configReport?: ConfigReport } = {}) {
  const server = new MemorySubstrateServer();
  const dataset = new MemoryDataset({ namespace: 'default' });
  const composed = await compose({
    systemActor: 'test',
    server,
    dataset,
    ...(opts.auth !== undefined
      ? { auth: opts.auth, streamTicketSecret: 'test-stream-ticket-secret' }
      : {}),
    ...(opts.configReport !== undefined ? { configReport: opts.configReport } : {})
  });
  await server.start();
  return { server, composed };
}

describe('GET /substrate/v1/config', () => {
  it('echoes the report the binary passed in', async () => {
    const { server, composed } = await mk({ configReport: REPORT });
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/config' });
    expect(res.status).toBe(200);
    const body = JSON.parse(String(res.body)) as { knobs: ConfigReport };
    expect(body.knobs.port).toEqual({ env: 'PORT', value: 3100, source: 'explicit' });
    // A null effective value is an ANSWER (Fastify's own 1 MiB cap here), and
    // it survives the JSON round-trip as null rather than vanishing.
    expect(body.knobs).toHaveProperty('bodyLimit');
    expect(body.knobs.bodyLimit?.value).toBeNull();
    await composed.stop();
  });

  it('sorts by key so two hosts diff cleanly', async () => {
    // The operator's real question is "do these agree", and the answer to
    // that is `diff`. Parser order is not a property anyone should have to
    // hold in their head to read one.
    const { server, composed } = await mk({ configReport: REPORT });
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/config' });
    const body = JSON.parse(String(res.body)) as { knobs: ConfigReport };
    expect(Object.keys(body.knobs)).toEqual(['bodyLimit', 'port', 'sweepIntervalMs']);
    await composed.stop();
  });

  it('is NOT mounted when the caller passes no report', async () => {
    // An embedder configuring compose programmatically has no env knobs. An
    // empty echo would read as "nothing is configured" rather than "nothing
    // was reported" — the absence-vs-emptiness trap, so the route is absent.
    const { server, composed } = await mk({});
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/config' });
    expect(res.status).toBe(404);
    await composed.stop();
  });

  it('401s a tokenless caller when auth is on', async () => {
    const { server, composed } = await mk({ auth: authCfg, configReport: REPORT });
    const res = await server.inject({ method: 'GET', path: '/substrate/v1/config' });
    expect(res.status).toBe(401);
    await composed.stop();
  });

  it('403s a valid NON-admin token — read is not enough', async () => {
    // The distinguishing test. A `read` capability reaches /substrate/v1/query and
    // /substrate/v1/metrics; if it reached here too, the admin gate would be
    // decorative and this route would be a deployment map for any caller
    // that can read one row.
    const { server, composed } = await mk({ auth: authCfg, configReport: REPORT });
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/config',
      headers: { authorization: `Bearer ${token(['read', 'mutate'])}` }
    });
    expect(res.status).toBe(403);
    await composed.stop();
  });

  it('serves an admin token', async () => {
    const { server, composed } = await mk({ auth: authCfg, configReport: REPORT });
    const res = await server.inject({
      method: 'GET',
      path: '/substrate/v1/config',
      headers: { authorization: `Bearer ${token([ADMIN_CAP, 'read'])}` }
    });
    expect(res.status).toBe(200);
    await composed.stop();
  });
});
