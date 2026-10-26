/**
 * `substrate-admin` {list, revoke, rotate, register, update} CLI subcommands. Spec §5.12.
 *
 * Strategy: run the subcommand bodies against a `MemoryDataset` via the
 * `openDataset` DI seam exposed on `main`. Memory-backed coverage is enough
 * for behavioural assertions (dataset write + audit emit + lockout + flag
 * parsing); the pg-specific path is already covered by `bootstrap`'s
 * pg-gated integration test. The CLI body uses the generic `Dataset`
 * API so the memory impl and pg impl run the exact same code.
 *
 * Temp key-file paths live under a per-test `mkdtempSync` dir to avoid
 * clobbering `~/.config/substrate/admin.key`.
 */

import { createPrivateKey, generateKeyPairSync, verify } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AUDIT_EVENT_TYPE, KEY_TYPE, SYSTEM_NAMESPACE } from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import {
  type AdminCliEnv,
  AdminCliError,
  describeAdminTarget,
  formatBootstrapOutput,
  formatRevokeOutput,
  formatRotateOutput,
  isEntrypointPath,
  main,
  type OpenDatasetFn,
  type OpenedDataset,
  openPgDataset,
  parseBootstrapArgs,
  parseListArgs,
  parseRegisterArgs,
  parseRotateArgs,
  parseUpdateArgs,
  readEd25519PublicKey,
  resolveAdminAuth,
  resolveAdminTarget,
  resolveDefaultKeyPath,
  runBootstrap,
  runRegister
} from '../src/admin/index.js';

const LOCAL = 'http://localhost:3100';

/**
 * Asserts stderr holds nothing but the target banner. The banner is stripped
 * and the rest must be empty, so a real error alongside it still fails.
 */
function expectOnlyTargetBanner(err: Array<string>, command: string): void {
  const rest = err
    .join('')
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith(`${command}: targeting `));
  expect(rest).toEqual([]);
}

function makeOpener(dataset: MemoryDataset): OpenDatasetFn {
  return async (): Promise<OpenedDataset> => ({
    dataset,
    close: async () => {
      /* memory dataset has nothing to release */
    }
  });
}

async function seedKey(
  dataset: MemoryDataset,
  row: {
    id: string;
    name: string;
    namespaces: string;
    capabilities: string;
    kid?: string;
    now?: Date;
    revokedAt?: Date | null;
    publicKey?: string;
    algorithm?: string;
  }
): Promise<void> {
  const { now, ...rowFields } = row;
  await dataset.write(
    KEY_TYPE,
    [
      {
        id: rowFields.id,
        kid: rowFields.kid ?? rowFields.id,
        name: rowFields.name,
        algorithm: rowFields.algorithm ?? 'EdDSA',
        publicKey: rowFields.publicKey ?? `pk-${rowFields.id}`,
        namespaces: rowFields.namespaces,
        capabilities: rowFields.capabilities,
        revokedAt: rowFields.revokedAt ?? null
      }
    ],
    { now: now ?? new Date('2026-04-01T00:00:00.000Z'), identity: { kind: 'system', id: 'test' } }
  );
}

describe('substrate-admin list', () => {
  let dataset: MemoryDataset;
  let opener: OpenDatasetFn;
  let out: Array<string>;
  let err: Array<string>;
  const env: AdminCliEnv = { SUBSTRATE_DATABASE_URL: 'postgres://unused' };

  beforeEach(() => {
    dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    opener = makeOpener(dataset);
    out = [];
    err = [];
  });

  it('empty dataset → prints "no active Key rows", returns 0', async () => {
    const exitCode = await main(
      ['list'],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).toBe(0);
    expect(err).toHaveLength(0);
    expect(out.join('')).toMatch(/no active Key rows/);
  });

  // The table looks authoritative, so it must say which store it read: an
  // empty result from the wrong store must not pass for an empty store.
  it('the EMPTY result carries its provenance — it cannot tell an empty store from the wrong one', async () => {
    await main(
      ['list'],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    const text = out.join('');
    expect(text).toMatch(/NOT authenticated/);
    expect(text).toMatch(/SUBSTRATE_DATABASE_URL/);
    expect(text).toMatch(/doctor --url/);
  });

  it('a POPULATED table carries it too — that is where the wrong conclusion was drawn', async () => {
    await seedKey(dataset, {
      id: 'k-admin',
      name: 'operator admin',
      kid: 'admin@host',
      capabilities: 'admin',
      namespaces: '*'
    });
    await main(
      ['list'],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    const text = out.join('');
    expect(text).toMatch(/admin@host/);
    expect(text).toMatch(/NOT authenticated/);
    expect(text).toMatch(/not a check that any credential works/);
  });

  it('3 keys (2 active + 1 revoked) → prints only the 2 active rows, returns 0', async () => {
    await seedKey(dataset, {
      id: 'kidActiveA',
      name: 'alpha',
      namespaces: '*',
      capabilities: 'admin',
      now: new Date('2026-04-01T00:00:00.000Z')
    });
    await seedKey(dataset, {
      id: 'kidActiveB',
      name: 'beta',
      namespaces: 'foo',
      capabilities: 'read',
      now: new Date('2026-04-02T00:00:00.000Z')
    });
    await seedKey(dataset, {
      id: 'kidRevoked',
      name: 'gamma',
      namespaces: '*',
      capabilities: 'admin',
      now: new Date('2026-04-03T00:00:00.000Z'),
      revokedAt: new Date('2026-04-04T00:00:00.000Z')
    });

    const exitCode = await main(
      ['list'],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).toBe(0);
    const stdout = out.join('');
    expect(stdout).toContain('kidActiveA');
    expect(stdout).toContain('kidActiveB');
    expect(stdout).not.toContain('kidRevoked');
    // Header present.
    expect(stdout).toMatch(/kid\s+name\s+capabilities\s+namespaces\s+createdAt/);
    // Divider row present.
    expect(stdout).toMatch(/-----+/);
  });

  it('renders compound capabilities (e.g. "admin,read") in the capabilities column', async () => {
    await seedKey(dataset, {
      id: 'kidCompound',
      name: 'compound',
      namespaces: 'a,b',
      capabilities: 'admin,read',
      now: new Date('2026-04-01T00:00:00.000Z')
    });
    const exitCode = await main(
      ['list'],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).toBe(0);
    const stdout = out.join('');
    expect(stdout).toContain('admin,read');
    expect(stdout).toContain('a,b');
    expect(stdout).toContain('kidCompound');
  });
});

describe('substrate-admin revoke', () => {
  let dataset: MemoryDataset;
  let opener: OpenDatasetFn;
  let out: Array<string>;
  let err: Array<string>;
  const env: AdminCliEnv = { SUBSTRATE_DATABASE_URL: 'postgres://unused' };

  beforeEach(() => {
    dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    opener = makeOpener(dataset);
    out = [];
    err = [];
  });

  it('unknown kid → non-zero exit, stderr contains "no Key with kid"', async () => {
    const exitCode = await main(
      ['revoke', 'ghostKid'],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).not.toBe(0);
    expect(err.join('')).toMatch(/no Key with kid/);
  });

  it('already-revoked kid → non-zero exit, stderr contains "already revoked"', async () => {
    await seedKey(dataset, {
      id: 'kidRev',
      name: 'rev',
      namespaces: '*',
      capabilities: 'admin',
      revokedAt: new Date('2026-04-01T00:00:00.000Z')
    });
    const exitCode = await main(
      ['revoke', 'kidRev'],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).not.toBe(0);
    expect(err.join('')).toMatch(/already revoked/);
  });

  it('last-active-admin lockout → refuses', async () => {
    await seedKey(dataset, {
      id: 'kidSoleAdmin',
      name: 'sole',
      namespaces: '*',
      capabilities: 'admin'
    });
    const exitCode = await main(
      ['revoke', 'kidSoleAdmin'],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).not.toBe(0);
    expect(err.join('')).toMatch(/refusing to revoke/);
    // Row still live.
    const { rows } = await dataset.read(KEY_TYPE, { id: 'kidSoleAdmin' });
    expect(rows[0]?.revokedAt).toBeNull();
  });

  it('happy path → row revoked + key_revoked audit event written + stdout reports timestamp', async () => {
    // Two admins so the lockout guard doesn't fire.
    await seedKey(dataset, {
      id: 'kidAdminA',
      name: 'adminA',
      namespaces: '*',
      capabilities: 'admin'
    });
    await seedKey(dataset, {
      id: 'kidAdminB',
      name: 'adminB',
      namespaces: '*',
      capabilities: 'admin'
    });
    const exitCode = await main(
      ['revoke', 'kidAdminB'],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).toBe(0);
    expectOnlyTargetBanner(err, 'revoke');
    expect(out.join('')).toMatch(/Key kidAdminB revoked at /);

    const keyRead = await dataset.read(KEY_TYPE, { id: 'kidAdminB' });
    expect(keyRead.rows[0]?.revokedAt).toBeInstanceOf(Date);

    const auditRead = await dataset.read(AUDIT_EVENT_TYPE, {});
    expect(auditRead.rows).toHaveLength(1);
    const ev = auditRead.rows[0];
    expect(ev?.kind).toBe('key_revoked');
    expect(ev?.actorKid).toBe('substrate-admin-cli');

    // Row attribution, distinct from the payload's `actorKid` above: without
    // the write's `{ identity }` hint the row lands with NULL attribution while
    // the payload still names the actor.
    // The two rows are asserted differently on purpose. Revoke UPDATES the key
    // row and `created*` are immutable on merge, so only `updatedBy` moves; the
    // audit row is a fresh CREATE, so both land on the CLI.
    const actor = { kind: 'system', id: 'substrate-admin-cli' };
    expect(keyRead.rows[0]?._metadata).toMatchObject({ updatedBy: actor });
    expect((keyRead.rows[0]!._metadata as { createdBy: unknown }).createdBy).not.toBeNull();
    expect(ev?._metadata).toMatchObject({ createdBy: actor, updatedBy: actor });
    expect(ev?.targetKid).toBe('kidAdminB');
    const details = ev?.details as Record<string, unknown>;
    expect(details.cliSubcommand).toBe('revoke');
    expect(typeof details.revokedAt).toBe('string');

    // The non-revoked admin row is untouched.
    const adminA = await dataset.read(KEY_TYPE, { id: 'kidAdminA' });
    expect(adminA.rows[0]?.revokedAt).toBeNull();
  });
});

describe('substrate-admin rotate', () => {
  let dataset: MemoryDataset;
  let opener: OpenDatasetFn;
  let out: Array<string>;
  let err: Array<string>;
  let tmp: string;
  let outPath: string;
  const env: AdminCliEnv = { SUBSTRATE_DATABASE_URL: 'postgres://unused' };

  beforeEach(() => {
    dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    opener = makeOpener(dataset);
    out = [];
    err = [];
    tmp = mkdtempSync(join(tmpdir(), 'substrate-admin-rotate-test-'));
    outPath = join(tmp, 'new.key');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('unknown kid → error', async () => {
    const exitCode = await main(
      ['rotate', 'ghostKid', '--out', outPath],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).not.toBe(0);
    expect(err.join('')).toMatch(/no Key with kid/);
    expect(existsSync(outPath)).toBe(false);
  });

  it('revoked kid → error', async () => {
    await seedKey(dataset, {
      id: 'kidRev',
      name: 'rev',
      namespaces: '*',
      capabilities: 'admin',
      revokedAt: new Date('2026-04-01T00:00:00.000Z')
    });
    const exitCode = await main(
      ['rotate', 'kidRev', '--out', outPath],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).not.toBe(0);
    expect(err.join('')).toMatch(/cannot rotate revoked Key/);
    expect(existsSync(outPath)).toBe(false);
  });

  it('--out path already exists → error "already exists", no tx, no audit row', async () => {
    await seedKey(dataset, {
      id: 'kidLive',
      name: 'live',
      namespaces: '*',
      capabilities: 'admin'
    });
    writeFileSync(outPath, 'pre-existing', { mode: 0o600 });
    const exitCode = await main(
      ['rotate', 'kidLive', '--out', outPath],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).not.toBe(0);
    expect(err.join('')).toMatch(/already exists/);
    // No audit emit, no mutation.
    const audit = await dataset.read(AUDIT_EVENT_TYPE, {});
    expect(audit.rows).toHaveLength(0);
    const key = await dataset.read(KEY_TYPE, { id: 'kidLive' });
    expect(key.rows[0]?.revokedAt).toBeNull();
  });

  it('unwritable --out → error, old key still live, nothing committed', async () => {
    await seedKey(dataset, { id: 'kidLive', name: 'live', namespaces: '*', capabilities: 'admin' });
    // A regular file as the parent directory makes the key write fail.
    writeFileSync(join(tmp, 'not-a-dir'), '');
    const exitCode = await main(
      ['rotate', 'kidLive', '--out', join(tmp, 'not-a-dir', 'new.key')],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).not.toBe(0);
    expect(err.join('')).toMatch(/Nothing was changed/);
    const key = await dataset.read(KEY_TYPE, { id: 'kidLive' });
    expect(key.rows[0]?.revokedAt).toBeNull();
    expect((await dataset.read(AUDIT_EVENT_TYPE, {})).rows).toHaveLength(0);
  });

  it('happy path → new key inserted, old revoked, ONE key_rotated audit event, private key at --out (0600)', async () => {
    await seedKey(dataset, {
      id: 'kidOld',
      kid: 'old-principal@host',
      name: 'preserved-name',
      namespaces: 'ns-a,ns-b',
      capabilities: 'admin,read'
    });

    const exitCode = await main(
      ['rotate', 'old-principal@host', '--out', outPath],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).toBe(0);
    expect(err).toHaveLength(0);

    const stdout = out.join('');
    expect(stdout).toMatch(/substrate-admin rotate complete/);
    expect(stdout).toMatch(/old kid:\s+old-principal@host/);
    expect(stdout).toMatch(/new kid:\s+[A-Za-z0-9_-]+/);
    expect(stdout).toMatch(/fingerprint:\s+sha256:/);
    expect(stdout).toContain(outPath);
    expect(stdout).toMatch(/namespaces:\s+ns-a,ns-b/);
    expect(stdout).toMatch(/capabilities:\s+admin,read/);

    // Old row revoked.
    const oldKey = await dataset.read(KEY_TYPE, { id: 'kidOld' });
    expect(oldKey.rows[0]?.revokedAt).toBeInstanceOf(Date);

    // New row exists with preserved fields.
    const allKeys = await dataset.read(KEY_TYPE, {});
    const newRows = allKeys.rows.filter(
      (r) => r.id !== 'kidOld' && typeof r.id === 'string' && r.id.length > 0
    );
    expect(newRows).toHaveLength(1);
    const newRow = newRows[0];
    expect(newRow?.name).toBe('preserved-name');
    expect(newRow?.namespaces).toBe('ns-a,ns-b');
    expect(newRow?.capabilities).toBe('admin,read');
    expect(newRow?.algorithm).toBe('EdDSA');
    expect(newRow?.revokedAt).toBeNull();
    // Principal (kid) survives rotation — the new row's kid is the OLD row's kid.
    expect(newRow?.kid).toBe('old-principal@host');
    expect(newRow?.id).not.toBe('old-principal@host');

    // Exactly ONE audit event — NOT separate created+revoked emits.
    const audit = await dataset.read(AUDIT_EVENT_TYPE, {});
    expect(audit.rows).toHaveLength(1);
    const ev = audit.rows[0];
    expect(ev?.kind).toBe('key_rotated');
    expect(ev?.actorKid).toBe('substrate-admin-cli');
    expect(ev?.targetKid).toBe('old-principal@host');
    const details = ev?.details as Record<string, unknown>;
    expect(details.oldKid).toBe('old-principal@host');
    expect(details.newKid).toBe(newRow?.id);
    expect(details.name).toBe('preserved-name');

    // Private key file at --out with 0600.
    expect(existsSync(outPath)).toBe(true);
    const mode = statSync(outPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('substrate-admin bootstrap --encrypt (memory dataset)', () => {
  // `runBootstrap` calls the pg-specific path directly and ignores the memory
  // opener, so this pins arg parsing, env validation and the crypto shape of
  // the produced PEM; the pg-backed encrypted write is covered elsewhere.
  let tmp: string;
  let keyPath: string;
  let out: Array<string>;
  let err: Array<string>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'substrate-admin-bootstrap-encrypt-test-'));
    keyPath = join(tmp, 'admin.key');
    out = [];
    err = [];
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('--encrypt without SUBSTRATE_ADMIN_KEY_PASSPHRASE → exit 6, clear stderr', async () => {
    const env: AdminCliEnv = {
      SUBSTRATE_DATABASE_URL: 'postgres://unused',
      SUBSTRATE_ADMIN_KEY_PATH: keyPath
    };
    const exitCode = await main(
      ['bootstrap', '--encrypt'],
      env,
      (s) => out.push(s),
      (s) => err.push(s)
    );
    expect(exitCode).toBe(6);
    expect(err.join('')).toMatch(/--encrypt requires SUBSTRATE_ADMIN_KEY_PASSPHRASE/);
    expect(existsSync(keyPath)).toBe(false);
  });

  it('--encrypt with empty SUBSTRATE_ADMIN_KEY_PASSPHRASE → exit 6', async () => {
    const env: AdminCliEnv = {
      SUBSTRATE_DATABASE_URL: 'postgres://unused',
      SUBSTRATE_ADMIN_KEY_PATH: keyPath,
      SUBSTRATE_ADMIN_KEY_PASSPHRASE: ''
    };
    const exitCode = await main(
      ['bootstrap', '--encrypt'],
      env,
      (s) => out.push(s),
      (s) => err.push(s)
    );
    expect(exitCode).toBe(6);
    expect(err.join('')).toMatch(/--encrypt requires SUBSTRATE_ADMIN_KEY_PASSPHRASE/);
    expect(existsSync(keyPath)).toBe(false);
  });

  it('--unknown flag → exit 1, stderr mentions unknown flag', async () => {
    const env: AdminCliEnv = {
      SUBSTRATE_DATABASE_URL: 'postgres://unused',
      SUBSTRATE_ADMIN_KEY_PATH: keyPath
    };
    const exitCode = await main(
      ['bootstrap', '--unknown'],
      env,
      (s) => out.push(s),
      (s) => err.push(s)
    );
    expect(exitCode).toBe(1);
    expect(err.join('')).toMatch(/bootstrap: unknown flag --unknown/);
  });

  it('duplicate --encrypt → exit 1', async () => {
    const env: AdminCliEnv = {
      SUBSTRATE_DATABASE_URL: 'postgres://unused',
      SUBSTRATE_ADMIN_KEY_PATH: keyPath,
      SUBSTRATE_ADMIN_KEY_PASSPHRASE: 'hunter2'
    };
    const exitCode = await main(
      ['bootstrap', '--encrypt', '--encrypt'],
      env,
      (s) => out.push(s),
      (s) => err.push(s)
    );
    expect(exitCode).toBe(1);
    expect(err.join('')).toMatch(/--encrypt specified more than once/);
  });

  it('unexpected positional arg → exit 1', async () => {
    const env: AdminCliEnv = {
      SUBSTRATE_DATABASE_URL: 'postgres://unused',
      SUBSTRATE_ADMIN_KEY_PATH: keyPath
    };
    const exitCode = await main(
      ['bootstrap', 'extra'],
      env,
      (s) => out.push(s),
      (s) => err.push(s)
    );
    expect(exitCode).toBe(1);
    expect(err.join('')).toMatch(/unexpected positional arg/);
  });
});

describe('substrate-admin rotate --encrypt (memory dataset)', () => {
  let dataset: MemoryDataset;
  let opener: OpenDatasetFn;
  let out: Array<string>;
  let err: Array<string>;
  let tmp: string;
  let outPath: string;
  const passphrase = 'rotate-secret-2026';

  beforeEach(async () => {
    dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    opener = makeOpener(dataset);
    out = [];
    err = [];
    tmp = mkdtempSync(join(tmpdir(), 'substrate-admin-rotate-encrypt-test-'));
    outPath = join(tmp, 'new.key');
    await seedKey(dataset, {
      id: 'kidLive',
      name: 'live-name',
      namespaces: 'ns-a',
      capabilities: 'admin'
    });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('--encrypt + passphrase → new key at --out is PBES2-encrypted (requires passphrase to load)', async () => {
    const env: AdminCliEnv = {
      SUBSTRATE_DATABASE_URL: 'postgres://unused',
      SUBSTRATE_ADMIN_KEY_PASSPHRASE: passphrase
    };
    const exitCode = await main(
      ['rotate', 'kidLive', '--out', outPath, '--encrypt'],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).toBe(0);
    expect(err).toHaveLength(0);
    expect(existsSync(outPath)).toBe(true);

    const pem = readFileSync(outPath, 'utf8');
    // Loading the encrypted PEM WITHOUT the passphrase must throw — proof
    // that the file is encrypted (not a string-inspection fake).
    expect(() => createPrivateKey({ key: pem })).toThrow();
    // Loading WITH the passphrase must succeed.
    expect(() => createPrivateKey({ key: pem, passphrase })).not.toThrow();

    const mode = statSync(outPath).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(out.join('')).toMatch(/encrypted: aes-256-cbc\+pbes2/);
  });

  it('--encrypt without passphrase → exit 6, no dataset mutation, no file written', async () => {
    const env: AdminCliEnv = { SUBSTRATE_DATABASE_URL: 'postgres://unused' };
    const exitCode = await main(
      ['rotate', 'kidLive', '--out', outPath, '--encrypt'],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).toBe(6);
    expect(err.join('')).toMatch(/--encrypt requires SUBSTRATE_ADMIN_KEY_PASSPHRASE/);
    expect(existsSync(outPath)).toBe(false);
    // Old row is still live — we bailed before the tx.
    const { rows } = await dataset.read(KEY_TYPE, { id: 'kidLive' });
    expect(rows[0]?.revokedAt).toBeNull();
    // No audit emit either.
    const audit = await dataset.read(AUDIT_EVENT_TYPE, {});
    expect(audit.rows).toHaveLength(0);
  });

  it('flag order --encrypt before --out still works', async () => {
    const env: AdminCliEnv = {
      SUBSTRATE_DATABASE_URL: 'postgres://unused',
      SUBSTRATE_ADMIN_KEY_PASSPHRASE: passphrase
    };
    const exitCode = await main(
      ['rotate', 'kidLive', '--encrypt', '--out', outPath],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).toBe(0);
    const pem = readFileSync(outPath, 'utf8');
    expect(() => createPrivateKey({ key: pem, passphrase })).not.toThrow();
  });

  it('duplicate --encrypt → exit 1', async () => {
    const env: AdminCliEnv = {
      SUBSTRATE_DATABASE_URL: 'postgres://unused',
      SUBSTRATE_ADMIN_KEY_PASSPHRASE: passphrase
    };
    const exitCode = await main(
      ['rotate', 'kidLive', '--out', outPath, '--encrypt', '--encrypt'],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).toBe(1);
    expect(err.join('')).toMatch(/--encrypt specified more than once/);
    expect(existsSync(outPath)).toBe(false);
  });

  it('rotate without --encrypt → new key is cleartext PKCS#8 (createPrivateKey without passphrase succeeds)', async () => {
    const env: AdminCliEnv = { SUBSTRATE_DATABASE_URL: 'postgres://unused' };
    const exitCode = await main(
      ['rotate', 'kidLive', '--out', outPath],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).toBe(0);
    const pem = readFileSync(outPath, 'utf8');
    expect(() => createPrivateKey({ key: pem })).not.toThrow();
    expect(out.join('')).toMatch(/unencrypted/);
  });
});

describe('substrate-admin dispatch', () => {
  const env: AdminCliEnv = { SUBSTRATE_DATABASE_URL: 'postgres://unused' };
  let opener: OpenDatasetFn;

  beforeEach(() => {
    opener = makeOpener(new MemoryDataset({ namespace: SYSTEM_NAMESPACE }));
  });

  it('no args → USAGE to stderr, exit 1', async () => {
    const out: Array<string> = [];
    const err: Array<string> = [];
    const exitCode = await main(
      [],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).toBe(1);
    expect(err.join('')).toMatch(/Usage: substrate-admin/);
  });

  it('unknown-command → error "unknown command", exit 1', async () => {
    const out: Array<string> = [];
    const err: Array<string> = [];
    const exitCode = await main(
      ['frobulate'],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).toBe(1);
    expect(err.join('')).toMatch(/unknown command/i);
  });

  it('rotate without --out → exit 1, error mentions --out', async () => {
    const out: Array<string> = [];
    const err: Array<string> = [];
    const exitCode = await main(
      ['rotate', 'kidFoo'],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).toBe(1);
    expect(err.join('')).toMatch(/--out/);
  });
});

/**
 * Target selection for the credential WRITE path (`update`, `revoke`,
 * `register`).
 *
 * The interesting case is an ambient `SUBSTRATE_URL` alongside an explicit
 * `SUBSTRATE_DATABASE_URL`: the write must not silently go over HTTP to whatever
 * `SUBSTRATE_URL` names, where it would 401 or, worse, succeed against the wrong
 * store.
 */
describe('resolveAdminTarget', () => {
  it('--url wins and records that a flag chose it', () => {
    const t = resolveAdminTarget('https://a.example', {
      SUBSTRATE_DATABASE_URL: 'postgres://local'
    });
    expect(t).toEqual({ kind: 'route', baseUrl: 'https://a.example', source: 'flag' });
  });

  it('--direct (the empty string) selects postgres, even with SUBSTRATE_URL set', () => {
    const t = resolveAdminTarget('', { SUBSTRATE_URL: 'https://fleet.example' });
    expect(t).toEqual({ kind: 'direct', source: 'flag' });
  });

  it('nothing said + SUBSTRATE_URL alone → the route, recorded as coming from the environment', () => {
    const t = resolveAdminTarget(null, { SUBSTRATE_URL: 'https://fleet.example' });
    expect(t).toEqual({ kind: 'route', baseUrl: 'https://fleet.example', source: 'env' });
  });

  it('nothing said + SUBSTRATE_DATABASE_URL alone → postgres', () => {
    const t = resolveAdminTarget(null, { SUBSTRATE_DATABASE_URL: 'postgres://local' });
    expect(t).toEqual({ kind: 'direct', source: 'fallback' });
  });

  it('THE INCIDENT: nothing said + BOTH set → refuses, rather than silently picking one', () => {
    expect(() =>
      resolveAdminTarget(null, {
        SUBSTRATE_URL: 'https://fleet.example',
        SUBSTRATE_DATABASE_URL: 'postgres://local'
      })
    ).toThrow(AdminCliError);
  });

  it('the refusal names both targets and both escape hatches — it must be actionable from the message alone', () => {
    let message = '';
    try {
      resolveAdminTarget(null, {
        SUBSTRATE_URL: 'https://fleet.example',
        SUBSTRATE_DATABASE_URL: 'postgres://local'
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('SUBSTRATE_URL');
    expect(message).toContain('SUBSTRATE_DATABASE_URL');
    expect(message).toContain('--url');
    expect(message).toContain('--direct');
  });

  it('an explicit flag RESOLVES the ambiguity rather than tripping it — both set is fine once one is named', () => {
    const bothSet = {
      SUBSTRATE_URL: 'https://fleet.example',
      SUBSTRATE_DATABASE_URL: 'postgres://local'
    };
    expect(() => resolveAdminTarget('https://named.example', bothSet)).not.toThrow();
    expect(() => resolveAdminTarget('', bothSet)).not.toThrow();
  });

  it('neither set → postgres, so the no-config path is unchanged', () => {
    expect(resolveAdminTarget(null, {})).toEqual({ kind: 'direct', source: 'fallback' });
  });
});

describe('describeAdminTarget', () => {
  it('names the destination AND where the choice came from — provenance is the half that was missing', () => {
    expect(
      describeAdminTarget('update', {
        kind: 'route',
        baseUrl: 'https://fleet.example',
        source: 'env'
      })
    ).toBe('update: targeting https://fleet.example (from SUBSTRATE_URL)');
  });

  it('distinguishes a flag-chosen route from an ambient one', () => {
    expect(
      describeAdminTarget('revoke', {
        kind: 'route',
        baseUrl: 'https://a.example',
        source: 'flag'
      })
    ).toBe('revoke: targeting https://a.example (from --url)');
  });

  it('says plainly when it is going behind the server to postgres', () => {
    expect(describeAdminTarget('update', { kind: 'direct', source: 'flag' })).toBe(
      'update: targeting the postgres store DIRECTLY, bypassing the running server (from --direct)'
    );
  });
});

describe('substrate-admin announces its target before writing', () => {
  let opener: OpenDatasetFn;

  beforeEach(() => {
    opener = makeOpener(new MemoryDataset({ namespace: SYSTEM_NAMESPACE }));
  });

  it('update with BOTH env vars set → exits non-zero and writes nothing', async () => {
    const out: Array<string> = [];
    const err: Array<string> = [];
    const exitCode = await main(
      ['update', 'somekid', '--caps', 'read,admin', '--widen'],
      { SUBSTRATE_URL: 'https://fleet.example', SUBSTRATE_DATABASE_URL: 'postgres://local' },
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).not.toBe(0);
    expect(err.join('')).toContain('SUBSTRATE_URL');
    expect(out.join('')).toBe('');
  });

  it('update going to postgres announces that BEFORE it acts, on stderr', async () => {
    const out: Array<string> = [];
    const err: Array<string> = [];
    await main(
      ['update', 'nosuchkid', '--direct', '--name', 'x'],
      { SUBSTRATE_DATABASE_URL: 'postgres://local' },
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    // The command itself fails (no such kid) — the point is that the target
    // line was emitted regardless, which is what makes a misdirected write
    // self-diagnosing rather than a mystery 401.
    expect(err.join('')).toContain('targeting the postgres store DIRECTLY');
  });
});

describe('parseRegisterArgs', () => {
  it('WITHOUT --ns → throws; omission must never grant a namespace', () => {
    // Regression: omitting `--ns` must not default to the `*` wildcard.
    expect(() =>
      parseRegisterArgs(['register', 'svc-claude@host', '--pubkey', '/tmp/k.pub'])
    ).toThrow(/requires --ns/);
  });

  it("--ns '*' is still available — the value was never the problem, an unchosen value was", () => {
    const args = parseRegisterArgs([
      'register',
      'svc-claude@host',
      '--pubkey',
      '/tmp/k.pub',
      '--ns',
      '*'
    ]);
    expect(args.namespaces).toEqual(['*']);
  });

  it('an --ns that resolves to an empty list → throws rather than granting nothing', () => {
    expect(() =>
      parseRegisterArgs(['register', 'k@h', '--pubkey', '/tmp/k.pub', '--ns', ' , , '])
    ).toThrow(/empty namespace list/);
  });

  it('the OTHER defaults still apply — only --ns lost its default', () => {
    const args = parseRegisterArgs([
      'register',
      'svc-claude@host',
      '--pubkey',
      '/tmp/k.pub',
      '--ns',
      'cortext'
    ]);
    expect(args.kid).toBe('svc-claude@host');
    expect(args.pubkeyPath).toBe('/tmp/k.pub');
    expect(args.name).toBe('svc-claude@host'); // defaults to kid
    expect(args.capabilities).toEqual(['read', 'mutate']); // bounded default, kept
    expect(args.allowAdmin).toBe(false);
  });

  // Both verbs validate by calling `parseGrantEntries`, so "what the CLI
  // accepts" and "what the server can read back" are one answer.
  describe('grant-entry validation is the parser, on both verbs', () => {
    const malformed = [':admin', 'cortext:', 'cortext:read,:'];

    for (const bad of malformed) {
      it(`register refuses --ns '${bad}'`, () => {
        expect(() =>
          parseRegisterArgs(['register', 'k@h', '--pubkey', '/tmp/k.pub', '--ns', bad])
        ).toThrow(/invalid grant entry/);
      });

      it(`update refuses --ns '${bad}'`, () => {
        expect(() => parseUpdateArgs(['update', 'k@h', '--ns', bad])).toThrow(
          /invalid grant entry/
        );
      });
    }

    it('both still accept well-formed per-namespace syntax', () => {
      const reg = parseRegisterArgs([
        'register',
        'k@h',
        '--pubkey',
        '/tmp/k.pub',
        '--ns',
        'plane:read,cortext:read+mutate'
      ]);
      expect(reg.namespaces).toEqual(['plane:read', 'cortext:read+mutate']);
      expect(parseUpdateArgs(['update', 'k@h', '--ns', 'plane:read']).namespaces).toEqual([
        'plane:read'
      ]);
    });
  });

  it('all flags override defaults', () => {
    const args = parseRegisterArgs([
      'register',
      'k@h',
      '--pubkey',
      '/tmp/k.pub',
      '--name',
      'My Key',
      '--ns',
      'claude,architecture',
      '--caps',
      'read'
    ]);
    expect(args.name).toBe('My Key');
    expect(args.namespaces).toEqual(['claude', 'architecture']);
    expect(args.capabilities).toEqual(['read']);
  });

  it('missing kid → throws', () => {
    expect(() => parseRegisterArgs(['register', '--pubkey', '/tmp/k.pub'])).toThrow(/kid/);
  });

  it('missing --pubkey → throws', () => {
    expect(() => parseRegisterArgs(['register', 'k@h', '--ns', 'cortext'])).toThrow(/--pubkey/);
  });

  it('unknown flag → throws', () => {
    expect(() =>
      parseRegisterArgs(['register', 'k@h', '--pubkey', '/tmp/k.pub', '--bogus'])
    ).toThrow(/unknown flag/);
  });

  it('duplicate --pubkey → throws', () => {
    expect(() =>
      parseRegisterArgs(['register', 'k@h', '--pubkey', '/a.pub', '--pubkey', '/b.pub'])
    ).toThrow(/specified more than once/);
  });

  it('duplicate --allow-admin → throws', () => {
    expect(() =>
      parseRegisterArgs(['register', 'k@h', '--pubkey', '/a.pub', '--allow-admin', '--allow-admin'])
    ).toThrow(/specified more than once/);
  });
});

describe('readEd25519PublicKey', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrate-reg-pub-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('valid ed25519 spki PEM → returns the PEM string', () => {
    const { publicKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { format: 'pem', type: 'spki' },
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' }
    });
    const p = join(dir, 'k.pub');
    writeFileSync(p, publicKey.toString());
    const pem = readEd25519PublicKey(p);
    expect(pem).toBe(publicKey.toString());
  });

  it('non-ed25519 key (RSA) → throws', () => {
    const { publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { format: 'pem', type: 'spki' },
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' }
    });
    const p = join(dir, 'rsa.pub');
    writeFileSync(p, publicKey.toString());
    expect(() => readEd25519PublicKey(p)).toThrow(/ed25519/i);
  });

  it('missing file → throws', () => {
    expect(() => readEd25519PublicKey(join(dir, 'nope.pub'))).toThrow(/cannot read/);
  });

  it('garbage content → throws', () => {
    const p = join(dir, 'junk.pub');
    writeFileSync(p, 'not a pem');
    expect(() => readEd25519PublicKey(p)).toThrow();
  });

  it('private-key PEM (ed25519) → throws (not a public key)', () => {
    const { privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { format: 'pem', type: 'spki' },
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' }
    });
    const p = join(dir, 'priv.key');
    writeFileSync(p, privateKey.toString());
    expect(() => readEd25519PublicKey(p)).toThrow(/not a public-key PEM/);
  });
});

describe('substrate-admin register', () => {
  let dataset: MemoryDataset;
  let opener: OpenDatasetFn;
  let out: Array<string>;
  let err: Array<string>;
  let dir: string;
  let pubPath: string;
  const env: AdminCliEnv = { SUBSTRATE_DATABASE_URL: 'postgres://unused' };

  beforeEach(() => {
    dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    opener = makeOpener(dataset);
    out = [];
    err = [];
    dir = mkdtempSync(join(tmpdir(), 'substrate-reg-'));
    const { publicKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { format: 'pem', type: 'spki' },
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' }
    });
    pubPath = join(dir, 'svc.pub');
    writeFileSync(pubPath, publicKey.toString());
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('happy path → row inserted with UUID id + kid field, ONE key_registered audit, returns 0', async () => {
    const exitCode = await main(
      ['register', 'svc-claude@host', '--pubkey', pubPath, '--ns', 'cortext'],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).toBe(0);
    expectOnlyTargetBanner(err, 'register');
    expect(out.join('')).toMatch(/substrate-admin register complete/);

    const { rows } = await dataset.read(KEY_TYPE, {
      where: { kid: { eq: 'svc-claude@host' } }
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.kid).toBe('svc-claude@host');
    expect(row?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(row?.id).not.toBe('svc-claude@host');
    expect(row?.name).toBe('svc-claude@host');
    // `--ns` is required, so this asserts the explicit value reaches the row.
    expect(row?.namespaces).toBe('cortext');
    expect(row?.capabilities).toBe('read,mutate');
    expect(row?.revokedAt).toBeNull();
    const audit = await dataset.read(AUDIT_EVENT_TYPE, {});
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.targetKid).toBe('svc-claude@host');
  });

  it('custom flags → row reflects --name/--ns/--caps', async () => {
    const exitCode = await main(
      [
        'register',
        'k@h',
        '--pubkey',
        pubPath,
        '--name',
        'My Key',
        '--ns',
        'claude',
        '--caps',
        'read'
      ],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).toBe(0);
    const { rows } = await dataset.read(KEY_TYPE, { where: { kid: { eq: 'k@h' } } });
    expect(rows[0]?.name).toBe('My Key');
    expect(rows[0]?.namespaces).toBe('claude');
    expect(rows[0]?.capabilities).toBe('read');
  });

  it('duplicate LIVE kid → refuse, no second write', async () => {
    await seedKey(dataset, {
      id: '00000000-0000-4000-8000-0000000000d0',
      kid: 'dup@h',
      name: 'existing',
      namespaces: '*',
      capabilities: 'read'
    });
    const exitCode = await main(
      ['register', 'dup@h', '--pubkey', pubPath, '--ns', 'cortext'],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).not.toBe(0);
    expect(err.join('')).toMatch(/already registered/);
    const audit = await dataset.read(AUDIT_EVENT_TYPE, {});
    expect(audit.rows).toHaveLength(0);
  });

  it('re-register over a REVOKED kid → allowed, row live again, same id preserved', async () => {
    await seedKey(dataset, {
      id: '00000000-0000-4000-8000-0000000000e1',
      kid: 'rev@h',
      name: 'old',
      namespaces: '*',
      capabilities: 'read',
      revokedAt: new Date('2026-05-01T00:00:00.000Z')
    });
    const exitCode = await main(
      ['register', 'rev@h', '--pubkey', pubPath, '--name', 'fresh', '--ns', 'cortext'],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).toBe(0);
    const { rows } = await dataset.read(KEY_TYPE, { where: { kid: { eq: 'rev@h' } } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).toBeNull();
    expect(rows[0]?.name).toBe('fresh');
    expect(rows[0]?.id).toBe('00000000-0000-4000-8000-0000000000e1');
    expect(out.join('')).toMatch(/re-registered over a previously-revoked/);
  });

  it('admin in --caps without --allow-admin → refuse', async () => {
    const exitCode = await main(
      ['register', 'a@h', '--pubkey', pubPath, '--caps', 'read,admin', '--ns', 'cortext'],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).not.toBe(0);
    expect(err.join('')).toMatch(/--allow-admin/);
  });

  it('admin in --caps WITH --allow-admin → allowed', async () => {
    const exitCode = await main(
      [
        'register',
        'a@h',
        '--pubkey',
        pubPath,
        '--caps',
        'read,admin',
        '--allow-admin',
        '--ns',
        'cortext'
      ],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).toBe(0);
    const { rows } = await dataset.read(KEY_TYPE, { where: { kid: { eq: 'a@h' } } });
    expect(rows[0]?.capabilities).toBe('read,admin');
  });

  it('malformed --pubkey → refuse before any write', async () => {
    const bad = join(dir, 'bad.pub');
    writeFileSync(bad, 'not a key');
    const exitCode = await main(
      ['register', 'b@h', '--pubkey', bad],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).not.toBe(0);
    const { rows } = await dataset.read(KEY_TYPE, {});
    expect(rows).toHaveLength(0);
  });

  it('missing --pubkey via dispatch → exit 1, no write', async () => {
    const exitCode = await main(
      ['register', 'np@h'],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).toBe(1);
    expect(err.join('')).toMatch(/--pubkey/);
    const { rows } = await dataset.read(KEY_TYPE, {});
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// revoke/rotate/list resolve by kid FIELD, not row id
// ---------------------------------------------------------------------------

describe('substrate-admin revoke by human kid (UUID id ≠ kid field)', () => {
  let dataset: MemoryDataset;
  let opener: OpenDatasetFn;
  let out: Array<string>;
  let err: Array<string>;
  const env: AdminCliEnv = { SUBSTRATE_DATABASE_URL: 'postgres://unused' };

  beforeEach(() => {
    dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    opener = makeOpener(dataset);
    out = [];
    err = [];
  });

  it('revoke <human-kid> → resolves by kid field, exits 0, row has revokedAt set', async () => {
    // Two admins so the lockout guard doesn't fire.
    await seedKey(dataset, {
      id: '00000000-0000-4000-8000-000000000aa1',
      kid: 'admin-a@host',
      name: 'admin-a',
      namespaces: '*',
      capabilities: 'admin'
    });
    await seedKey(dataset, {
      id: '00000000-0000-4000-8000-000000000bb2',
      kid: 'svc@host',
      name: 'svc',
      namespaces: 'claude',
      capabilities: 'read'
    });

    const exitCode = await main(
      ['revoke', 'svc@host'],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).toBe(0);
    expectOnlyTargetBanner(err, 'revoke');
    expect(out.join('')).toMatch(/Key svc@host revoked at /);

    // Read by kid field (not by row id) to confirm the right row was revoked.
    const { rows } = await dataset.read(KEY_TYPE, {
      where: { kid: { eq: 'svc@host' } }
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).toBeInstanceOf(Date);
  });
});

describe('substrate-admin rotate by human kid (UUID id ≠ kid field)', () => {
  let dataset: MemoryDataset;
  let opener: OpenDatasetFn;
  let out: Array<string>;
  let err: Array<string>;
  let tmp: string;
  let outPath: string;
  const env: AdminCliEnv = { SUBSTRATE_DATABASE_URL: 'postgres://unused' };

  beforeEach(() => {
    dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    opener = makeOpener(dataset);
    out = [];
    err = [];
    tmp = mkdtempSync(join(tmpdir(), 'substrate-admin-rotate-kid-test-'));
    outPath = join(tmp, 'new.key');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('rotate <human-kid> → resolves by kid field, new row has same kid + fresh UUID id, old row revoked', async () => {
    await seedKey(dataset, {
      id: '00000000-0000-4000-8000-000000000cc3',
      kid: 'rot@host',
      name: 'rotatable',
      namespaces: 'claude',
      capabilities: 'admin'
    });

    const exitCode = await main(
      ['rotate', 'rot@host', '--out', outPath],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).toBe(0);
    expect(err).toHaveLength(0);

    // Old row (looked up by its UUID id) is revoked.
    const oldRead = await dataset.read(KEY_TYPE, {
      id: '00000000-0000-4000-8000-000000000cc3'
    });
    expect(oldRead.rows[0]?.revokedAt).toBeInstanceOf(Date);

    // New row: kid = 'rot@host', fresh UUID id.
    const allKeys = await dataset.read(KEY_TYPE, {});
    const newRows = allKeys.rows.filter((r) => r.id !== '00000000-0000-4000-8000-000000000cc3');
    expect(newRows).toHaveLength(1);
    const newRow = newRows[0];
    expect(newRow?.kid).toBe('rot@host');
    expect(newRow?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(newRow?.id).not.toBe('00000000-0000-4000-8000-000000000cc3');
    expect(newRow?.revokedAt).toBeNull();
  });
});

describe('substrate-admin list shows kid field not row id', () => {
  let dataset: MemoryDataset;
  let opener: OpenDatasetFn;
  let out: Array<string>;
  let err: Array<string>;
  const env: AdminCliEnv = { SUBSTRATE_DATABASE_URL: 'postgres://unused' };

  beforeEach(() => {
    dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    opener = makeOpener(dataset);
    out = [];
    err = [];
  });

  it('list → stdout contains kid field (shown@host), not the UUID row id', async () => {
    await seedKey(dataset, {
      id: '00000000-0000-4000-8000-000000000dd4',
      kid: 'shown@host',
      name: 'shown',
      namespaces: '*',
      capabilities: 'admin'
    });

    const exitCode = await main(
      ['list'],
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );
    expect(exitCode).toBe(0);
    const stdout = out.join('');
    expect(stdout).toContain('shown@host');
    expect(stdout).not.toContain('00000000-0000-4000-8000-000000000dd4');
  });
});

describe('substrate-admin update', () => {
  let dataset: MemoryDataset;
  let opener: OpenDatasetFn;
  let out: Array<string>;
  let err: Array<string>;
  const env: AdminCliEnv = { SUBSTRATE_DATABASE_URL: 'postgres://unused' };

  beforeEach(() => {
    dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    opener = makeOpener(dataset);
    out = [];
    err = [];
  });

  const run = async (argv: Array<string>): Promise<number> =>
    main(
      argv,
      env,
      (s) => out.push(s),
      (s) => err.push(s),
      opener
    );

  const auditRows = async (): Promise<Array<Record<string, unknown>>> => {
    const read = await dataset.read(AUDIT_EVENT_TYPE, {});
    return read.rows as Array<Record<string, unknown>>;
  };

  it('NARROWING (* -> cortext,recall) needs no --widen', async () => {
    await seedKey(dataset, {
      id: 'agent',
      name: 'agent',
      namespaces: '*',
      capabilities: 'read,mutate'
    });
    const exitCode = await run(['update', 'agent', '--ns', 'cortext,recall']);
    expect(exitCode).toBe(0);
    expectOnlyTargetBanner(err, 'update');

    const row = (await dataset.read(KEY_TYPE, { id: 'agent' })).rows[0];
    expect(row?.namespaces).toBe('cortext,recall');
    expect(row?.capabilities).toBe('read,mutate');
    // The diff is on the resolved GRANT, not the raw columns, so it shows
    // which capabilities ride along to each namespace.
    expect(out.join('')).toMatch(/grant {2}before:\s+\*:read\+mutate/);
    expect(out.join('')).toMatch(/after:\s+cortext:read\+mutate/);
    expect(out.join('')).toMatch(/recall:read\+mutate/);
  });

  it('WIDENING (cortext -> cortext,recall) is refused without --widen, exit 5, nothing written', async () => {
    await seedKey(dataset, {
      id: 'agent',
      name: 'agent',
      namespaces: 'cortext',
      capabilities: 'read,mutate'
    });
    const exitCode = await run(['update', 'agent', '--ns', 'cortext,recall']);
    expect(exitCode).toBe(5);
    expect(err.join('')).toMatch(/would GRANT authority/);
    // The refusal names namespace:capability pairs in the syntax the operator
    // would type, so it says exactly where the new authority lands.
    expect(err.join('')).toMatch(/grants \+recall:/);

    const row = (await dataset.read(KEY_TYPE, { id: 'agent' })).rows[0];
    expect(row?.namespaces).toBe('cortext');
    expect(await auditRows()).toHaveLength(0);
  });

  it('a LATERAL change (cortext -> recall) is widening too — a strict-superset test would miss it', async () => {
    await seedKey(dataset, {
      id: 'agent',
      name: 'agent',
      namespaces: 'cortext',
      capabilities: 'read,mutate'
    });
    const exitCode = await run(['update', 'agent', '--ns', 'recall']);
    expect(exitCode).toBe(5);
    // The refusal names namespace:capability pairs in the syntax the operator
    // would type, so it says exactly where the new authority lands.
    expect(err.join('')).toMatch(/grants \+recall:/);
  });

  it('--widen permits the grant and the audit row records WHAT was granted', async () => {
    await seedKey(dataset, {
      id: 'agent',
      name: 'agent',
      namespaces: 'cortext',
      capabilities: 'read,mutate'
    });
    const exitCode = await run(['update', 'agent', '--ns', 'cortext,recall', '--widen']);
    expect(exitCode).toBe(0);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    const ev = rows[0];
    expect(ev?.kind).toBe('key_authority_updated');
    expect(ev?.actorKid).toBe('substrate-admin-cli');
    expect(ev?.targetKid).toBe('agent');
    const details = ev?.details as Record<string, unknown>;
    expect(details.widened).toBe(true);
    expect(details.namespacesGranted).toEqual(['recall']);
    expect((details.before as Record<string, unknown>).namespaces).toBe('cortext');
    expect((details.after as Record<string, unknown>).namespaces).toBe('cortext,recall');
  });

  it("an omitted flag leaves that field ALONE — it must not fall back to register's defaults", async () => {
    await seedKey(dataset, {
      id: 'agent',
      name: 'labs-claude (dev agent)',
      namespaces: 'cortext',
      capabilities: 'read'
    });
    // Renaming must not widen namespaces to '*' nor reset caps to read,mutate.
    const exitCode = await run(['update', 'agent', '--name', 'renamed']);
    expect(exitCode).toBe(0);

    const row = (await dataset.read(KEY_TYPE, { id: 'agent' })).rows[0];
    expect(row?.name).toBe('renamed');
    expect(row?.namespaces).toBe('cortext');
    expect(row?.capabilities).toBe('read');
  });

  it('a no-op writes nothing and emits NO audit row', async () => {
    await seedKey(dataset, {
      id: 'agent',
      name: 'agent',
      namespaces: 'cortext,recall',
      capabilities: 'read,mutate'
    });
    const exitCode = await run([
      'update',
      'agent',
      '--ns',
      'cortext,recall',
      '--caps',
      'read,mutate'
    ]);
    expect(exitCode).toBe(0);
    expect(out.join('')).toMatch(/no change/);
    expect(out.join('')).toMatch(/no audit row was emitted/);
    expect(await auditRows()).toHaveLength(0);
  });

  it('leaves the keypair untouched', async () => {
    await seedKey(dataset, {
      id: 'agent',
      name: 'agent',
      namespaces: '*',
      capabilities: 'read,mutate',
      publicKey: 'PEM-DO-NOT-TOUCH'
    });
    expect(await run(['update', 'agent', '--ns', 'cortext'])).toBe(0);
    const row = (await dataset.read(KEY_TYPE, { id: 'agent' })).rows[0];
    expect(row?.publicKey).toBe('PEM-DO-NOT-TOUCH');
    expect(row?.algorithm).toBe('EdDSA');
  });

  it('unknown kid → exit 2', async () => {
    expect(await run(['update', 'ghost', '--ns', 'cortext'])).toBe(2);
    expect(err.join('')).toMatch(/no Key with kid/);
  });

  it('revoked kid → exit 3 (update must not quietly resurrect a retired identity)', async () => {
    await seedKey(dataset, {
      id: 'agent',
      name: 'agent',
      namespaces: 'cortext',
      capabilities: 'read',
      revokedAt: new Date('2026-05-01T00:00:00.000Z')
    });
    expect(await run(['update', 'agent', '--ns', 'cortext'])).toBe(3);
    expect(err.join('')).toMatch(/was revoked at/);
    expect(await auditRows()).toHaveLength(0);
  });

  it('dropping admin from the LAST active admin → exit 4 lockout guard', async () => {
    await seedKey(dataset, {
      id: 'onlyAdmin',
      name: 'onlyAdmin',
      namespaces: '*',
      capabilities: 'admin'
    });
    expect(await run(['update', 'onlyAdmin', '--caps', 'read'])).toBe(4);
    expect(err.join('')).toMatch(/last active admin/);
    const row = (await dataset.read(KEY_TYPE, { id: 'onlyAdmin' })).rows[0];
    expect(row?.capabilities).toBe('admin');
  });

  it('lockout fires even on a PURE narrowing, with no widening to mask it', async () => {
    await seedKey(dataset, {
      id: 'onlyAdmin',
      name: 'onlyAdmin',
      namespaces: '*',
      capabilities: 'admin,read'
    });
    // 'read' is already held, so this drops admin and grants nothing — the
    // widen gate cannot fire and only the lockout can refuse it.
    expect(await run(['update', 'onlyAdmin', '--caps', 'read'])).toBe(4);
    expect(err.join('')).toMatch(/last active admin/);
  });

  it('granting admin requires --allow-admin even with --widen', async () => {
    await seedKey(dataset, {
      id: 'agent',
      name: 'agent',
      namespaces: '*',
      capabilities: 'read,mutate'
    });
    expect(await run(['update', 'agent', '--caps', 'read,mutate,admin', '--widen'])).toBe(1);
    expect(err.join('')).toMatch(/requires --allow-admin/);

    expect(
      await run(['update', 'agent', '--caps', 'read,mutate,admin', '--widen', '--allow-admin'])
    ).toBe(0);
    const row = (await dataset.read(KEY_TYPE, { id: 'agent' })).rows[0];
    expect(row?.capabilities).toBe('read,mutate,admin');
  });

  it('no mutating flag at all → exit 1', async () => {
    await seedKey(dataset, {
      id: 'agent',
      name: 'agent',
      namespaces: 'cortext',
      capabilities: 'read'
    });
    expect(await run(['update', 'agent'])).toBe(1);
    expect(err.join('')).toMatch(/at least one of --ns, --caps or --name/);
  });
});

describe('parseUpdateArgs', () => {
  it('omitted flags stay undefined — the deliberate divergence from parseRegisterArgs', () => {
    const parsed = parseUpdateArgs(['update', 'someKid']);
    expect(parsed.kid).toBe('someKid');
    expect(parsed.namespaces).toBeUndefined();
    expect(parsed.capabilities).toBeUndefined();
    expect(parsed.name).toBeUndefined();
    expect(parsed.widen).toBe(false);
    expect(parsed.allowAdmin).toBe(false);
  });

  it('parses every flag', () => {
    const parsed = parseUpdateArgs([
      'update',
      'k',
      '--ns',
      'a, b',
      '--caps',
      'read,mutate',
      '--name',
      'Display Name',
      '--widen',
      '--allow-admin'
    ]);
    expect(parsed.namespaces).toEqual(['a', 'b']);
    expect(parsed.capabilities).toEqual(['read', 'mutate']);
    expect(parsed.name).toBe('Display Name');
    expect(parsed.widen).toBe(true);
    expect(parsed.allowAdmin).toBe(true);
  });

  it('missing kid → throws', () => {
    expect(() => parseUpdateArgs(['update'])).toThrow(/requires a <kid>/);
  });

  it('unknown flag → throws', () => {
    expect(() => parseUpdateArgs(['update', 'k', '--nope'])).toThrow(/unknown flag/);
  });

  it('duplicate --ns → throws', () => {
    expect(() => parseUpdateArgs(['update', 'k', '--ns', 'a', '--ns', 'b'])).toThrow(
      /--ns specified more than once/
    );
  });

  it('flag without a value → throws', () => {
    expect(() => parseUpdateArgs(['update', 'k', '--ns', '--widen'])).toThrow(
      /--ns requires a value/
    );
  });

  it('unexpected second positional → throws', () => {
    expect(() => parseUpdateArgs(['update', 'k', 'extra'])).toThrow(/unexpected positional/);
  });
});

describe('isEntrypointPath', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'substrate-admin-entry-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('SYMLINKED argv[1] still resolves as the entrypoint', () => {
    // pnpm links packages through `.pnpm/`, so every real invocation reaches
    // the file through a symlink. Comparing raw argv[1] with the resolved
    // `import.meta.url` would skip `main` and exit 0 having done nothing.
    const real = join(dir, 'real.js');
    const link = join(dir, 'link.js');
    writeFileSync(real, '// module body\n');
    symlinkSync(real, link);

    const moduleUrl = pathToFileURL(real).href;
    expect(isEntrypointPath(moduleUrl, link)).toBe(true);
    expect(isEntrypointPath(moduleUrl, real)).toBe(true);
  });

  it('a DIFFERENT file is not the entrypoint', () => {
    const a = join(dir, 'a.js');
    const b = join(dir, 'b.js');
    writeFileSync(a, '// a\n');
    writeFileSync(b, '// b\n');
    expect(isEntrypointPath(pathToFileURL(a).href, b)).toBe(false);
  });

  it('undefined / empty / non-existent argv[1] → false, not a throw', () => {
    const a = join(dir, 'a.js');
    writeFileSync(a, '// a\n');
    const url = pathToFileURL(a).href;
    expect(isEntrypointPath(url, undefined)).toBe(false);
    expect(isEntrypointPath(url, '')).toBe(false);
    expect(isEntrypointPath(url, join(dir, 'does-not-exist.js'))).toBe(false);
  });
});

describe('bootstrap -> register round trip', () => {
  // Exercises both sides TOGETHER: the path `bootstrap` writes must be the
  // path `resolveAdminAuth` reads, or bootstrap-then-register cannot work on
  // a virgin deployment.
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'substrate-admin-roundtrip-'));
  });

  it('register looks for the key at the path bootstrap writes', () => {
    const env = { HOME: tmp } as unknown as AdminCliEnv;
    const written = resolveDefaultKeyPath(env);

    // Simulate what bootstrap leaves behind: key + kid, beside each other.
    mkdirSync(join(tmp, '.config', 'substrate'), { recursive: true });
    writeFileSync(written, 'not-a-real-key');
    writeFileSync(written.replace(/\.key$/, '.kid'), 'the-kid\n');

    // Assert the PATH it named, not merely that it failed: the key is junk, so
    // any resolver fails here, and only the path in `could not sign with
    // <path>` shows the right file was looked up.
    const auth = resolveAdminAuth(env, LOCAL);
    const detail = 'error' in auth ? auth.error : '';
    expect(detail).toContain(written);
  });

  it('reports no identity when bootstrap has NOT run — the discriminating case', () => {
    // Without this, the assertion above passes against a resolver that finds
    // nothing and errors for an unrelated reason.
    const auth = resolveAdminAuth({ HOME: tmp } as unknown as AdminCliEnv, LOCAL);
    expect('error' in auth && /no admin identity/.test(auth.error)).toBe(true);
  });
});

describe('store URL errors', () => {
  it('do not echo the password of a non-postgres SUBSTRATE_DATABASE_URL', async () => {
    const env = { SUBSTRATE_DATABASE_URL: 'mysql://ops:hunter2@db.internal/x' } as AdminCliEnv;
    const bootstrap = runBootstrap(env).catch((e: Error) => e.message);
    const opened = openPgDataset(env).catch((e: Error) => e.message);
    for (const message of await Promise.all([bootstrap, opened])) {
      expect(message).toContain('mysql://ops:***@db.internal/x');
      expect(message).not.toContain('hunter2');
    }
  });
});

describe('bootstrap file guards', () => {
  // `resolveAdminAuth` consults two files, and bootstrap must not disturb
  // either:
  //
  //   admin.key            written by bootstrap
  //   admin.kid            written by bootstrap
  //
  // The store-level guard (`firstAdminKey`) cannot help when bootstrap targets
  // a different store on a box that already has a working identity.
  let tmp: string;

  // Proves the refusal happens BEFORE pg is opened, which is why these tests
  // need no database.
  const openSqlMustNotRun = (): never => {
    throw new Error('openSql was called — the guard did not fire before pg');
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'substrate-bootstrap-guard-'));
    mkdirSync(join(tmp, '.config', 'substrate'), { recursive: true });
  });

  it('refuses when the kid file exists, even though the key file does not', async () => {
    const env = {
      HOME: tmp,
      SUBSTRATE_DATABASE_URL: 'postgres://unused/unused'
    } as unknown as AdminCliEnv;
    const kidPath = join(tmp, '.config', 'substrate', 'admin.kid');
    writeFileSync(kidPath, 'the-working-kid\n');

    await expect(
      runBootstrap(env, false, openSqlMustNotRun as unknown as (url: string) => never)
    ).rejects.toThrow(kidPath);

    // The file must still hold what it held: a guard that refuses AFTER the
    // write would pass an error-shape assertion and still destroy the identity.
    expect(readFileSync(kidPath, 'utf8')).toBe('the-working-kid\n');
  });

  it('does not consult the default location when SUBSTRATE_ADMIN_KEY_PATH names one', async () => {
    // An operator who names a path has chosen where this identity lives, so a
    // key already at the default location is none of this run's business.
    const elsewhere = join(tmp, 'deployment-b', 'admin.key');
    mkdirSync(join(tmp, 'deployment-b'), { recursive: true });
    writeFileSync(join(tmp, '.config', 'substrate', 'admin.key'), 'unrelated');

    const env = {
      HOME: tmp,
      SUBSTRATE_DATABASE_URL: 'postgres://unused/unused',
      SUBSTRATE_ADMIN_KEY_PATH: elsewhere
    } as unknown as AdminCliEnv;

    // Reaching openSql is the pass condition: it means every file guard
    // declined to fire and bootstrap proceeded to do real work.
    await expect(
      runBootstrap(env, false, openSqlMustNotRun as unknown as (url: string) => never)
    ).rejects.toThrow('openSql was called');
  });

  it('proceeds past the file guards on a genuinely virgin box', async () => {
    // The discriminating case. Without it, both assertions above pass against a
    // bootstrap that refuses unconditionally — which would be a worse bug than
    // the one being fixed, and one an error-shape assertion cannot see.
    const env = {
      HOME: tmp,
      SUBSTRATE_DATABASE_URL: 'postgres://unused/unused'
    } as unknown as AdminCliEnv;

    await expect(
      runBootstrap(env, false, openSqlMustNotRun as unknown as (url: string) => never)
    ).rejects.toThrow('openSql was called');
  });
});

describe('resolveAdminAuth', () => {
  it('a token in the environment wins — it consults no files at all', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'substrate-admin-token-'));
    const env = { HOME: tmp, SUBSTRATE_ADMIN_TOKEN: 'abc' } as unknown as AdminCliEnv;
    mkdirSync(join(tmp, '.config', 'substrate'), { recursive: true });
    writeFileSync(resolveDefaultKeyPath(env), 'k');
    const auth = resolveAdminAuth(env, LOCAL);
    expect('ok' in auth && auth.ok).toBe('Bearer abc');
  });
});

describe('substrate-admin --version', () => {
  it.each(['--version', '-v', 'version'])(
    '%s prints the package version to stdout and exits 0',
    async (flag) => {
      const out: Array<string> = [];
      const err: Array<string> = [];
      const code = await main(
        [flag],
        {},
        (s) => out.push(s),
        (s) => err.push(s)
      );
      expect(code).toBe(0);
      expect(out.join('')).toBe(`${pkg.version}\n`);
      expect(err).toEqual([]);
    }
  );
});

describe('the CLI answers a usage REQUEST, and refuses a mistyped destructive one', () => {
  it('`--help` prints usage to STDOUT and exits 0', async () => {
    const out: Array<string> = [];
    const err: Array<string> = [];
    const code = await main(
      ['doctor', '--help'],
      {},
      (s) => out.push(s),
      (s) => err.push(s)
    );

    // Usage is a request, not an error. `doctor` takes no required arguments,
    // so `--help` must not fall through to a live diagnostic.
    expect(code).toBe(0);
    expect(out.join('')).toContain('Usage: substrate-admin <subcommand>');
    expect(err.join('')).toBe('');
  });

  it('`revoke` refuses a mistyped flag rather than revoking its VALUE as a kid', async () => {
    const out: Array<string> = [];
    const err: Array<string> = [];
    // A positional scan that skips unknown flags would take 'https://typo' as
    // the kid. It is the destructive verb; it should not guess.
    const code = await main(
      ['revoke', '--urlx', 'https://typo'],
      {},
      (s) => out.push(s),
      (s) => err.push(s)
    );

    expect(code).toBe(1);
    expect(err.join('')).toContain('revoke: unknown flag --urlx');
    expect(err.join('')).not.toContain('revoked at');
  });

  it('`revoke` refuses a second positional rather than silently dropping it', async () => {
    const err: Array<string> = [];
    const code = await main(
      ['revoke', 'first@host', 'second@host'],
      {},
      () => {},
      (s) => err.push(s)
    );

    expect(code).toBe(1);
    expect(err.join('')).toMatch(/unexpected extra argument 'second@host'/);
  });
});

describe('`list` takes no arguments and says why --url is not one', () => {
  // `list` must inspect argv like every other subcommand rather than go
  // straight to opening the store.
  const run = async (argv: Array<string>) => {
    const err: Array<string> = [];
    const code = await main(
      argv,
      {},
      () => {},
      (s) => err.push(s)
    );
    return { code, err: err.join('') };
  };

  // `--url` reads the keys over `GET /substrate/v1/_system/keys`.
  it('--url is ACCEPTED now, and requires a value rather than eating the next flag', async () => {
    expect((await run(['list', '--url'])).err).toContain('--url requires a base URL');
    expect((await run(['list', '--url', '--nonsense'])).err).toContain('--url requires a base URL');
  });

  it('refuses an unknown flag and a stray positional', async () => {
    expect((await run(['list', '--nonsense'])).err).toContain('unknown flag --nonsense');
    expect((await run(['list', '--nonsense'])).err).toContain('--url <base>');
    expect((await run(['list', 'extra'])).err).toContain("unexpected argument 'extra'");
  });

  it('still runs with no arguments — the guard must not break the command', async () => {
    // A guard that narrows a command to uselessness passes every rejection test.
    // With no store configured this fails at the store, NOT at argv parsing.
    const { err } = await run(['list']);
    expect(err).toContain('SUBSTRATE_DATABASE_URL');
    expect(err).not.toContain('takes no arguments');
  });
});

describe('usage discoverability, missing-file preflight, restart prompt', () => {
  it('d1: a parse failure carries the command shape — dead end 1 was usage visible only by running it wrong', () => {
    // Every parse*Args wrapper appends its synopsis; run-phase errors stay
    // bare because they name the refusing layer, a different job.
    expect(() => parseRegisterArgs(['register'])).toThrow(
      /register requires a <kid> positional arg\nusage: substrate-admin register <kid> --pubkey <path> --ns <csv>/
    );
    expect(() => parseRegisterArgs(['register', 'k@h', '--bogus'])).toThrow(
      /unknown flag --bogus\nusage: substrate-admin register/
    );
    expect(() => parseUpdateArgs(['update'])).toThrow(
      /usage: substrate-admin update <kid> \[--name/
    );
    expect(() => parseRotateArgs(['rotate', 'k@h'])).toThrow(
      /usage: substrate-admin rotate <kid> --out <path>/
    );
    expect(() => parseBootstrapArgs(['bootstrap', '--bogus'])).toThrow(
      /usage: substrate-admin bootstrap \[--encrypt\]/
    );
    expect(() => parseListArgs(['list', 'extra'])).toThrow(
      /usage: substrate-admin list \[--url <base>\]/
    );
  });

  it('d1: exit codes survive the wrapper — a usage suffix is not a severity change', async () => {
    const err: Array<string> = [];
    const code = await main(
      ['revoke', '--urlx', 'https://typo'],
      {},
      () => {},
      (s) => err.push(s)
    );
    expect(code).toBe(1);
    expect(err.join('')).toContain('usage: substrate-admin revoke <kid>');
  });

  it('d2: a missing --pubkey fails BEFORE opening the dataset, naming the path', async () => {
    const opener = (() => {
      throw new Error('dataset must not open on a preflight failure');
    }) as unknown as OpenDatasetFn;
    const env: AdminCliEnv = { SUBSTRATE_DATABASE_URL: 'postgres://unused' };
    await expect(
      runRegister(
        parseRegisterArgs(['register', 'k@h', '--pubkey', '/no/such.pub', '--ns', 'cortext']),
        env,
        opener
      )
    ).rejects.toThrow(/cannot read --pubkey '\/no\/such\.pub'/);
  });

  it('d7: every direct credential write prompts the restart (revoke proved it missing)', () => {
    // revoke, bootstrap and rotate are direct-pg only, so the interceptor never
    // prompts for them. update/register-route print their own "the server saw
    // it" lines instead.
    for (const out of [
      formatRevokeOutput({ kid: 'k@h', revokedAt: '2026-09-11T00:00:00.000Z' }),
      formatRotateOutput({
        oldKid: 'a@h',
        newKid: 'b@h',
        fingerprint: 'x',
        privateKeyPath: '/tmp/b.key',
        name: 'b@h',
        namespaces: 'cortext',
        capabilities: 'read,mutate',
        encrypted: false
      }),
      formatBootstrapOutput({
        kid: 'gen@h',
        fingerprint: 'x',
        privateKeyPath: '/tmp/gen.key',
        namespaces: '*',
        capabilities: 'read,mutate,admin',
        encrypted: false
      })
    ]) {
      expect(out).toContain('registry re-primes');
      expect(out).toContain('systemctl restart substrate-binary');
    }
  });
});

describe('resolveAdminAuth claims a custom SUBSTRATE_ADMIN_CAPABILITY', () => {
  // The server intersects the claim against the key row, so a claim that omits
  // the deployment's admin capability intersects it away and the admin gate
  // answers no, however the row was seeded.
  function claimed(extra: Partial<AdminCliEnv>): unknown {
    const dir = mkdtempSync(join(tmpdir(), 'substrate-admin-cap-'));
    const key = join(dir, 'ops.key');
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(key, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    const auth = resolveAdminAuth(
      {
        HOME: dir,
        SUBSTRATE_ADMIN_KEY_PATH: key,
        SUBSTRATE_ADMIN_KEY_ID: 'ops@Box',
        ...extra
      } as unknown as AdminCliEnv,
      LOCAL
    );
    if (!('ok' in auth)) throw new Error(auth.error);
    const payload = auth.ok.replace(/^Bearer /, '').split('.')[1]!;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).capabilities;
  }

  it('claims the configured capability alongside read and mutate', () => {
    expect(claimed({ SUBSTRATE_ADMIN_CAPABILITY: 'superuser' })).toEqual([
      'read',
      'mutate',
      'admin',
      'superuser'
    ]);
  });

  it('claims the default set when it is unset', () => {
    expect(claimed({})).toEqual(['read', 'mutate', 'admin']);
  });
});

describe('substrate-admin signs with an ENCRYPTED admin key end to end', () => {
  // `list --url` through a real HTTP round trip: the key is read with
  // SUBSTRATE_ADMIN_KEY_PASSPHRASE, the token is minted, sent, and its signature is
  // checked against the public half. Nothing between the env var and the wire
  // is stubbed.
  const KID = 'ops-admin@Box';
  const PASSPHRASE = 'correct horse battery staple';
  let dir: string;
  let keyPath: string;
  let publicPem: string;
  let server: Server;
  let baseUrl: string;
  let seen: Array<string>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrate-admin-encrypted-'));
    const pair = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem',
        cipher: 'aes-256-cbc',
        passphrase: PASSPHRASE
      }
    });
    keyPath = join(dir, 'admin.key');
    writeFileSync(keyPath, pair.privateKey);
    publicPem = pair.publicKey;
    seen = [];
    server = createServer((req, res) => {
      seen.push(req.headers.authorization ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          keys: [
            {
              id: '00000000-0000-4000-8000-000000000001',
              kid: KID,
              name: 'ops',
              algorithm: 'EdDSA',
              namespaces: '*',
              capabilities: 'read,mutate,admin',
              createdAt: '2026-10-14T00:00:00.000Z'
            }
          ]
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  async function list(passphrase?: string) {
    const out: Array<string> = [];
    const err: Array<string> = [];
    const code = await main(
      ['list', '--url', baseUrl],
      {
        HOME: dir,
        SUBSTRATE_ADMIN_KEY_PATH: keyPath,
        SUBSTRATE_ADMIN_KEY_ID: KID,
        ...(passphrase !== undefined ? { SUBSTRATE_ADMIN_KEY_PASSPHRASE: passphrase } : {})
      },
      (t) => out.push(t),
      (t) => err.push(t)
    );
    return { code, out: out.join(''), err: err.join('') };
  }

  it('with the right passphrase, sends a token the public key verifies', async () => {
    const r = await list(PASSPHRASE);
    expect(r.code).toBe(0);
    expect(r.out).toContain(KID);
    expect(seen).toHaveLength(1);
    const [header, payload, sig] = seen[0]!.replace(/^Bearer /, '').split('.');
    const valid = verify(
      null,
      Buffer.from(`${header}.${payload}`, 'utf8'),
      publicPem,
      Buffer.from(sig!, 'base64url')
    );
    expect(valid).toBe(true);
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString('utf8')).kid).toBe(KID);
    expect(claims.sub).toBe(KID);
    expect(claims.capabilities).toContain('admin');
  });

  it('with a wrong passphrase, fails naming the key and sends nothing', async () => {
    const r = await list('not the passphrase');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`could not sign with ${keyPath}`);
    expect(seen).toHaveLength(0);
  });

  it('with no passphrase, fails naming the key and sends nothing', async () => {
    const r = await list();
    expect(r.code).not.toBe(0);
    expect(r.err).toContain(`could not sign with ${keyPath}`);
    expect(seen).toHaveLength(0);
  });
});

describe('substrate-admin register over a rotated kid', () => {
  it('sees the live row and refuses, rather than rewriting the revoked one', async () => {
    const dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    // The revoked row comes first in the read, as it can on pg.
    await seedKey(dataset, {
      id: 'a-old-row',
      kid: 'svc@host',
      name: 'svc',
      namespaces: '*',
      capabilities: 'read',
      revokedAt: new Date('2026-04-02T00:00:00.000Z')
    });
    await seedKey(dataset, {
      id: 'b-live-row',
      kid: 'svc@host',
      name: 'svc',
      namespaces: '*',
      capabilities: 'read'
    });
    const tmp = mkdtempSync(join(tmpdir(), 'substrate-admin-register-test-'));
    try {
      const pubPath = join(tmp, 'k.pub');
      const { publicKey } = generateKeyPairSync('ed25519');
      writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
      const err: Array<string> = [];
      const exitCode = await main(
        ['register', 'svc@host', '--pubkey', pubPath, '--ns', 'app', '--caps', 'read'],
        { SUBSTRATE_DATABASE_URL: 'postgres://unused' },
        () => {},
        (s) => err.push(s),
        makeOpener(dataset)
      );
      expect(exitCode).not.toBe(0);
      expect(err.join('')).toMatch(/already registered and live/);
      const { rows } = await dataset.read(KEY_TYPE, { where: { kid: { eq: 'svc@host' } } });
      expect(rows.find((r) => r.id === 'a-old-row')?.revokedAt).not.toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
