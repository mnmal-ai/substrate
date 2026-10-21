/**
 * A plugin's HTTP routes require the method's capability granted in one of
 * the plugin's own namespaces, not merely somewhere.
 */

import type { HttpHandler, PluginRouter } from '@mnmal-ai/substrate-types';
import { expect, it } from 'vitest';
import { type AuthConfig, signHs256 } from '../src/auth.js';
import { wrapPluginRouter } from '../src/compose/auth-middleware.js';

const SECRET = 'plugin-router-ns-gate-secret';
const AUTH: AuthConfig = {
  mode: 'required',
  keys: [{ kid: 'k', alg: 'HS256', publicKey: SECRET }]
};

function tokenFor(ns: string[]): string {
  const exp = Math.floor(Date.now() / 1000) + 300;
  return signHs256({ sub: 'caller', ns, capabilities: ['read'], exp }, SECRET, { kid: 'k' });
}

function mount(namespaces?: string[]): HttpHandler {
  let mounted: HttpHandler | undefined;
  const raw = { get: (_p: string, h: HttpHandler) => (mounted = h) } as unknown as PluginRouter;
  wrapPluginRouter(raw, AUTH, namespaces).get('/x', () => ({ status: 200, headers: {}, body: '' }));
  if (mounted === undefined) throw new Error('route not mounted');
  return mounted;
}

async function statusOf(h: HttpHandler, token: string): Promise<number> {
  const res = await h({
    method: 'GET',
    path: '/x',
    query: {},
    params: {},
    body: null,
    headers: { authorization: `Bearer ${token}` }
  });
  return res.status;
}

it('gates by the plugin namespaces, or anywhere when it declares none', async () => {
  expect(await statusOf(mount(['mine']), tokenFor(['other']))).toBe(403);
  expect(await statusOf(mount(['mine']), tokenFor(['mine']))).toBe(200);
  expect(await statusOf(mount([]), tokenFor(['other']))).toBe(200);
});
