import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { KeyRecord, KeyRegistry } from '../src/_system/registry.js';
import {
  type AuthConfig,
  diagnoseBearerToken,
  rejectionDetail,
  signEdDSA,
  verifyBearerToken
} from '../src/auth.js';

/**
 * `diagnoseBearerToken` names the half of a bearer check that failed wherever
 * naming it leaks nothing, and stays silent where it would be an oracle.
 */

const KID = 'diagnosis@host';

function keypair(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
  };
}

function registry(record: KeyRecord): KeyRegistry {
  return {
    lookup: (kid) => (kid === record.kid ? record : null),
    install: () => true,
    refresh: () => Promise.resolve(),
    evict: () => {},
    primeFromDataset: () => Promise.resolve(),
    dispose: () => {}
  };
}

function cfgFor(publicPem: string): AuthConfig {
  return {
    keys: [],
    keyRegistry: registry({
      kid: KID,
      algorithm: 'EdDSA',
      publicKey: publicPem,
      namespaces: ['*'],
      capabilities: ['read', 'mutate', 'admin'],
      revokedAt: null
    })
  };
}

function mint(privatePem: string, payload: Record<string, unknown>, kid: string = KID): string {
  return signEdDSA(payload, privatePem, { kid });
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { sub: KID, iat: now, exp: now + 300, ns: ['*'], capabilities: ['read'], ...overrides };
}

describe('diagnoseBearerToken', () => {
  it('returns null for a valid token — there is nothing to explain', async () => {
    const { privatePem, publicPem } = keypair();
    const cfg = cfgFor(publicPem);
    const jwt = mint(privatePem, validPayload());
    expect(await verifyBearerToken(jwt, cfg)).not.toBeNull();
    expect(diagnoseBearerToken(jwt, cfg)).toBeNull();
  });

  it('names an expired token — the operator hunts the clock, not the key', async () => {
    const { privatePem, publicPem } = keypair();
    const cfg = cfgFor(publicPem);
    const now = Math.floor(Date.now() / 1000);
    const jwt = mint(privatePem, validPayload({ exp: now - 60 }));
    expect(await verifyBearerToken(jwt, cfg)).toBeNull();
    expect(diagnoseBearerToken(jwt, cfg)).toBe('expired');
  });

  it('names a missing ns claim on EdDSA — "claims less than its key holds" verbatim', async () => {
    // The key holds `*`, the token claims no namespaces at all: verification
    // fails AFTER the signature proved the key, so the 401 can name that half.
    const { privatePem, publicPem } = keypair();
    const cfg = cfgFor(publicPem);
    const payload = validPayload();
    delete payload.ns;
    const jwt = mint(privatePem, payload);
    expect(await verifyBearerToken(jwt, cfg)).toBeNull();
    expect(diagnoseBearerToken(jwt, cfg)).toBe('malformed_claim:ns');
  });

  it('names an empty ns claim the same way — claiming nothing is malformed, not unauthorized', async () => {
    const { privatePem, publicPem } = keypair();
    const cfg = cfgFor(publicPem);
    const jwt = mint(privatePem, validPayload({ ns: [] }));
    expect(await verifyBearerToken(jwt, cfg)).toBeNull();
    expect(diagnoseBearerToken(jwt, cfg)).toBe('malformed_claim:ns');
  });

  it('names not-yet-valid and malformed shapes without touching keys', async () => {
    const { privatePem, publicPem } = keypair();
    const cfg = cfgFor(publicPem);
    const now = Math.floor(Date.now() / 1000);
    expect(diagnoseBearerToken(mint(privatePem, validPayload({ nbf: now + 600 })), cfg)).toBe(
      'not_yet_valid'
    );
    expect(diagnoseBearerToken('not.a.jwt.at.all', cfg)).toBe('malformed_token');
    expect(diagnoseBearerToken(mint(privatePem, validPayload(), KID), cfg)).toBeNull();
  });

  it('unknown kid and wrong signature stay byte-identical — the oracle guard', async () => {
    // THE load-bearing property. Distinguishing "no such kid" from "bad
    // signature" lets a prober holding no private key learn which kids are
    // registered. Both must collapse to null here (and to the bare 401 body
    // downstream) — this test fails the day someone "helpfully" names them.
    const { publicPem } = keypair();
    const cfg = cfgFor(publicPem);
    const other = keypair();

    const unknownKid = mint(other.privatePem, validPayload(), 'nobody@nowhere');
    const wrongSig = mint(other.privatePem, validPayload(), KID);

    expect(await verifyBearerToken(unknownKid, cfg)).toBeNull();
    expect(await verifyBearerToken(wrongSig, cfg)).toBeNull();
    expect(diagnoseBearerToken(unknownKid, cfg)).toBeNull();
    expect(diagnoseBearerToken(wrongSig, cfg)).toBeNull();
  });
});

describe('audience (SUBSTRATE_PUBLIC_ORIGIN)', () => {
  const ORIGIN = 'https://host:3100';

  it('explains wrong_audience by naming the setting that decides it', () => {
    expect(rejectionDetail('wrong_audience')).toMatch(/SUBSTRATE_PUBLIC_ORIGIN/);
  });

  it('when set, refuses an aud naming another origin and admits a match or no aud', () => {
    const { privatePem, publicPem } = keypair();
    const cfg = { ...cfgFor(publicPem), audiences: ['https://other:3100', ORIGIN] };
    const check = (aud?: unknown) =>
      diagnoseBearerToken(mint(privatePem, validPayload(aud === undefined ? {} : { aud })), cfg);
    expect(check('https://elsewhere:3100')).toBe('wrong_audience');
    expect(check(['https://elsewhere:3100'])).toBe('wrong_audience');
    expect(check(ORIGIN)).toBeNull();
    expect(check(['https://elsewhere:3100', ORIGIN])).toBeNull();
    expect(check()).toBeNull();
  });

  it('when unset, does not check aud', () => {
    const { privatePem, publicPem } = keypair();
    const jwt = mint(privatePem, validPayload({ aud: 'https://elsewhere:3100' }));
    expect(diagnoseBearerToken(jwt, cfgFor(publicPem))).toBeNull();
  });
});
