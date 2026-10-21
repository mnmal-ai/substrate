import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTokenProvider } from '@mnmal-ai/substrate-policy';
import type { SubstrateRequest } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import type { KeyRecord, KeyRegistry } from '../src/_system/registry.js';
import {
  type AuthConfig,
  AuthConfigError,
  authenticateBearer,
  credentialLapse,
  parseAuthConfig,
  signEdDSA,
  signHs256
} from '../src/auth.js';
import { withAuth } from '../src/compose/auth-middleware.js';
import { parseStreamRequest } from '../src/routes/sse.js';
import { hashFrame, mintStreamTicket } from '../src/routes/stream-ticket.js';

const KID = 'agent@host';
const SECRET = 'token-lifetime-test-secret-0123456789';
const now = (): number => Math.floor(Date.now() / 1000);

function edKeys(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
  };
}

function registryOf(records: Map<string, KeyRecord>): KeyRegistry {
  return {
    lookup: (kid) => records.get(kid) ?? null,
    install: () => true,
    refresh: () => Promise.resolve(),
    evict: (kid) => {
      records.delete(kid);
    },
    primeFromDataset: () => Promise.resolve(),
    dispose: () => {}
  };
}

function datasetCfg(publicPem: string): { cfg: AuthConfig; records: Map<string, KeyRecord> } {
  const records = new Map<string, KeyRecord>([
    [
      KID,
      {
        kid: KID,
        algorithm: 'EdDSA',
        publicKey: publicPem,
        namespaces: ['*'],
        capabilities: ['read'],
        revokedAt: null
      }
    ]
  ]);
  return { cfg: { keys: [], keyRegistry: registryOf(records) }, records };
}

const hsCfg: AuthConfig = { keys: [{ kid: 'k1', alg: 'HS256', publicKey: SECRET }] };

describe('token lifetime bound', () => {
  it('refuses a token that expires further ahead than the bound, and the 401 names the knob', async () => {
    const jwt = signHs256({ sub: 'u', exp: now() + 30 * 86_400 }, SECRET, { kid: 'k1' });
    expect(authenticateBearer(jwt, hsCfg)).toEqual({ ok: false, reason: 'lifetime_exceeds_max' });

    const res = await withAuth(
      async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }),
      hsCfg,
      'read'
    )({
      method: 'GET',
      path: '/x',
      headers: { authorization: `Bearer ${jwt}` },
      query: {},
      params: {},
      body: null
    } as unknown as SubstrateRequest);
    expect(res.status).toBe(401);
    expect(JSON.parse(String(res.body)).detail).toContain('SUBSTRATE_JWT_MAX_TTL_SECONDS');
  });

  it('is configurable, and 0 turns it off', () => {
    const jwt = signHs256({ sub: 'u', exp: now() + 30 * 86_400 }, SECRET, { kid: 'k1' });
    expect(authenticateBearer(jwt, { ...hsCfg, maxTokenLifetimeSeconds: 0 }).ok).toBe(true);
    const hour = signHs256({ sub: 'u', exp: now() + 3600 }, SECRET, { kid: 'k1' });
    expect(authenticateBearer(hour, { ...hsCfg, maxTokenLifetimeSeconds: 60 }).ok).toBe(false);
  });

  it('admits what the house agent-token minter issues', () => {
    const { privatePem, publicPem } = edKeys();
    const dir = mkdtempSync(join(tmpdir(), 'lifetime-'));
    const keyPath = join(dir, 'agent.pem');
    writeFileSync(keyPath, privatePem);
    const jwt = makeTokenProvider({ keyPath, kid: KID })();
    const verdict = authenticateBearer(jwt, datasetCfg(publicPem).cfg);
    expect(verdict.ok).toBe(true);
  });

  it('parses SUBSTRATE_JWT_MAX_TTL_SECONDS and rejects a bad value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lifetime-'));
    const path = join(dir, 'keys.json');
    writeFileSync(path, JSON.stringify([{ kid: 'k1', alg: 'HS256', publicKey: SECRET }]));
    const env = { SUBSTRATE_AUTH_KEY_REGISTRY: path };
    expect(
      parseAuthConfig({ ...env, SUBSTRATE_JWT_MAX_TTL_SECONDS: '600' })?.maxTokenLifetimeSeconds
    ).toBe(600);
    expect(() => parseAuthConfig({ ...env, SUBSTRATE_JWT_MAX_TTL_SECONDS: 'long' })).toThrow(
      AuthConfigError
    );
  });
});

describe('file-registry keys', () => {
  it('refuses a file-registry HS256 secret shorter than 32 bytes at boot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hs-floor-'));
    const path = join(dir, 'keys.json');
    writeFileSync(path, JSON.stringify([{ kid: 'k1', alg: 'HS256', publicKey: 'secret' }]));
    expect(() => parseAuthConfig({ SUBSTRATE_AUTH_KEY_REGISTRY: path })).toThrow(/32 bytes/);
  });
});

describe('credentialLapse', () => {
  it('reports a verified identity whose token has since expired', () => {
    const jwt = signHs256({ sub: 'u', exp: now() + 60 }, SECRET, { kid: 'k1' });
    const verdict = authenticateBearer(jwt, hsCfg);
    if (!verdict.ok) throw new Error('expected a verified token');
    expect(credentialLapse(verdict.identity, hsCfg)).toBeNull();
    expect(credentialLapse(verdict.identity, hsCfg, now() + 61)).toBe('credential_expired');
  });

  it('reports a Key-registry identity whose key has since been revoked', () => {
    const { privatePem, publicPem } = edKeys();
    const { cfg, records } = datasetCfg(publicPem);
    const jwt = signEdDSA(
      { sub: KID, exp: now() + 300, ns: ['*'], capabilities: ['read'] },
      privatePem,
      {
        kid: KID
      }
    );
    const verdict = authenticateBearer(jwt, cfg);
    if (!verdict.ok) throw new Error('expected a verified token');
    expect(credentialLapse(verdict.identity, cfg)).toBeNull();
    records.delete(KID);
    expect(credentialLapse(verdict.identity, cfg)).toBe('credential_revoked');
  });

  it('refuses an SSE ticket whose minting token has expired since', () => {
    const exp = now() + 5;
    const jwt = signHs256({ sub: 'u', exp, capabilities: ['read'] }, SECRET, { kid: 'k1' });
    const verdict = authenticateBearer(jwt, hsCfg);
    if (!verdict.ok) throw new Error('expected a verified token');
    const frame = { 'default/Memo': { fields: { id: true } } };
    const ticketSecret = 'ticket-secret-0123456789';
    const ticket = mintStreamTicket(
      ticketSecret,
      { identity: verdict.identity, capabilities: ['read'], frameHash: hashFrame(frame) },
      Date.now()
    );
    const parsed = parseStreamRequest(
      { method: 'GET', body: null, query: { frame: JSON.stringify(frame), ticket } },
      ticketSecret,
      Date.now()
    );
    if (!parsed.ok) throw new Error('expected a valid ticket');
    // The identity survives the ticket's JSON round trip with its expiry.
    expect(credentialLapse(parsed.identity, hsCfg, exp + 1)).toBe('credential_expired');
  });
});
