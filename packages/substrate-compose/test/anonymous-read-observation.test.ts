/**
 * Observing tokenless readers before refusing them.
 *
 * There is no read audit trail, so these tests pin the observation that
 * identifies who the anonymous readers are. Refusing blind would surface a
 * credential problem to the caller as "substrate offline" rather than as an auth
 * problem.
 */

import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { SubstrateRequest, SubstrateResponse } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import type { AuthConfig } from '../src/auth.js';
import { compose, withAuth } from '../src/compose.js';

const CFG: AuthConfig = { keys: [], mode: 'attribute' };

const OK: SubstrateResponse = { status: 200, headers: {}, body: Buffer.from('{}') };
const handler = async (): Promise<SubstrateResponse> => OK;

function req(overrides: Partial<SubstrateRequest> = {}): SubstrateRequest {
  return {
    method: 'POST',
    path: '/substrate/v1/query',
    headers: { 'user-agent': 'corpus-puller/1.2' },
    query: {},
    params: {},
    body: null,
    peerIp: '100.64.0.9',
    ...overrides
  } as SubstrateRequest;
}

describe('anonymous reads are OBSERVED before they are refused', () => {
  it('reports enough to identify a consumer, not merely count one', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const wrapped = withAuth(handler, CFG, 'read', (i) => seen.push({ ...i }));

    await wrapped(req());

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      method: 'POST',
      path: '/substrate/v1/query',
      peerIp: '100.64.0.9',
      userAgent: 'corpus-puller/1.2'
    });
  });

  it('does NOT fire for an authenticated read — that one is already attributable', async () => {
    const seen: Array<unknown> = [];
    const cfg: AuthConfig = { keys: [], mode: 'attribute' };
    const wrapped = withAuth(handler, cfg, 'read', () => seen.push(1));

    // A present-but-invalid token is rejected outright, never observed as anonymous.
    const res = await wrapped(req({ headers: { authorization: 'Bearer not.a.token' } }));

    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('does NOT fire for a tokenless WRITE — that is refused, not observed', async () => {
    const seen: Array<unknown> = [];
    const wrapped = withAuth(handler, CFG, 'mutate', () => seen.push(1));

    const res = await wrapped(req());

    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });
});

/**
 * The wiring, not just the primitive. The unit tests above pass
 * `onAnonymousRead` to `withAuth` DIRECTLY, so they hold whether or not
 * `compose` passes it; this one goes through `compose`.
 */
describe('compose WIRES the sink, not merely declares it', () => {
  it('counts an anonymous read as a route event reachable from /substrate/v1/metrics', async () => {
    const server = new MemorySubstrateServer();
    const dataset = new MemoryDataset({ namespace: 'default' });
    const composed = await compose({
      server,
      dataset,
      auth: { keys: [], mode: 'attribute' },
      streamTicketSecret: 'anon-read-wiring-secret-value'
    });
    await server.start();
    try {
      // A tokenless READ — admitted under attribute mode, and the thing we
      // want observed before anyone proposes refusing it.
      const read = await server.inject({
        method: 'POST',
        path: '/substrate/v1/query',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ 'default/Nothing': { params: {}, fields: {} } }))
      });
      expect(read.status).toBe(200);

      const metrics = await server.inject({ method: 'GET', path: '/substrate/v1/metrics' });
      expect(metrics.status).toBe(200);
      expect(metrics.body?.toString('utf8') ?? '').toContain('anonymous_read');
    } finally {
      await composed.stop();
      await server.stop();
    }
  });
});

/**
 * Frame keys on the observation. Peer IP and user-agent do not separate local
 * consumers (they share the host's peer IP and report `node`); the frame KEYS
 * (`journal/Todo` vs `recall/Hit`) do.
 *
 * PARAMS ARE NEVER LOGGED: a `where` clause carries content (filter values,
 * search text, ids), type names do not. Asserted below.
 */
describe('the observation names WHICH frames were read', () => {
  const queryBody = (frame: unknown): Buffer => Buffer.from(JSON.stringify(frame));

  it('reports the frame keys of an anonymous query', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const wrapped = withAuth(handler, CFG, 'read', (i) => seen.push({ ...i }));

    await wrapped(
      req({
        body: queryBody({
          'journal/Todo': { params: { limit: 1 }, fields: { id: true } },
          'recall/Hit': { params: { to: 'anything' }, fields: { id: true } }
        })
      })
    );

    expect(seen[0]?.frameKeys).toEqual(['journal/Todo', 'recall/Hit']);
  });

  it('NEVER carries params — a where clause holds content, a type name does not', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const wrapped = withAuth(handler, CFG, 'read', (i) => seen.push({ ...i }));

    await wrapped(
      req({
        body: queryBody({
          'journal/Memory': {
            params: { where: { body: { contains: 'a-secret-search-term' } } },
            fields: { id: true }
          }
        })
      })
    );

    const serialised = JSON.stringify(seen[0]);
    expect(serialised).toContain('journal/Memory');
    expect(serialised).not.toContain('a-secret-search-term');
    expect(serialised).not.toContain('where');
  });

  it('omits the field for a GET, where the path already identifies the read', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const wrapped = withAuth(handler, CFG, 'read', (i) => seen.push({ ...i }));

    await wrapped(req({ method: 'GET', path: '/substrate/v1/metrics', body: null }));

    expect(seen[0]?.frameKeys).toBeUndefined();
  });

  it('survives a body that is not JSON — an observation must never break a request', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const wrapped = withAuth(handler, CFG, 'read', (i) => seen.push({ ...i }));

    const res = await wrapped(req({ body: Buffer.from('}{ not json') }));

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.frameKeys).toBeUndefined();
  });

  it('does not parse a large body just to log it', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const wrapped = withAuth(handler, CFG, 'read', (i) => seen.push({ ...i }));

    const huge = { 'journal/Todo': { params: { pad: 'x'.repeat(70_000) }, fields: {} } };
    await wrapped(req({ body: queryBody(huge) }));

    expect(seen[0]?.frameKeys).toBeUndefined();
  });
});
