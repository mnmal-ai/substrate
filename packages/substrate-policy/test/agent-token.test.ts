import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_CAPABILITIES,
  adminClaimCapabilities,
  makeAuthorizationProvider,
  makeTokenProvider
} from '../src/agent-token.js';

function writeKey(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  const dir = mkdtempSync(join(tmpdir(), 'substrate-token-'));
  const path = join(dir, 'test.key');
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  return path;
}

function decode(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

describe('makeTokenProvider', () => {
  // Return format (a bare JWT, no `Bearer ` prefix) is asserted BEFORE the
  // claims: a prefixed token passes a claim-set assertion and a segment count.
  // The header-decodes assertion catches any prefix, because it corrupts
  // segment[0] while leaving segment[1] readable.
  it('returns the BARE jwt — no `Bearer ` prefix, and segment[0] decodes', () => {
    const provider = makeTokenProvider({ keyPath: writeKey(), kid: 'labs-prime@host' });
    const jwt = provider();

    expect(jwt.startsWith('Bearer ')).toBe(false);

    const segments = jwt.split('.');
    expect(segments).toHaveLength(3);
    expect(() => decode(segments[0]!)).not.toThrow();
  });

  it('mints the full agent claim set — the contract three copies of this signer must agree on', () => {
    const provider = makeTokenProvider({ keyPath: writeKey(), kid: 'labs-prime@host' });
    const [encodedHeader, encodedPayload] = provider().split('.');
    const header = decode(encodedHeader!);
    const payload = decode(encodedPayload!);

    expect(header.alg).toBe('EdDSA');
    expect(header.typ).toBe('JWT');
    expect(header.kid).toBe('labs-prime@host');

    expect(payload.sub).toBe('labs-prime@host');
    expect(payload.ns).toEqual(['*']);
    expect(payload.capabilities).toEqual(['read', 'mutate']);
    expect((payload.exp as number) - (payload.iat as number)).toBe(3600);
  });

  it('caches — two calls in the same window return the identical token', () => {
    const provider = makeTokenProvider({ keyPath: writeKey(), kid: 'k@h' });
    expect(provider()).toBe(provider());
  });

  // WHEN it throws is part of the contract: the key is read at construction.
  // A lazy read turns an unreadable credential into a component that boots
  // green and fails on the first authenticated request.
  it('throws at CONSTRUCTION when the key file is unreadable — fail closed, never anonymous', () => {
    expect(() => makeTokenProvider({ keyPath: '/nonexistent/no.key', kid: 'k@h' })).toThrow();
  });

  it('lazyKey defers the read to the first mint — for callers a throw would strand', () => {
    // Constructing must NOT throw; the same failure has to arrive at the mint.
    const provider = makeTokenProvider(
      { keyPath: '/nonexistent/no.key', kid: 'k@h' },
      { lazyKey: true }
    );
    expect(() => provider()).toThrow();
  });
});

describe('makeAuthorizationProvider', () => {
  it('prefixes exactly once, over the same token the bare provider yields', () => {
    const keyPath = writeKey();
    const header = makeAuthorizationProvider({ keyPath, kid: 'k@h' })();

    expect(header.startsWith('Bearer ')).toBe(true);
    expect(header.slice('Bearer '.length).startsWith('Bearer ')).toBe(false);

    const [encodedHeader] = header.slice('Bearer '.length).split('.');
    expect(decode(encodedHeader!).kid).toBe('k@h');
  });

  it('throws at construction on an unreadable key — the wrapper does not soften fail-closed', () => {
    expect(() =>
      makeAuthorizationProvider({ keyPath: '/nonexistent/no.key', kid: 'k@h' })
    ).toThrow();
  });

  it('forwards lazyKey — the wrapper must not silently re-eager its callers', () => {
    expect(() =>
      makeAuthorizationProvider({ keyPath: '/nonexistent/no.key', kid: 'k@h' }, { lazyKey: true })
    ).not.toThrow();
  });
});

describe('adminClaimCapabilities', () => {
  it('is ADMIN_CAPABILITIES when SUBSTRATE_ADMIN_CAPABILITY is unset or empty', () => {
    expect(adminClaimCapabilities({})).toEqual(ADMIN_CAPABILITIES);
    expect(adminClaimCapabilities({ SUBSTRATE_ADMIN_CAPABILITY: '' })).toEqual(ADMIN_CAPABILITIES);
  });

  it('adds a custom admin capability to the claim, keeping read and mutate', () => {
    expect(adminClaimCapabilities({ SUBSTRATE_ADMIN_CAPABILITY: 'superuser' })).toEqual([
      'read',
      'mutate',
      'admin',
      'superuser'
    ]);
  });

  it('does not duplicate a capability the default set already claims', () => {
    expect(adminClaimCapabilities({ SUBSTRATE_ADMIN_CAPABILITY: 'admin' })).toEqual(
      ADMIN_CAPABILITIES
    );
  });
});
