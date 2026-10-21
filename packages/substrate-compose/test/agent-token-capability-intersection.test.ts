/**
 * The claim-vs-row capability intersection, driven by the REAL minter
 * (`@mnmal-ai/substrate-policy`) against the REAL verifier.
 *
 * `verifyBearerToken` narrows a dataset-backed token by intersecting the claim
 * against the row's grant: the row is the authority, the token only asks. So a
 * claim that OMITS what the row grants intersects it away — an `admin` key
 * minting a `['read', 'mutate']` claim verifies with no capabilities at all.
 *
 * The tests mint through the shipping provider rather than hand-rolling a JWT,
 * so the claim shape is checked rather than assumed.
 */

import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMIN_CAPABILITIES, makeTokenProvider } from '@mnmal-ai/substrate-policy';
import { describe, expect, it } from 'vitest';
import type { KeyRecord, KeyRegistry } from '../src/_system/registry.js';
import type { AuthConfig } from '../src/auth.js';
import { verifyBearerToken } from '../src/auth.js';
import type { Capability } from '../src/compose.js';

const KID = 'intersection-test@host';

/** An Ed25519 pair: the private key on disk for the minter, the public in the row. */
function keypair(): { keyPath: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const dir = mkdtempSync(join(tmpdir(), 'substrate-intersect-'));
  const keyPath = join(dir, 'test.key');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  return { keyPath, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

/** Minimal registry: only `lookup` participates in verification. */
function registryGranting(record: KeyRecord): KeyRegistry {
  return {
    lookup: (kid) => (kid === record.kid ? record : null),
    install: () => true,
    refresh: () => Promise.resolve(),
    evict: () => {},
    primeFromDataset: () => Promise.resolve(),
    dispose: () => {}
  };
}

function authGranting(publicKey: string, capabilities: Array<string>): AuthConfig {
  return {
    keys: [],
    keyRegistry: registryGranting({
      kid: KID,
      algorithm: 'EdDSA',
      publicKey,
      namespaces: ['*'],
      capabilities,
      revokedAt: null
    })
  };
}

describe('capability intersection — claimed vs the registry row', () => {
  it('intersects an admin-only row to NOTHING when the token claims the default', async () => {
    // The intersection is the security property and narrowing is correct. This
    // pins the consequence of a claim that omits `admin`, so a provider default
    // that omits it fails here.
    const { keyPath, publicKey } = keypair();
    const jwt = makeTokenProvider({ keyPath, kid: KID })();

    const identity = await verifyBearerToken(jwt, authGranting(publicKey, ['admin']));

    expect(identity).not.toBeNull();
    expect(identity?.id).toBe(KID);
    // Empty TABLE, not an empty list: no namespace survived the intersection,
    // so there is nothing to flatten anymore.
    expect(identity?.grants).toEqual({});
  });

  it('ADMIN_CAPABILITIES reaches an admin row, and keeps `read` — which the query route gates on', async () => {
    const { keyPath, publicKey } = keypair();
    const jwt = makeTokenProvider({ keyPath, kid: KID }, { capabilities: ADMIN_CAPABILITIES })();

    const identity = await verifyBearerToken(
      jwt,
      authGranting(publicKey, ['read', 'mutate', 'admin'])
    );

    expect(identity?.grants?.['*']).toEqual(expect.arrayContaining(['read', 'admin']));
  });

  it('still cannot widen past the row — claiming admin against a read-only grant yields read alone', async () => {
    // The direction that must NOT regress while fixing the other one. A token
    // asks; the row decides.
    const { keyPath, publicKey } = keypair();
    const jwt = makeTokenProvider({ keyPath, kid: KID }, { capabilities: ADMIN_CAPABILITIES })();

    const identity = await verifyBearerToken(jwt, authGranting(publicKey, ['read']));

    expect(identity?.grants).toEqual({ '*': ['read'] });
  });

  it('narrows namespaces the same way, and the claim can omit them into nothing too', async () => {
    const { keyPath, publicKey } = keypair();
    const jwt = makeTokenProvider({ keyPath, kid: KID }, { namespaces: ['journal'] })();

    const scoped: AuthConfig = {
      keys: [],
      keyRegistry: registryGranting({
        kid: KID,
        algorithm: 'EdDSA',
        publicKey,
        namespaces: ['recall'],
        capabilities: ['read'],
        revokedAt: null
      })
    };

    expect((await verifyBearerToken(jwt, scoped))?.grants).toEqual({});
  });
});

describe('ADMIN_CAPABILITIES exhaustiveness', () => {
  it('names every Capability — so adding one breaks the BUILD, not a token', () => {
    // The guard, and the reason it is a `Record` rather than an array literal:
    // adding a member to `Capability` without adding it here is a COMPILE
    // error, which is the only form of this check that cannot be forgotten.
    //
    // Why the list is not simply `['*']`: both gates that consume capabilities
    // do a bare membership test with no wildcard case — `withAuth`'s
    // `have.includes(required)` and `requireCapability`'s `caps.includes(name)`.
    // A `'*'` row against a `'*'` claim resolves to the literal `['*']` and is
    // refused everything. The namespace claim gets away with `['*']` because
    // nothing downstream does a membership test on it.
    const everyCapability: Record<Capability, true> = { read: true, mutate: true, admin: true };

    expect([...ADMIN_CAPABILITIES].sort()).toEqual(Object.keys(everyCapability).sort());
  });

  it('is a superset of the default claim — so opting in never narrows anything', () => {
    // A caller swapping the default for ADMIN_CAPABILITIES must not lose a
    // capability in the trade. Pins the relationship rather than the contents.
    const provider = makeTokenProvider({ keyPath: keypair().keyPath, kid: KID });
    const claimed = JSON.parse(Buffer.from(provider().split('.')[1]!, 'base64url').toString('utf8'))
      .capabilities as Array<string>;

    for (const c of claimed) expect(ADMIN_CAPABILITIES).toContain(c);
  });
});

describe('identity of a dataset-backed key', () => {
  it('is the verified kid, never the claimed sub', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const input = `${b64({ alg: 'EdDSA', kid: KID })}.${b64({
      sub: 'victim@host',
      exp: Math.floor(Date.now() / 1000) + 60,
      ns: ['*'],
      capabilities: ['read']
    })}`;
    const jwt = `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const identity = await verifyBearerToken(jwt, authGranting(pem, ['read']));
    expect(identity?.id).toBe(KID);
  });
});
