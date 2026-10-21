/**
 * A file-registry identity carries a real `grants`.
 *
 * `verifyBearerToken` expands the flat claim into the cross product at
 * construction, which is what a flat grant MEANS — the same thing
 * `parseGrantEntries` builds for a bare `--ns` entry. These identities are
 * therefore `dimensional`, so the engine's per-frame gate asks them the
 * capability question the ROUTE gate does. Hand-constructed flat identities
 * (direct-call tests, system actors) carry no `grants` and stay
 * non-dimensional.
 */

import type { Identity } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { type AuthConfig, signHs256, verifyBearerToken } from '../src/auth.js';

const SECRET = 'file-registry-secret-value-long-enough';
const KID = 'file-key';
const CFG: AuthConfig = {
  mode: 'attribute',
  keys: [{ kid: KID, alg: 'HS256', publicKey: SECRET }]
};

const token = (capabilities: string[], ns: string[]): string =>
  signHs256(
    { sub: 'operator@host', capabilities, ns, exp: Math.floor(Date.now() / 1000) + 300 },
    SECRET,
    { kid: KID }
  );

describe('file-registry identities carry a grant', () => {
  it('gets one, where before it got only the flat lists', async () => {
    const identity = (await verifyBearerToken(
      token(['read', 'mutate'], ['journal', 'board']),
      CFG
    )) as Identity;

    expect(identity.grants).toEqual({ journal: ['mutate', 'read'], board: ['mutate', 'read'] });
  });

  it('INVENTS NO AUTHORITY — the grant says exactly what the flat claim said', async () => {
    // A flat claim IS the cross product; expanding it reports the same
    // authority without the flat fields.
    const identity = (await verifyBearerToken(token(['read'], ['journal']), CFG)) as Identity;

    expect(identity.grants).toEqual({ journal: ['read'] });
    // And the flat fields are ABSENT — nothing left to agree or disagree.
    expect('namespaces' in identity).toBe(false);
    expect('capabilities' in identity).toBe(false);
  });

  it('a wildcard claim stays a wildcard rather than being enumerated', async () => {
    const identity = (await verifyBearerToken(token(['read'], ['*']), CFG)) as Identity;

    // Enumerating it against the hosted namespaces would freeze the grant at
    // whatever was installed the moment the token was verified.
    expect(identity.grants).toEqual({ '*': ['read'] });
  });

  it('an empty capability claim yields a grant that confers nothing, not one that confers all', async () => {
    const identity = (await verifyBearerToken(token([], ['journal']), CFG)) as Identity;

    expect(identity.grants).toEqual({ journal: [] });
  });
});
