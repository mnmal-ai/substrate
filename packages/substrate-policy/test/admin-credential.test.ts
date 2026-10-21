import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_CAPABILITIES,
  isEncryptedKey,
  makeTokenProvider,
  resolveAdminCredential
} from '../src/index.js';

function keyFile(dir: string, name: string, passphrase?: string): string {
  const { privateKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding:
      passphrase === undefined
        ? { type: 'pkcs8', format: 'pem' }
        : { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }
  });
  const path = join(dir, name);
  writeFileSync(path, privateKey, { mode: 0o600 });
  return path;
}

describe('encrypted keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-policy-'));

  it('isEncryptedKey tells the two PEM kinds apart', () => {
    expect(isEncryptedKey(keyFile(dir, 'plain.key'))).toBe(false);
    expect(isEncryptedKey(keyFile(dir, 'enc.key', 'pw'))).toBe(true);
  });

  it('makeTokenProvider signs with an encrypted key given its passphrase', () => {
    const path = keyFile(dir, 'enc2.key', 'pw');
    const jwt = makeTokenProvider(
      { keyPath: path, kid: 'k' },
      { passphrase: 'pw', capabilities: ADMIN_CAPABILITIES }
    )();
    expect(jwt.split('.')).toHaveLength(3);
  });

  it('a wrong passphrase throws at construction (not at first mint)', () => {
    const path = keyFile(dir, 'enc3.key', 'pw');
    expect(() => makeTokenProvider({ keyPath: path, kid: 'k' }, { passphrase: 'nope' })).toThrow();
  });
});

describe('resolveAdminCredential', () => {
  it('SUBSTRATE_ADMIN_TOKEN wins and is returned as an Authorization value', () => {
    expect(resolveAdminCredential({ SUBSTRATE_ADMIN_TOKEN: 't' })).toEqual({
      kind: 'token',
      authorization: 'Bearer t'
    });
    expect(resolveAdminCredential({ SUBSTRATE_ADMIN_TOKEN: 'Bearer t' })).toEqual({
      kind: 'token',
      authorization: 'Bearer t'
    });
  });

  it('an explicit key reads its kid from the .kid file beside it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'substrate-policy-'));
    const path = keyFile(dir, 'ops.key');
    writeFileSync(join(dir, 'ops.kid'), 'ops-admin@Box\n');
    expect(resolveAdminCredential({ SUBSTRATE_ADMIN_KEY_PATH: path })).toEqual({
      kind: 'key',
      keyPath: path,
      kid: 'ops-admin@Box'
    });
  });

  it('defaults to ~/.config/substrate/admin.key + admin.kid under HOME', () => {
    const home = mkdtempSync(join(tmpdir(), 'substrate-home-'));
    mkdirSync(join(home, '.config', 'substrate'), { recursive: true });
    const path = keyFile(join(home, '.config', 'substrate'), 'admin.key');
    writeFileSync(join(home, '.config', 'substrate', 'admin.kid'), 'genesis');
    expect(resolveAdminCredential({ HOME: home })).toEqual({
      kind: 'key',
      keyPath: path,
      kid: 'genesis'
    });
  });

  it('no kid anywhere is an error naming what to set', () => {
    const home = mkdtempSync(join(tmpdir(), 'substrate-home-'));
    const r = resolveAdminCredential({ HOME: home });
    expect(r.kind).toBe('error');
    expect(r.kind === 'error' && r.error).toMatch(
      /SUBSTRATE_ADMIN_TOKEN, or SUBSTRATE_ADMIN_KEY_ID/
    );
  });
});

describe('SUBSTRATE_ADMIN_KEY_PATH', () => {
  it('reads the kid beside the key, where bootstrap writes it', () => {
    const home = mkdtempSync(join(tmpdir(), 'substrate-policy-home-'));
    const keys = join(home, 'k');
    mkdirSync(keys);
    const keyPath = keyFile(keys, 'admin.key');
    writeFileSync(join(keys, 'admin.kid'), 'kid-beside\n');
    expect(resolveAdminCredential({ HOME: home, SUBSTRATE_ADMIN_KEY_PATH: keyPath })).toEqual({
      kind: 'key',
      keyPath,
      kid: 'kid-beside'
    });
  });
});
