/**
 * A kernel route that declares `targetNamespace: 'body'` with capability
 * `'admin'` needs admin in the namespace its body names.
 */

import type { HttpHandler, HttpMethod, SubstrateRequest } from '@mnmal-ai/substrate-types';
import { expect, it } from 'vitest';
import { type AuthConfig, signHs256 } from '../src/auth.js';
import { mountKernelRoute } from '../src/kernel.js';

const SECRET = 'kernel-target-test-secret';
const KID = 'kernel-target';
const auth: AuthConfig = { keys: [{ kid: KID, alg: 'HS256', publicKey: SECRET }] };

function request(ns: string[], body: unknown): SubstrateRequest {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const token = signHs256({ sub: 't', exp, capabilities: ['admin'], ns }, SECRET, { kid: KID });
  return {
    method: 'POST',
    path: '/substrate/v1/thing',
    headers: { authorization: `Bearer ${token}` },
    query: {},
    params: {},
    body: Buffer.from(JSON.stringify(body))
  };
}

function mount(targetNamespace?: 'body') {
  let calls = 0;
  let mounted: HttpHandler | undefined;
  mountKernelRoute(
    {
      route(_m: HttpMethod, _p: string, h: HttpHandler): void {
        mounted = h;
      }
    },
    {
      path: 'thing',
      method: 'POST',
      capability: 'admin',
      ...(targetNamespace !== undefined ? { targetNamespace } : {}),
      handler: async () => {
        calls++;
        return { status: 200 };
      }
    },
    auth
  );
  return { call: (req: SubstrateRequest) => (mounted as HttpHandler)(req), calls: () => calls };
}

it('refuses an admin of another namespace and admits an admin of the target', async () => {
  const route = mount('body');
  const refused = await route.call(request(['a'], { namespace: 'b' }));
  expect(refused.status).toBe(403);
  expect(JSON.parse(String(refused.body))).toEqual({ code: 'forbidden', required: 'b:admin' });
  expect(route.calls()).toBe(0);

  expect((await route.call(request(['b'], { namespace: 'b' }))).status).toBe(200);
  expect((await route.call(request(['*'], { namespace: 'b' }))).status).toBe(200);
  expect(route.calls()).toBe(2);
});

it('leaves a route that declares no target on the admin-anywhere gate', async () => {
  const route = mount();
  expect((await route.call(request(['a'], { namespace: 'b' }))).status).toBe(200);
});
