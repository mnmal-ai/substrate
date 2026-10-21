import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { expandHome, readPublicKey } from '../src/keys/pubkey.js';

type Pair = { publicKey: KeyObject; privateKey: KeyObject };

const pub = (type: 'ed25519' | 'rsa' | 'ec', namedCurve = 'prime256v1') => {
  const { publicKey, privateKey }: Pair =
    type === 'rsa'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : type === 'ec'
        ? generateKeyPairSync('ec', { namedCurve })
        : generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  };
};

// The register route's formula (substrate-compose routes/keys.ts + shared.ts base64Url), spelled out.
const routeFingerprint = (pem: string): string => {
  const b64 = createHash('sha256').update(pem).digest().toString('base64');
  return `sha256:${b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 8)}`;
};

const FIXED_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=
-----END PUBLIC KEY-----
`;

describe('readPublicKey', () => {
  it('ed25519 → EdDSA, rsa → RS256, P-256 → ES256', () => {
    expect(readPublicKey(pub('ed25519').pub)).toMatchObject({ ok: true, algorithm: 'EdDSA' });
    expect(readPublicKey(pub('rsa').pub)).toMatchObject({ ok: true, algorithm: 'RS256' });
    expect(readPublicKey(pub('ec', 'prime256v1').pub)).toMatchObject({
      ok: true,
      algorithm: 'ES256'
    });
  });
  it('fingerprints as the register route does', () => {
    const r = readPublicKey(pub('ed25519').pub);
    expect(r.ok && r.fingerprint).toMatch(/^sha256:[A-Za-z0-9_-]{8}$/);
  });
  it('matches the route formula on a fixed PEM', () => {
    const r = readPublicKey(FIXED_PEM);
    expect(r.ok && r.fingerprint).toBe(routeFingerprint(FIXED_PEM));
  });
  it('refuses a private key without echoing it', () => {
    const { priv } = pub('ed25519');
    const r = readPublicKey(priv);
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).not.toContain(priv.split('\n')[1]);
    expect(r.ok === false && r.reason).toContain('PRIVATE');
  });
  it('refuses a curve the server does not take, and garbage', () => {
    expect(readPublicKey(pub('ec', 'secp384r1').pub)).toMatchObject({ ok: false });
    expect(readPublicKey('not a pem')).toMatchObject({ ok: false });
  });
});

describe('private-key armour', () => {
  const armour = (label: string) =>
    `-----BEGIN ${label}PRIVATE KEY-----\nAAAA\n-----END ${label}PRIVATE KEY-----\n`;
  it.each(['', 'RSA ', 'EC ', 'ENCRYPTED ', 'OPENSSH ', 'DSA '])(
    'refuses a %sPRIVATE KEY block',
    (label) => {
      expect(readPublicKey(armour(label))).toMatchObject({ ok: false });
      expect(readPublicKey(armour(label))).toHaveProperty(
        'reason',
        expect.stringContaining('PRIVATE')
      );
    }
  );
  it('refuses a private block after a public one', () => {
    const r = readPublicKey(`${FIXED_PEM}${armour('')}`);
    expect(r.ok === false && r.reason).toContain('PRIVATE key');
  });
  it('does not mistake a public key for a private one because of a comment mentioning it', () => {
    const r = readPublicKey(`# not a PRIVATE KEY, the public half\n${FIXED_PEM}`);
    expect(r).toMatchObject({ ok: true, algorithm: 'EdDSA' });
  });
});

describe('expandHome', () => {
  it('expands ~ and ~/… to the home directory', () => {
    expect(expandHome('~', '/home/u')).toEqual({ path: '/home/u' });
    expect(expandHome('~/k.pub', '/home/u')).toEqual({ path: '/home/u/k.pub' });
  });
  it('leaves other paths alone', () => {
    expect(expandHome('/etc/k.pub', '/home/u')).toEqual({ path: '/etc/k.pub' });
    expect(expandHome('a~b', '/home/u')).toEqual({ path: 'a~b' });
  });
  it('refuses ~other/… rather than rewriting it as the current home', () => {
    expect(expandHome('~other/k.pub', '/home/u')).toHaveProperty('error');
  });
});
