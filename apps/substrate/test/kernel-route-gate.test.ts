/**
 * `KernelRouteClaim.capability` is REQUIRED, and `'public'` is the only bypass.
 *
 * Under `mode: 'attribute'` a declared `'admin'` capability is still enforced —
 * compose only waives the non-admin checks. A route with NO capability gets no
 * `withAuth` wrapper at all, so it is exempt under `attribute` AND under
 * `required`: omission selects no gate, not a weaker one.
 *
 * The type makes a missing capability a compile error. This pins the runtime
 * half: `'public'` and only `'public'` skips the wrapper.
 */

import { generateKeyPairSync } from 'node:crypto';
import {
  type AuthConfig,
  createKeyRegistry,
  KEY_TYPE,
  SYSTEM_NAMESPACE,
  signEdDSA
} from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type { HttpHandler, HttpMethod, KernelRouteClaim } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { mountKernelRoute } from '../src/_kernel.js';

const AUTH: AuthConfig = {
  mode: 'required',
  hs256: { secret: 'test-secret-value-long-enough-for-hs256' }
} as unknown as AuthConfig;

function mount(
  capability: KernelRouteClaim['capability'],
  auth: AuthConfig | null
): {
  mounted: HttpHandler;
  original: HttpHandler;
  calls: () => number;
  path: string;
  method: HttpMethod;
} {
  let count = 0;
  const original: HttpHandler = async () => {
    count++;
    return { status: 200, body: 'ok' };
  };
  let mounted: HttpHandler | undefined;
  let path = '';
  let method: HttpMethod = 'GET';
  const server = {
    route(m: HttpMethod, p: string, h: HttpHandler): void {
      method = m;
      path = p;
      mounted = h;
    }
  };
  mountKernelRoute(server, { path: 'thing', method: 'POST', capability, handler: original }, auth);
  if (mounted === undefined) throw new Error('route was never registered');
  return { mounted, original, calls: () => count, path, method };
}

const anonymous = {
  method: 'POST' as const,
  path: '/substrate/v1/thing',
  headers: {},
  query: {},
  params: {},
  body: null
};

describe('kernel-route gating', () => {
  // Gating is detected by whether an anonymous request REACHES the plugin's
  // handler, which counts its calls. A response status alone would pass for a
  // handler that happens to 401 on its own.
  for (const capability of ['read', 'mutate', 'admin'] as const) {
    it(`'${capability}' gates the handler`, async () => {
      const { mounted, calls } = mount(capability, AUTH);
      await mounted(anonymous);
      expect(calls()).toBe(0);
    });
  }

  it("'public' is the bypass, and it has to be written down", async () => {
    const { mounted, calls } = mount('public', AUTH);
    await mounted(anonymous);
    expect(calls()).toBe(1);
  });

  it('mounts under /substrate/v1/ with the declared method', () => {
    const { path, method } = mount('read', AUTH);
    expect(path).toBe('/substrate/v1/thing');
    expect(method).toBe('POST');
  });

  it('with auth disabled every route is ungated, including gated ones', async () => {
    // Not a hole — there is nothing to check against. Pinned so the reason
    // stays visible: an ungated route on an auth-less instance says nothing
    // about whether it would be gated on one with auth.
    for (const capability of ['read', 'mutate', 'admin', 'public'] as const) {
      const { mounted, calls } = mount(capability, null);
      await mounted(anonymous);
      expect(calls()).toBe(1);
    }
  });

  it('hands the handler the post-trust clientIp and authEnabled, never a caller-set one', async () => {
    const seen: Array<{ clientIp: string | undefined; authEnabled: boolean | undefined }> = [];
    let handler: HttpHandler | undefined;
    const server = {
      route(_m: HttpMethod, _p: string, h: HttpHandler): void {
        handler = h;
      }
    };
    mountKernelRoute(
      server,
      {
        path: 'thing',
        method: 'POST',
        capability: 'public',
        handler: async (req) => {
          seen.push({ clientIp: req.clientIp, authEnabled: req.authEnabled });
          return { status: 200 };
        }
      },
      null,
      new Set(['10.0.0.1'])
    );
    await handler?.({
      ...anonymous,
      peerIp: '10.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.5' }
    });
    await handler?.({ ...anonymous, peerIp: '198.51.100.7', clientIp: '203.0.113.99' });
    expect(seen).toEqual([
      { clientIp: '203.0.113.5', authEnabled: false },
      { clientIp: '198.51.100.7', authEnabled: false }
    ]);
  });
});

/**
 * The config a kernel route is mounted with must carry the key registry, or a
 * VALID agent token is strictly worse than no token at all.
 *
 * `verifyBearerToken` consults `cfg.keyRegistry` to resolve an asymmetric kid,
 * so without it an agent token is unverifiable and the present-but-invalid
 * rule fires 401 — while sending nothing falls through to the anonymous path.
 *
 * The two cases differ ONLY in the config handed to `mountKernelRoute`: same
 * route, same token, same `withAuth`.
 */
describe('mountKernelRoute § key registry', () => {
  const mkAgentAuth = async (): Promise<{
    withRegistry: AuthConfig;
    withoutRegistry: AuthConfig;
    token: string;
  }> => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    await dataset.write(KEY_TYPE, [
      {
        id: 'k-910',
        kid: 'agent-910',
        name: 'agent',
        algorithm: 'EdDSA',
        publicKey: pem,
        namespaces: '*',
        capabilities: 'read',
        revokedAt: null
      }
    ]);
    const registry = createKeyRegistry({ dataset });
    await registry.primeFromDataset();

    const token = signEdDSA(
      {
        sub: 'agent-910',
        exp: Math.floor(Date.now() / 1000) + 60,
        capabilities: ['read'],
        ns: ['*']
      },
      privateKey,
      { kid: 'agent-910' }
    );
    const base: AuthConfig = { mode: 'required', keys: [] };
    return { withRegistry: { ...base, keyRegistry: registry }, withoutRegistry: base, token };
  };

  const call = async (auth: AuthConfig, token: string): Promise<number> => {
    const server = new MemorySubstrateServer();
    mountKernelRoute(
      server,
      {
        path: 'probe-910',
        method: 'POST',
        capability: 'read',
        handler: () => ({ status: 200, headers: {}, body: Buffer.from('{}') })
      },
      auth
    );
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/probe-910',
      headers: { authorization: `Bearer ${token}` },
      body: Buffer.from('{}')
    });
    return res.status;
  };

  it('WITH the registry, a valid agent token is accepted', async () => {
    const { withRegistry, token } = await mkAgentAuth();
    expect(await call(withRegistry, token)).toBe(200);
  });

  it('WITHOUT it, the same token on the same route 401s — the shipped defect', async () => {
    // Not a wrong answer about the token; an inability to look it up,
    // reported as a rejection.
    const { withoutRegistry, token } = await mkAgentAuth();
    expect(await call(withoutRegistry, token)).toBe(401);
  });
});
