import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAuthConfig, verifyBearerToken } from '@mnmal-ai/substrate-compose';
import { describe, expect, it } from 'vitest';
import { makeAgentJwtProvider } from './agent-jwt.js';

function keyFiles() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const dir = mkdtempSync(join(tmpdir(), 'agent-jwt-'));
  const privP = join(dir, 'agent.key');
  writeFileSync(privP, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const regP = join(dir, 'reg.json');
  writeFileSync(
    regP,
    JSON.stringify([{ kid: 'claude', alg: 'EdDSA', publicKey: pubPem, kind: 'agent' }]),
    'utf8'
  );
  return { privP, regP };
}

describe('makeAgentJwtProvider', () => {
  it('returns null when key/kid env is absent', () => {
    const provider = makeAgentJwtProvider({} as NodeJS.ProcessEnv);
    expect(provider()).toBeNull();
  });

  it.each([{ SUBSTRATE_AGENT_KEY_PATH: '/k.pem' }, { SUBSTRATE_AGENT_KEY_ID: 'claude' }])(
    'throws when only one of key path / key id is set: %j',
    (env) => {
      expect(() => makeAgentJwtProvider(env as NodeJS.ProcessEnv)).toThrow(/must be set together/);
    }
  );

  it('signs a JWT the verifier accepts as kind:agent', async () => {
    const { privP, regP } = keyFiles();
    const provider = makeAgentJwtProvider({
      SUBSTRATE_AGENT_KEY_PATH: privP,
      SUBSTRATE_AGENT_KEY_ID: 'claude'
    } as NodeJS.ProcessEnv);
    const headerValue = provider();
    expect(typeof headerValue).toBe('string');
    // provider returns "Bearer <jwt>"; verifyBearerToken expects the raw jwt
    const jwt = (headerValue as string).replace(/^Bearer /, '');
    const cfg = parseAuthConfig({ SUBSTRATE_AUTH_KEY_REGISTRY: regP } as NodeJS.ProcessEnv)!;
    const identity = await verifyBearerToken(jwt, cfg);
    expect(identity?.agentKeyId).toBe('claude');
    expect(identity?.grants?.['*']).toContain('mutate');
  });

  it('reuses a non-expired token (same string within TTL)', () => {
    const { privP } = keyFiles();
    const provider = makeAgentJwtProvider({
      SUBSTRATE_AGENT_KEY_PATH: privP,
      SUBSTRATE_AGENT_KEY_ID: 'claude'
    } as NodeJS.ProcessEnv);
    expect(provider()).toBe(provider());
  });
});
