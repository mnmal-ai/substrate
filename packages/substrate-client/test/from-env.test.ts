import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createClientFromEnv, resolveAgentCapabilities } from '../src/from-env.js';

const dir = mkdtempSync(join(tmpdir(), 'from-env-'));
const keyPath = join(dir, 'agent.key');
writeFileSync(
  keyPath,
  generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })
);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const URL = 'https://substrate.test:3100';
const signedEnv = {
  SUBSTRATE_URL: URL,
  SUBSTRATE_AGENT_KEY_ID: 'a@h',
  SUBSTRATE_AGENT_KEY_PATH: keyPath
};

function decodeJwtPart(token: string, i: number): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[i] as string, 'base64url').toString('utf8'));
}

function recordingFetch(): {
  fetch: typeof fetch;
  seen: { auth: string | null; redirect: unknown }[];
} {
  const seen: { auth: string | null; redirect: unknown }[] = [];
  const fake = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ auth: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fake, seen };
}

describe('createClientFromEnv', () => {
  it('signs as the kid, with the endpoint origin as audience, and refuses redirects', async () => {
    const { fetch, seen } = recordingFetch();
    const { client, kid, endpoint } = createClientFromEnv({ env: signedEnv, fetch });
    expect(kid).toBe('a@h');
    expect(endpoint).toBe(URL);
    await client.metrics();
    const auth = seen[0]?.auth ?? '';
    expect(auth).toMatch(/^Bearer /);
    const jwt = auth.slice('Bearer '.length);
    expect(decodeJwtPart(jwt, 0).kid).toBe('a@h');
    expect(decodeJwtPart(jwt, 1).aud).toBe(URL);
    expect(seen[0]?.redirect).toBe('error');
  });

  it('requires SUBSTRATE_URL', () => {
    expect(() => createClientFromEnv({ env: {} })).toThrow(/SUBSTRATE_URL/);
  });

  it('refuses half a key pair', () => {
    expect(() =>
      createClientFromEnv({ env: { SUBSTRATE_URL: URL, SUBSTRATE_AGENT_KEY_ID: 'a@h' } })
    ).toThrow(/only SUBSTRATE_AGENT_KEY_ID is set/);
  });

  it('refuses an anonymous client unless asked for one', async () => {
    expect(() => createClientFromEnv({ env: { SUBSTRATE_URL: URL } })).toThrow(/no signing key/);
    const { fetch, seen } = recordingFetch();
    const { client, kid } = createClientFromEnv({
      env: { SUBSTRATE_URL: URL },
      allowAnonymous: true,
      fetch
    });
    expect(kid).toBeNull();
    await client.metrics();
    expect(seen[0]?.auth).toBeNull();
  });

  it('refuses to send a credential over plain http to a remote host', () => {
    expect(() =>
      createClientFromEnv({ env: { ...signedEnv, SUBSTRATE_URL: 'http://substrate.test' } })
    ).toThrow(/refusing to send a credential/);
  });
});

describe('resolveAgentCapabilities', () => {
  it('reads the csv and falls back to the default on blanks', () => {
    expect(
      resolveAgentCapabilities({ SUBSTRATE_AGENT_CAPABILITIES: 'read, mutate ,admin' })
    ).toEqual(['read', 'mutate', 'admin']);
    expect(resolveAgentCapabilities({ SUBSTRATE_AGENT_CAPABILITIES: ' , ' })).toEqual([
      'read',
      'mutate'
    ]);
  });
});
