/**
 * makeAgentJwtProvider — the MCP client's optional agent-identity signer.
 * Covers the unconfigured no-op, the fail-loud paths for a
 * set-but-missing/malformed SUBSTRATE_AGENT_KEY_PATH, and a round-trip proving
 * the minted token satisfies verifyBearerToken's EdDSA contract (mandatory
 * `exp` + `ns`, kind:'agent' attribution).
 */

import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AuthConfig, verifyBearerToken } from '@mnmal-ai/substrate-compose';
import { describe, expect, it } from 'vitest';
import { makeAgentJwtProvider } from '../src/mcp/agent-jwt.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'substrate-agent-jwt-'));
}

describe('makeAgentJwtProvider', () => {
  it('returns a null-yielding provider when env is unset', () => {
    expect(makeAgentJwtProvider({} as NodeJS.ProcessEnv)()).toBeNull();
  });

  it('fails loud at construction when the key file is missing', () => {
    expect(() =>
      makeAgentJwtProvider({
        SUBSTRATE_AGENT_KEY_PATH: '/nonexistent/agent-key.pem',
        SUBSTRATE_AGENT_KEY_ID: 'claude-test'
      } as NodeJS.ProcessEnv)
    ).toThrow();
  });

  it('fails loud at construction when the key file is malformed (not a PEM)', () => {
    const dir = tempDir();
    const badKey = join(dir, 'bad-key.pem');
    writeFileSync(badKey, 'this is not a private key', 'utf8');
    expect(() =>
      makeAgentJwtProvider({
        SUBSTRATE_AGENT_KEY_PATH: badKey,
        SUBSTRATE_AGENT_KEY_ID: 'claude-test'
      } as NodeJS.ProcessEnv)
    ).toThrow();
  });

  it('mints a Bearer JWT that passes verifyBearerToken and attributes as agent', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const dir = tempDir();
    const keyPath = join(dir, 'agent-key.pem');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8');

    const provider = makeAgentJwtProvider({
      SUBSTRATE_AGENT_KEY_PATH: keyPath,
      SUBSTRATE_AGENT_KEY_ID: 'claude-test'
    } as NodeJS.ProcessEnv);

    const header = provider();
    expect(header).toMatch(/^Bearer /);

    // The minted token must satisfy the stricter EdDSA verify contract:
    // mandatory exp + ns, and kind:'agent' attribution from the registry.
    const cfg: AuthConfig = {
      keys: [
        {
          kid: 'claude-test',
          alg: 'EdDSA',
          publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          kind: 'agent'
        }
      ]
    };
    const identity = await verifyBearerToken((header as string).slice('Bearer '.length), cfg);
    expect(identity).not.toBeNull();
    expect(identity?.agentKeyId).toBe('claude-test');
  });

  it('caches the token and reuses it within the TTL window', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const dir = tempDir();
    const keyPath = join(dir, 'agent-key.pem');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8');

    const provider = makeAgentJwtProvider({
      SUBSTRATE_AGENT_KEY_PATH: keyPath,
      SUBSTRATE_AGENT_KEY_ID: 'claude-test'
    } as NodeJS.ProcessEnv);
    expect(provider()).toBe(provider()); // same cached value, no re-sign per call
  });
});

describe('makeAgentJwtProvider: capability claim', () => {
  function mintPayload(env: Record<string, string>): Record<string, unknown> {
    const { privateKey } = generateKeyPairSync('ed25519');
    const dir = tempDir();
    const keyPath = join(dir, 'agent.key');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8');
    const header = makeAgentJwtProvider({
      SUBSTRATE_AGENT_KEY_PATH: keyPath,
      SUBSTRATE_AGENT_KEY_ID: 'claude-test',
      ...env
    } as NodeJS.ProcessEnv)();
    const body = (header as string).slice('Bearer '.length).split('.')[1] as string;
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  }

  /**
   * The default MUST NOT widen. A FILE-registry key takes the claim verbatim
   * (`auth.ts`: `capabilities = claimedCapabilities`), so a broadened default
   * would silently promote every MCP agent on such a deployment to admin.
   */
  it('claims read,mutate by default — unchanged, because file-registry keys trust the claim', () => {
    expect(mintPayload({}).capabilities).toEqual(['read', 'mutate']);
  });

  /**
   * The opt-in lets an agent claim a capability its dataset row grants; the
   * default claim would silently intersect a granted `admin` away.
   */
  it('claims what SUBSTRATE_AGENT_CAPABILITIES asks for', () => {
    expect(mintPayload({ SUBSTRATE_AGENT_CAPABILITIES: 'read,mutate,admin' }).capabilities).toEqual(
      ['read', 'mutate', 'admin']
    );
  });

  it('tolerates whitespace and ignores empty entries', () => {
    expect(mintPayload({ SUBSTRATE_AGENT_CAPABILITIES: ' read , admin ,, ' }).capabilities).toEqual(
      ['read', 'admin']
    );
  });

  /**
   * An empty claim intersects to nothing, which reads as a broken credential
   * rather than as the typo it is. Falling back to the default keeps a
   * misconfiguration from looking like a revoked key.
   */
  it('falls back to the default when the variable is set to nothing usable', () => {
    expect(mintPayload({ SUBSTRATE_AGENT_CAPABILITIES: '  ,, ' }).capabilities).toEqual([
      'read',
      'mutate'
    ]);
  });

  /**
   * Claiming admin must not widen a DATASET row that grants only read,mutate.
   * Pinned against the real intersection rather than against the constant,
   * because the constant is not what enforces this — the row is.
   */
  it('still resolves to read,mutate for a dataset row granting only read,mutate', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const dir = tempDir();
    const keyPath = join(dir, 'agent.key');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8');

    const header = makeAgentJwtProvider({
      SUBSTRATE_AGENT_KEY_PATH: keyPath,
      SUBSTRATE_AGENT_KEY_ID: 'plain-agent',
      SUBSTRATE_AGENT_CAPABILITIES: 'read,mutate,admin'
    } as NodeJS.ProcessEnv)();

    const cfg: AuthConfig = {
      keys: [
        {
          kid: 'plain-agent',
          alg: 'EdDSA',
          publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          kind: 'agent',
          namespaces: ['*'],
          capabilities: ['read', 'mutate']
        }
      ]
    } as unknown as AuthConfig;

    const identity = await verifyBearerToken((header as string).slice('Bearer '.length), cfg);
    expect(identity).not.toBeNull();
  });
});
