/**
 * A minted credential goes only to https or a loopback http origin, never
 * follows a redirect, and names the origin it was minted for as its `aud`.
 */

import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tokenAudience } from '@mnmal-ai/substrate-client';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdminCliEnv } from '../src/admin/env.js';
import { resolveAdminAuth } from '../src/admin/identity.js';
import { runKeyListViaRoute, runKeyPatchViaRoute } from '../src/admin/route.js';
import { getSubstrateForTest } from '../src/mcp/server.js';

const env: AdminCliEnv = { SUBSTRATE_ADMIN_TOKEN: 'tok' };
const servers: http.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function listen(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  return new Promise((resolve) =>
    s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`))
  );
}

/** A server that redirects every request to a second one, which records what reached it. */
async function redirecting(): Promise<{ base: string; reached: string[] }> {
  const reached: string[] = [];
  const target = await listen((req, res) => {
    reached.push(String(req.headers.authorization));
    res.end('{}');
  });
  const base = await listen((_req, res) => {
    res.writeHead(307, { location: `${target}/x` });
    res.end();
  });
  return { base, reached };
}

describe('token targets', () => {
  it('allows https and loopback http, refuses plain http elsewhere', () => {
    expect(tokenAudience('https://substrate.example:3100/x')).toBe(
      'https://substrate.example:3100'
    );
    expect(tokenAudience('http://127.0.0.1:3100')).toBe('http://127.0.0.1:3100');
    expect(tokenAudience('http://localhost:3100')).toBe('http://localhost:3100');
    expect(tokenAudience('http://[::1]:3100')).toBe('http://[::1]:3100');
    expect(() => tokenAudience('http://substrate.example:3100')).toThrow(/refusing/);
  });

  it('the admin CLI refuses plain http to a remote host before sending anything', async () => {
    let sent = 0;
    const fetchImpl = (async () => {
      sent += 1;
      return new Response('{}');
    }) as unknown as typeof fetch;
    await expect(runKeyListViaRoute('http://substrate.example', env, fetchImpl)).rejects.toThrow(
      /refusing to send a credential/
    );
    expect(sent).toBe(0);
  });

  it('the admin CLI and MCP do not follow a redirect with the token', async () => {
    const { base, reached } = await redirecting();
    await expect(runKeyPatchViaRoute({ kid: 'k', revoke: true }, base, env, {})).rejects.toThrow(
      /could not reach/
    );
    await expect(
      getSubstrateForTest(base, '/substrate/v1/x', () => 'Bearer agent')
    ).rejects.toThrow(/failed/);
    expect(reached).toEqual([]);
  });

  it('MCP refuses to send its agent token over plain http to a remote host', async () => {
    await expect(
      getSubstrateForTest('http://substrate.example', '/x', () => 'Bearer agent')
    ).rejects.toThrow(/refusing to send a credential/);
  });

  it('a minted admin token names the target origin as aud', () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrate-aud-'));
    const key = join(dir, 'ops.key');
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    const auth = resolveAdminAuth(
      { HOME: dir, SUBSTRATE_ADMIN_KEY_PATH: key, SUBSTRATE_ADMIN_KEY_ID: 'ops@Box' },
      'https://substrate.example:3100/base'
    );
    if (!('ok' in auth)) throw new Error(auth.error);
    const payload = auth.ok.replace(/^Bearer /, '').split('.')[1]!;
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).aud).toBe(
      'https://substrate.example:3100'
    );
  });
});
