/**
 * §5.12 — `x-forwarded-for` trust allowlist.
 *
 * XFF is parsed only when the request's peer IP is in the trusted-proxies set,
 * so a caller cannot spoof distinct XFF values to evade the per-IP register
 * rate limit. Outside the allowlist the limiter buckets on the peer IP (or
 * `'unknown'` when transport didn't expose one).
 *
 * Even inside the allowlist, the leftmost XFF entry is still client-supplied
 * and forgeable — a proxy appends the hop it
 * observed, so an attacker can prepend a bogus leftmost value that survives
 * verbatim. `extractClientIp` therefore walks the chain right→left and returns
 * the first entry that is NOT itself a trusted proxy: the closest hop our own
 * infrastructure actually observed, hence the last one an attacker cannot
 * forge. Everything to its left is discarded as untrusted.
 *
 * These tests exercise `extractClientIp` directly for the per-behaviour
 * assertions and drive the full register route for the rate-limit neutralisation
 * assertion.
 */

import {
  type ComposeResult,
  compose,
  createRateLimiter,
  extractClientIp,
  type RateLimiter,
  SYSTEM_NAMESPACE
} from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { HttpHandler, SubstrateRequest } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// extractClientIp direct unit coverage
// ---------------------------------------------------------------------------

function mkReq(overrides: Partial<SubstrateRequest>): Parameters<HttpHandler>[0] {
  return {
    method: 'POST',
    path: '/substrate/v1/_system/register',
    headers: {},
    query: {},
    params: {},
    body: null,
    ...overrides
  };
}

describe('extractClientIp (§5.12 Phase 2 / Dispatch B)', () => {
  it('trusted peer: client resolved as the rightmost non-trusted XFF entry, not the leftmost', () => {
    // Chain `1.2.3.4, 5.6.7.8` behind trusted proxy 10.0.0.1: our proxy
    // appended 5.6.7.8 (the hop it observed); 1.2.3.4 is only what 5.6.7.8
    // *claimed* and is unverifiable. The real client is 5.6.7.8 — the closest
    // hop we can attribute.
    const ip = extractClientIp(
      mkReq({ peerIp: '10.0.0.1', headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }),
      new Set(['10.0.0.1'])
    );
    expect(ip).toBe('5.6.7.8');
  });

  it('trusted peer: spoofed leftmost XFF entry cannot masquerade as the client', () => {
    // Attacker (real IP 203.0.113.9) prepends a forged leftmost entry; the
    // trusted proxy 10.0.0.1 then appends the address it actually saw. The
    // limiter must bucket on the real, appended hop — never the forged prefix.
    const ip = extractClientIp(
      mkReq({
        peerIp: '10.0.0.1',
        headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.9' }
      }),
      new Set(['10.0.0.1'])
    );
    expect(ip).toBe('203.0.113.9');
  });

  it('trusted multi-hop chain: walks past every trusted proxy to the real client', () => {
    // client → edge(10.0.0.2) → inner(10.0.0.1=peer). Both proxies trusted.
    // Walking right→left skips 10.0.0.1 then 10.0.0.2, landing on the client.
    const ip = extractClientIp(
      mkReq({
        peerIp: '10.0.0.1',
        headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.2' }
      }),
      new Set(['10.0.0.1', '10.0.0.2'])
    );
    expect(ip).toBe('198.51.100.7');
  });

  it('trusted peer: every XFF hop is trusted infra → falls back to the peer, never a client-supplied value', () => {
    // Degenerate/misconfigured chain with no external hop. Returning the
    // leftmost here would re-open the spoof; fall back to the peer instead.
    const ip = extractClientIp(
      mkReq({ peerIp: '10.0.0.1', headers: { 'x-forwarded-for': '10.0.0.2' } }),
      new Set(['10.0.0.1', '10.0.0.2'])
    );
    expect(ip).toBe('10.0.0.1');
  });

  it('untrusted peer: XFF ignored, peer IP used', () => {
    const ip = extractClientIp(
      mkReq({ peerIp: '99.99.99.99', headers: { 'x-forwarded-for': '1.2.3.4' } }),
      new Set(['10.0.0.1'])
    );
    expect(ip).toBe('99.99.99.99');
  });

  it('no peer IP, XFF ignored regardless of trusted set — returns undefined', () => {
    // `extractClientIp` returns `string | undefined` so the
    // ambient `ctx.clientIp` stays optional (undefined collapses to "absent"
    // in the audit row). The `/register` rate limiter adapts to `'unknown'`
    // locally — see the dedicated rate-limit test below.
    const ip = extractClientIp(
      mkReq({ headers: { 'x-forwarded-for': '1.2.3.4' } }),
      new Set<string>()
    );
    expect(ip).toBeUndefined();
  });

  it('trusted set empty: XFF ignored even when header present', () => {
    const ip = extractClientIp(
      mkReq({ peerIp: '10.0.0.1', headers: { 'x-forwarded-for': '1.2.3.4' } }),
      new Set<string>()
    );
    expect(ip).toBe('10.0.0.1');
  });

  it('trusted peer with no XFF: falls back to peer IP, not unknown', () => {
    // Regression: a trusted-proxy request without XFF should bucket on its
    // own peer, not collapse every trusted-proxy request into `'unknown'`.
    const ip = extractClientIp(mkReq({ peerIp: '10.0.0.1' }), new Set(['10.0.0.1']));
    expect(ip).toBe('10.0.0.1');
  });

  it('trusted peer with X-Forwarded-For (mixed-case header) still parses XFF', () => {
    const ip = extractClientIp(
      mkReq({ peerIp: '10.0.0.1', headers: { 'X-Forwarded-For': '1.2.3.4' } }),
      new Set(['10.0.0.1'])
    );
    expect(ip).toBe('1.2.3.4');
  });
});

// ---------------------------------------------------------------------------
// End-to-end: rate-limit enforcement under spoofing attempt
// ---------------------------------------------------------------------------

interface Ctx {
  server: MemorySubstrateServer;
  composed: ComposeResult;
  limiter: RateLimiter;
}

async function mkServer(opts: { trustedProxies?: Set<string>; maxRequests: number }): Promise<Ctx> {
  const server = new MemorySubstrateServer();
  const dataset = new MemoryDataset({ namespace: 'default' });
  const substrateDataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
  const limiter = createRateLimiter({ maxRequests: opts.maxRequests, windowMs: 60_000 });
  const composed = await compose({
    // Auth is off, so the deployment must declare who it writes as.
    systemActor: 'test',
    server,
    dataset,
    datasets: { [SYSTEM_NAMESPACE]: substrateDataset },
    registerRateLimiter: limiter,
    ...(opts.trustedProxies !== undefined ? { trustedProxies: opts.trustedProxies } : {})
  });
  await server.start();
  return { server, composed, limiter };
}

describe('POST /substrate/v1/_system/register — XFF-spoofing neutralisation', () => {
  let ctx: Ctx | null = null;
  afterEach(async () => {
    if (ctx !== null) {
      ctx.limiter.dispose();
      await ctx.composed.stop();
      ctx = null;
    }
  });

  it('untrusted peer cannot evade rate limit by rotating spoofed XFF values', async () => {
    ctx = await mkServer({ maxRequests: 10 });
    const attackerPeer = '99.99.99.99';
    const responses: Array<number> = [];
    for (let i = 0; i < 15; i++) {
      const res = await ctx.server.inject({
        method: 'POST',
        path: '/substrate/v1/_system/register',
        headers: {
          'content-type': 'application/json',
          // Each request carries a distinct spoofed XFF; the bucket key must
          // be the peer IP, so request 11 onward tips into 429.
          'x-forwarded-for': `1.2.3.${i}`
        },
        peerIp: attackerPeer,
        body: Buffer.from(JSON.stringify({ code: 'x' }))
      });
      responses.push(res.status);
    }
    // First 10 are body-rejected (400 invalid_public_key or 400 missing
    // fields depending on validation order) but the limiter still counts them.
    // Request 11 onwards must trip 429 — that's the invariant being asserted.
    const rateLimited = responses.filter((s) => s === 429);
    expect(rateLimited.length).toBe(5);
    // And the first 10 requests were NOT rate-limited.
    expect(responses.slice(0, 10).every((s) => s !== 429)).toBe(true);
  });

  it('trusted peer: per-XFF bucketing restored (one trusted proxy fronting many real clients)', async () => {
    ctx = await mkServer({ maxRequests: 3, trustedProxies: new Set(['10.0.0.1']) });
    // Three requests from client-A through the trusted proxy — hits the cap.
    for (let i = 0; i < 3; i++) {
      await ctx.server.inject({
        method: 'POST',
        path: '/substrate/v1/_system/register',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.1' },
        peerIp: '10.0.0.1',
        body: Buffer.from(JSON.stringify({ code: 'x' }))
      });
    }
    const clientA = await ctx.server.inject({
      method: 'POST',
      path: '/substrate/v1/_system/register',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.1' },
      peerIp: '10.0.0.1',
      body: Buffer.from(JSON.stringify({ code: 'x' }))
    });
    expect(clientA.status).toBe(429);

    // A DIFFERENT real client through the same trusted proxy gets its own
    // bucket — proving the XFF trust path is still working.
    const clientB = await ctx.server.inject({
      method: 'POST',
      path: '/substrate/v1/_system/register',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.2' },
      peerIp: '10.0.0.1',
      body: Buffer.from(JSON.stringify({ code: 'x' }))
    });
    expect(clientB.status).not.toBe(429);
  });

  it('trusted peer: rotating a spoofed leftmost XFF cannot evade the cap', async () => {
    ctx = await mkServer({ maxRequests: 3, trustedProxies: new Set(['10.0.0.1']) });
    // One real client (203.0.113.9) behind the trusted proxy rotates a forged
    // leftmost entry every request. The proxy always appends the true hop, so
    // all requests must bucket on 203.0.113.9 and trip 429 after the cap.
    const responses: Array<number> = [];
    for (let i = 0; i < 6; i++) {
      const res = await ctx.server.inject({
        method: 'POST',
        path: '/substrate/v1/_system/register',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': `172.16.9.${i}, 203.0.113.9`
        },
        peerIp: '10.0.0.1',
        body: Buffer.from(JSON.stringify({ code: 'x' }))
      });
      responses.push(res.status);
    }
    expect(responses.filter((s) => s === 429).length).toBe(3);
    expect(responses.slice(0, 3).every((s) => s !== 429)).toBe(true);
  });
});
