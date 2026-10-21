/**
 * §5.12 — JWT auth unit coverage. Round-trips a token with hand-rolled HS256
 * signing; asserts every rejection branch (bad signature, expired, `alg:
 * none`, unknown kid, malformed, missing bearer prefix).
 */

import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AuthConfig,
  AuthConfigError,
  extractBearer,
  parseAuthConfig,
  signEdDSA,
  signHs256,
  verifyBearerToken
} from '@mnmal-ai/substrate-compose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ── Shared helper ──────────────────────────────────────────────
function writeRegistry(entries: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-auth-'));
  const p = join(dir, 'keys.json');
  writeFileSync(p, JSON.stringify(entries), 'utf8');
  return p;
}

const SECRET = 'test-secret-value-at-least-32-bytes';
const KID = 'k1';

function writeKeyFile(dir: string, keys: unknown): string {
  const path = join(dir, 'keys.json');
  writeFileSync(path, JSON.stringify(keys), 'utf8');
  return path;
}

describe('auth.parseAuthConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrate-auth-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when SUBSTRATE_AUTH_KEY_REGISTRY is unset', () => {
    const out = parseAuthConfig({});
    expect(out).toBeNull();
  });

  it('returns null when SUBSTRATE_AUTH_KEY_REGISTRY is empty string', () => {
    const out = parseAuthConfig({ SUBSTRATE_AUTH_KEY_REGISTRY: '' });
    expect(out).toBeNull();
  });

  it('loads HS256 keys from disk and picks up admin capability', () => {
    const path = writeKeyFile(dir, [{ kid: KID, alg: 'HS256', publicKey: SECRET }]);
    const cfg = parseAuthConfig({
      SUBSTRATE_AUTH_KEY_REGISTRY: path,
      SUBSTRATE_ADMIN_CAPABILITY: 'role=admin'
    });
    expect(cfg?.keys).toEqual([{ kid: KID, alg: 'HS256', publicKey: SECRET, kind: 'user' }]);
    expect(cfg?.adminCapability).toBe('role=admin');
  });

  it('throws AuthConfigError when the registry file is missing', () => {
    expect(() => parseAuthConfig({ SUBSTRATE_AUTH_KEY_REGISTRY: '/no/such/file.json' })).toThrow(
      AuthConfigError
    );
  });

  it('throws AuthConfigError on malformed JSON', () => {
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{not json}', 'utf8');
    expect(() => parseAuthConfig({ SUBSTRATE_AUTH_KEY_REGISTRY: path })).toThrow(AuthConfigError);
  });

  it('throws when the array is empty', () => {
    const path = writeKeyFile(dir, []);
    expect(() => parseAuthConfig({ SUBSTRATE_AUTH_KEY_REGISTRY: path })).toThrow(/non-empty/);
  });

  it('throws on an entry missing alg', () => {
    const path = writeKeyFile(dir, [{ publicKey: SECRET }]);
    expect(() => parseAuthConfig({ SUBSTRATE_AUTH_KEY_REGISTRY: path })).toThrow(/unsupported alg/);
  });

  it('throws on an entry with unsupported alg', () => {
    const path = writeKeyFile(dir, [{ alg: 'PS256', publicKey: SECRET }]);
    expect(() => parseAuthConfig({ SUBSTRATE_AUTH_KEY_REGISTRY: path })).toThrow(/unsupported alg/);
  });

  it('throws on an entry missing publicKey', () => {
    const path = writeKeyFile(dir, [{ alg: 'HS256' }]);
    expect(() => parseAuthConfig({ SUBSTRATE_AUTH_KEY_REGISTRY: path })).toThrow(/missing string/);
  });

  it('parses SUBSTRATE_JWT_LEEWAY_SECONDS, defaulting to unset, rejecting bad values', () => {
    const path = writeKeyFile(dir, [{ kid: KID, alg: 'HS256', publicKey: SECRET }]);
    // Unset → no leeway on the config (engine treats absent as 0).
    expect(parseAuthConfig({ SUBSTRATE_AUTH_KEY_REGISTRY: path })?.leewaySeconds).toBeUndefined();
    expect(
      parseAuthConfig({ SUBSTRATE_AUTH_KEY_REGISTRY: path, SUBSTRATE_JWT_LEEWAY_SECONDS: '30' })
        ?.leewaySeconds
    ).toBe(30);
    // 0 is a valid (explicit no-skew) value, unlike the positive-int knobs.
    expect(
      parseAuthConfig({ SUBSTRATE_AUTH_KEY_REGISTRY: path, SUBSTRATE_JWT_LEEWAY_SECONDS: '0' })
        ?.leewaySeconds
    ).toBe(0);
    expect(() =>
      parseAuthConfig({ SUBSTRATE_AUTH_KEY_REGISTRY: path, SUBSTRATE_JWT_LEEWAY_SECONDS: '-5' })
    ).toThrow(AuthConfigError);
    expect(() =>
      parseAuthConfig({ SUBSTRATE_AUTH_KEY_REGISTRY: path, SUBSTRATE_JWT_LEEWAY_SECONDS: 'soon' })
    ).toThrow(/non-negative integer/);
  });
});

describe('auth.verifyBearerToken — clock-skew leeway', () => {
  const noLeeway: AuthConfig = { keys: [{ kid: KID, alg: 'HS256', publicKey: SECRET }] };
  const withLeeway: AuthConfig = {
    keys: [{ kid: KID, alg: 'HS256', publicKey: SECRET }],
    leewaySeconds: 30
  };

  it('rejects a just-expired token when no leeway is configured (unchanged default)', async () => {
    const exp = Math.floor(Date.now() / 1000) - 5;
    const token = signHs256({ sub: 'home', exp }, SECRET, { kid: KID });
    expect(await verifyBearerToken(token, noLeeway)).toBeNull();
  });

  it('accepts a token expired within the leeway window', async () => {
    const exp = Math.floor(Date.now() / 1000) - 5; // 5s past, inside 30s leeway
    const token = signHs256({ sub: 'home', exp }, SECRET, { kid: KID });
    expect((await verifyBearerToken(token, withLeeway))?.id).toBe('home');
  });

  it('still rejects a token expired beyond the leeway window', async () => {
    const exp = Math.floor(Date.now() / 1000) - 120; // 2m past, beyond 30s
    const token = signHs256({ sub: 'home', exp }, SECRET, { kid: KID });
    expect(await verifyBearerToken(token, withLeeway)).toBeNull();
  });

  it('accepts a not-yet-valid (nbf) token within the leeway window', async () => {
    const nbf = Math.floor(Date.now() / 1000) + 5; // 5s future, inside 30s leeway
    const token = signHs256({ sub: 'home', nbf }, SECRET, { kid: KID });
    expect((await verifyBearerToken(token, withLeeway))?.id).toBe('home');
  });

  it('still rejects an nbf token beyond the leeway window', async () => {
    const nbf = Math.floor(Date.now() / 1000) + 120;
    const token = signHs256({ sub: 'home', nbf }, SECRET, { kid: KID });
    expect(await verifyBearerToken(token, withLeeway)).toBeNull();
  });
});

describe('auth.verifyBearerToken', () => {
  const cfg: AuthConfig = {
    keys: [{ kid: KID, alg: 'HS256', publicKey: SECRET }]
  };

  it('verifies a freshly signed HS256 token and extracts sub + grant', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signHs256(
      {
        sub: 'home',
        exp: now + 60,
        capabilities: ['role=admin', 'bridge=cal']
      },
      SECRET,
      { kid: KID }
    );
    const id = await verifyBearerToken(token, cfg);
    expect(id).not.toBeNull();
    expect(id?.id).toBe('home');
    // No ns claim: legacy wildcard, expanded to the cross product it means.
    expect(id?.grants).toEqual({ '*': ['bridge=cal', 'role=admin'] });
  });

  it('accepts tokens without kid when only one key is registered', async () => {
    const noKidCfg: AuthConfig = {
      keys: [{ alg: 'HS256', publicKey: SECRET }]
    };
    const token = signHs256({ sub: 'x' }, SECRET);
    const id = await verifyBearerToken(token, noKidCfg);
    expect(id?.id).toBe('x');
  });

  it('rejects a tampered signature', async () => {
    const token = signHs256({ sub: 'home' }, SECRET, { kid: KID });
    const tampered = `${token.slice(0, -4)}aaaa`;
    expect(await verifyBearerToken(tampered, cfg)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = signHs256({ sub: 'home' }, 'different-secret', { kid: KID });
    expect(await verifyBearerToken(token, cfg)).toBeNull();
  });

  it('rejects expired tokens', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const token = signHs256({ sub: 'home', exp: past }, SECRET, { kid: KID });
    expect(await verifyBearerToken(token, cfg)).toBeNull();
  });

  it('rejects not-yet-valid (nbf) tokens', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const token = signHs256({ sub: 'home', nbf: future }, SECRET, { kid: KID });
    expect(await verifyBearerToken(token, cfg)).toBeNull();
  });

  it('rejects alg: none', async () => {
    const encode = (o: unknown): string =>
      Buffer.from(JSON.stringify(o), 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    const token = `${encode({ alg: 'none' })}.${encode({ sub: 'home' })}.`;
    expect(await verifyBearerToken(token, cfg)).toBeNull();
  });

  it('rejects malformed segments', async () => {
    expect(await verifyBearerToken('not-a-jwt', cfg)).toBeNull();
    expect(await verifyBearerToken('a.b', cfg)).toBeNull();
    expect(await verifyBearerToken('a..c', cfg)).toBeNull();
  });

  it('selects by kid in a multi-key registry, and falls back to alg-matching keys for an unknown kid', async () => {
    const cfgMulti: AuthConfig = {
      keys: [
        { kid: 'k1', alg: 'HS256', publicKey: 'secret-a' },
        { kid: 'k2', alg: 'HS256', publicKey: 'secret-b' }
      ]
    };
    const tokenKid2 = signHs256({ sub: 'home' }, 'secret-b', { kid: 'k2' });
    expect(await verifyBearerToken(tokenKid2, cfgMulti)).not.toBeNull();
    // An unknown kid is not itself a rejection: the signature is tried against
    // every key of the token's alg, so it verifies only if one of them signed it.
    const cfgK1: AuthConfig = { keys: [{ kid: 'k1', alg: 'HS256', publicKey: SECRET }] };
    const unknownKid = signHs256({ sub: 'home' }, SECRET, { kid: 'unknown-kid' });
    expect(await verifyBearerToken(unknownKid, cfgK1)).not.toBeNull();
  });

  it('rejects an unknown kid whose signature matches no registered key', async () => {
    const cfgMulti: AuthConfig = {
      keys: [
        { kid: 'k1', alg: 'HS256', publicKey: 'secret-a' },
        { kid: 'k2', alg: 'HS256', publicKey: 'secret-b' }
      ]
    };
    const token = signHs256({ sub: 'home' }, 'unregistered-secret', { kid: 'unknown-kid' });
    expect(await verifyBearerToken(token, cfgMulti)).toBeNull();
  });

  it('falls back to sub="anonymous" when the payload omits sub', async () => {
    const token = signHs256({ capabilities: ['x'] }, SECRET, { kid: KID });
    const id = await verifyBearerToken(token, cfg);
    expect(id?.id).toBe('anonymous');
  });

  it('HS256 round-trip via a multi-key registry picks the right secret', async () => {
    const multi: AuthConfig = {
      keys: [
        { kid: 'old', alg: 'HS256', publicKey: 'old-secret' },
        { kid: 'new', alg: 'HS256', publicKey: 'new-secret' }
      ]
    };
    const oldToken = signHs256({ sub: 'a' }, 'old-secret', { kid: 'old' });
    const newToken = signHs256({ sub: 'b' }, 'new-secret', { kid: 'new' });
    const mismatched = signHs256({ sub: 'c' }, 'old-secret', { kid: 'new' });
    expect((await verifyBearerToken(oldToken, multi))?.id).toBe('a');
    expect((await verifyBearerToken(newToken, multi))?.id).toBe('b');
    expect(await verifyBearerToken(mismatched, multi)).toBeNull();
  });
});

describe('auth.extractBearer', () => {
  it('extracts the token from a Bearer header', () => {
    expect(extractBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearer('bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('returns null for missing / malformed headers', () => {
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer('abc.def.ghi')).toBeNull();
    expect(extractBearer('Bearer ')).toBeNull();
    expect(extractBearer('Bearer')).toBeNull();
  });
});

describe('auth.verifyBearerToken — Ed25519', () => {
  function makeEd25519Config(kid: string): {
    cfg: AuthConfig;
    privateKey: KeyObject;
  } {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const cfg: AuthConfig = { keys: [{ kid, alg: 'EdDSA', publicKey: pem }] };
    return { cfg, privateKey };
  }

  it('round-trips an Ed25519 JWT and derives the grant from the ns claim', async () => {
    const { cfg, privateKey } = makeEd25519Config('ed1');
    const token = signEdDSA(
      {
        sub: 'home',
        exp: Math.floor(Date.now() / 1000) + 60,
        capabilities: ['read'],
        ns: ['claude']
      },
      privateKey,
      { kid: 'ed1' }
    );
    const id = await verifyBearerToken(token, cfg);
    expect(id).not.toBeNull();
    expect(id?.id).toBe('home');
    expect(id?.grants).toEqual({ claude: ['read'] });
  });

  it('rejects Ed25519 tokens without an ns claim', async () => {
    const { cfg, privateKey } = makeEd25519Config('ed1');
    // exp present so the rejection exercises the ns branch, not exp-absence.
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = signEdDSA({ sub: 'home', exp, capabilities: ['read'] }, privateKey, {
      kid: 'ed1'
    });
    expect(await verifyBearerToken(token, cfg)).toBeNull();
  });

  it('rejects Ed25519 tokens without an exp claim (no forever-credentials)', async () => {
    const { cfg, privateKey } = makeEd25519Config('ed1');
    const token = signEdDSA({ sub: 'home', ns: ['claude'], capabilities: ['read'] }, privateKey, {
      kid: 'ed1'
    });
    expect(await verifyBearerToken(token, cfg)).toBeNull();
  });

  it('rejects tokens whose exp is present but malformed (non-number)', async () => {
    const { cfg, privateKey } = makeEd25519Config('ed1');
    const token = signEdDSA({ sub: 'home', exp: 'never', ns: ['claude'] }, privateKey, {
      kid: 'ed1'
    });
    expect(await verifyBearerToken(token, cfg)).toBeNull();
    // Same stance for legacy HS256 — present-but-malformed always rejects.
    const hsCfg: AuthConfig = { keys: [{ kid: KID, alg: 'HS256', publicKey: SECRET }] };
    const hsToken = signHs256({ sub: 'a', exp: 'never' }, SECRET, { kid: KID });
    expect(await verifyBearerToken(hsToken, hsCfg)).toBeNull();
  });

  it('rejects Ed25519 tokens where ns is malformed (not an array, empty, non-string)', async () => {
    const { cfg, privateKey } = makeEd25519Config('ed1');
    // exp present so each rejection exercises the ns branch, not exp-absence.
    const exp = Math.floor(Date.now() / 1000) + 60;
    const stringNs = signEdDSA({ sub: 'a', exp, ns: 'claude' }, privateKey, { kid: 'ed1' });
    const emptyNs = signEdDSA({ sub: 'a', exp, ns: [] }, privateKey, { kid: 'ed1' });
    const nonStringNs = signEdDSA({ sub: 'a', exp, ns: [123] }, privateKey, { kid: 'ed1' });
    expect(await verifyBearerToken(stringNs, cfg)).toBeNull();
    expect(await verifyBearerToken(emptyNs, cfg)).toBeNull();
    expect(await verifyBearerToken(nonStringNs, cfg)).toBeNull();
  });

  it('rejects Ed25519 tokens with a tampered signature', async () => {
    const { cfg, privateKey } = makeEd25519Config('ed1');
    const token = signEdDSA({ sub: 'a', ns: ['claude'] }, privateKey, { kid: 'ed1' });
    const tampered = `${token.slice(0, -4)}AAAA`;
    expect(await verifyBearerToken(tampered, cfg)).toBeNull();
  });

  it('rejects Ed25519 tokens whose signature was produced by a different keypair', async () => {
    const { cfg } = makeEd25519Config('ed1');
    const other = generateKeyPairSync('ed25519');
    const token = signEdDSA({ sub: 'a', ns: ['claude'] }, other.privateKey, { kid: 'ed1' });
    expect(await verifyBearerToken(token, cfg)).toBeNull();
  });
});

describe('auth.verifyBearerToken — ns claim back-compat', () => {
  const cfg: AuthConfig = { keys: [{ kid: KID, alg: 'HS256', publicKey: SECRET }] };

  it('HS256 without an ns claim defaults the grant to a wildcard (legacy compat)', async () => {
    const token = signHs256({ sub: 'a' }, SECRET, { kid: KID });
    const id = await verifyBearerToken(token, cfg);
    expect(id?.grants).toEqual({ '*': [] });
  });

  it('HS256 with an explicit ns claim grants exactly those namespaces', async () => {
    const token = signHs256({ sub: 'a', ns: ['claude', 'sentinel'] }, SECRET, { kid: KID });
    const id = await verifyBearerToken(token, cfg);
    expect(id?.grants).toEqual({ claude: [], sentinel: [] });
  });

  it('HS256 with a malformed ns claim rejects (no legacy wildcard fallback)', async () => {
    const emptyNs = signHs256({ sub: 'a', ns: [] }, SECRET, { kid: KID });
    const stringNs = signHs256({ sub: 'a', ns: 'claude' }, SECRET, { kid: KID });
    expect(await verifyBearerToken(emptyNs, cfg)).toBeNull();
    expect(await verifyBearerToken(stringNs, cfg)).toBeNull();
  });
});

// ── AuthKey.kind parsing ─────────────────────────────────────────────

describe('auth.parseAuthConfig kind', () => {
  it('parses kind:agent on a file key (default user)', () => {
    const p = writeRegistry([
      { kid: 'agent-1', alg: 'EdDSA', publicKey: 'pk', kind: 'agent' },
      { kid: 'user-1', alg: 'EdDSA', publicKey: 'pk2' }
    ]);
    const cfg = parseAuthConfig({ SUBSTRATE_AUTH_KEY_REGISTRY: p } as NodeJS.ProcessEnv);
    expect(cfg?.keys[0]?.kind).toBe('agent');
    expect(cfg?.keys[1]?.kind).toBe('user');
  });

  it('rejects an unknown kind value', () => {
    const p = writeRegistry([{ alg: 'EdDSA', publicKey: 'pk', kind: 'robot' }]);
    expect(() => parseAuthConfig({ SUBSTRATE_AUTH_KEY_REGISTRY: p } as NodeJS.ProcessEnv)).toThrow(
      /kind/
    );
  });
});

// ── buildIdentity agent attribution for file kind:'agent' keys ────────

describe('auth.verifyBearerToken — file key kind attribution', () => {
  it('file key with kind:agent attributes as agent', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const p = writeRegistry([{ kid: 'claude-1', alg: 'EdDSA', publicKey: pubPem, kind: 'agent' }]);
    const cfg = parseAuthConfig({ SUBSTRATE_AUTH_KEY_REGISTRY: p } as NodeJS.ProcessEnv)!;
    const now = Math.floor(Date.now() / 1000);
    const jwt = signEdDSA(
      { sub: 'claude-1', iat: now, exp: now + 300, ns: ['*'], capabilities: ['read', 'mutate'] },
      privateKey,
      { kid: 'claude-1' }
    );
    const identity = await verifyBearerToken(jwt, cfg);
    expect(identity?.agentKeyId).toBe('claude-1');
    expect(identity?.tokenId).toBeUndefined();
  });

  it('file key without kind attributes as user', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const p = writeRegistry([{ kid: 'op-1', alg: 'EdDSA', publicKey: pubPem }]);
    const cfg = parseAuthConfig({ SUBSTRATE_AUTH_KEY_REGISTRY: p } as NodeJS.ProcessEnv)!;
    const now = Math.floor(Date.now() / 1000);
    const jwt = signEdDSA(
      { sub: 'op-1', iat: now, exp: now + 300, ns: ['*'], capabilities: ['read'] },
      privateKey,
      { kid: 'op-1' }
    );
    const identity = await verifyBearerToken(jwt, cfg);
    expect(identity?.tokenId).toBe('op-1');
    expect(identity?.agentKeyId).toBeUndefined();
  });
});

// ── AuthConfig.mode + SUBSTRATE_AUTH_MODE parsing ────────────────────────

describe('auth.parseAuthConfig mode', () => {
  it('defaults mode to required and accepts attribute', () => {
    const p = writeRegistry([{ alg: 'EdDSA', publicKey: 'pk' }]);
    expect(parseAuthConfig({ SUBSTRATE_AUTH_KEY_REGISTRY: p } as NodeJS.ProcessEnv)?.mode).toBe(
      'required'
    );
    expect(
      parseAuthConfig({
        SUBSTRATE_AUTH_KEY_REGISTRY: p,
        SUBSTRATE_AUTH_MODE: 'attribute'
      } as NodeJS.ProcessEnv)?.mode
    ).toBe('attribute');
  });

  it('rejects an unknown SUBSTRATE_AUTH_MODE', () => {
    const p = writeRegistry([{ alg: 'EdDSA', publicKey: 'pk' }]);
    expect(() =>
      parseAuthConfig({
        SUBSTRATE_AUTH_KEY_REGISTRY: p,
        SUBSTRATE_AUTH_MODE: 'loose'
      } as NodeJS.ProcessEnv)
    ).toThrow(/SUBSTRATE_AUTH_MODE/);
  });
});

describe('auth.parseAuthConfig — enabling auth', () => {
  const PG = 'postgres://substrate:pw@127.0.0.1:5433/substrate_x';

  it('SUBSTRATE_AUTH_MODE alone enables auth when the store is postgres', () => {
    // Regression: SUBSTRATE_AUTH_MODE must be read even with no file registry, or
    // setting it alone silently leaves every call anonymous.
    const cfg = parseAuthConfig({ SUBSTRATE_AUTH_MODE: 'attribute', SUBSTRATE_DATABASE_URL: PG });
    expect(cfg).not.toBeNull();
    expect(cfg?.mode).toBe('attribute');
    // No file registry configured — every key comes from the database.
    expect(cfg?.keys).toEqual([]);
  });

  it('refuses to boot when auth is requested but no key source exists', () => {
    // No file registry and a non-pg store means there is nowhere for a key to
    // come from. Booting would produce an auth-enabled stack that can never
    // authenticate anyone.
    expect(() =>
      parseAuthConfig({ SUBSTRATE_AUTH_MODE: 'attribute', SUBSTRATE_DATABASE_URL: 'memory' })
    ).toThrow(/key source/);
    expect(() => parseAuthConfig({ SUBSTRATE_AUTH_MODE: 'required' })).toThrow(/key source/);
  });

  it('still returns null when neither variable is set', () => {
    expect(parseAuthConfig({ SUBSTRATE_DATABASE_URL: PG })).toBeNull();
  });

  it('a file registry alone still enables auth, defaulting to required mode', () => {
    // A deployment that sets only SUBSTRATE_AUTH_KEY_REGISTRY must keep auth ON.
    const dir = mkdtempSync(join(tmpdir(), 'substrate-auth-union-'));
    const path = join(dir, 'keys.json');
    writeFileSync(path, JSON.stringify([{ alg: 'HS256', publicKey: SECRET }]), 'utf8');
    const cfg = parseAuthConfig({ SUBSTRATE_AUTH_KEY_REGISTRY: path });
    expect(cfg).not.toBeNull();
    expect(cfg?.mode).toBe('required');
    expect(cfg?.keys).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
