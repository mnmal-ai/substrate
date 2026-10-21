/**
 * `substrate-admin bootstrap` integration. Spec §5.12.
 *
 * Pg-gated: skipped unless `POSTGRES_URL` is set. Calls `main` directly (not
 * via subprocess spawn) so the test stays sub-second, and scrubs the
 * `_system/Key` rows between cases so each assertion starts from a clean
 * slate. The private-key path is redirected to a per-test tmp dir to avoid
 * clobbering the developer's `~/.config/substrate/admin.key`.
 */

import { createPrivateKey } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEY_TYPE, SYSTEM_NAMESPACE } from '@mnmal-ai/substrate-compose';
import { PgDataset, runMigrations } from '@mnmal-ai/substrate-dataset-pg';
import { ADMIN_CAPABILITIES } from '@mnmal-ai/substrate-policy';
import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { main, runBootstrap } from '../src/bin/admin.js';

const POSTGRES_URL = process.env.POSTGRES_URL;

describe.skipIf(!POSTGRES_URL)('substrate-admin bootstrap', () => {
  let sql: Sql;
  let tmp: string;
  let keyPath: string;
  let out: Array<string>;
  let err: Array<string>;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'substrate-admin-test-'));
    keyPath = join(tmp, 'admin.key');
    out = [];
    err = [];
    // Purge Key rows left by other test files sharing this database or by
    // a prior crashed run. afterEach also purges, but only THIS test's writes.
    await sql`DELETE FROM rows WHERE namespace = ${SYSTEM_NAMESPACE} AND type = ${KEY_TYPE}`;
  });

  afterEach(async () => {
    rmSync(tmp, { recursive: true, force: true });
    // Purge only the _system/Key rows we just wrote. `TRUNCATE` is
    // tempting but would also wipe rows the other pg-integration tests seed.
    await sql`DELETE FROM rows WHERE namespace = ${SYSTEM_NAMESPACE} AND type = ${KEY_TYPE}`;
  });

  it('two concurrent bootstraps create exactly one genesis admin', async () => {
    // Every row INSERT is held back, so each run's admin check sees no admin
    // unless something serialises check and write.
    const slowWrites = (url: string): Sql =>
      new Proxy(postgres(url), {
        apply(target, self, args: unknown[]) {
          const text = Array.isArray(args[0]) ? (args[0] as string[]).join('') : '';
          if (!text.includes('INSERT INTO rows')) return Reflect.apply(target, self, args);
          return new Promise((resolve) => setTimeout(resolve, 300)).then(() =>
            Reflect.apply(target, self, args)
          );
        }
      });
    const run = (dir: string) =>
      runBootstrap(
        {
          SUBSTRATE_DATABASE_URL: POSTGRES_URL as string,
          SUBSTRATE_ADMIN_KEY_PATH: join(tmp, dir, 'admin.key')
        },
        false,
        slowWrites
      ).then(
        () => 'ok',
        (e: Error) => e.message
      );
    const results = await Promise.all([run('a'), run('b')]);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    const { rows } = await new PgDataset({ namespace: SYSTEM_NAMESPACE, sql }).read(KEY_TYPE, {});
    expect(rows).toHaveLength(1);
  });

  it('fresh pg schema → bootstrap succeeds with key file + Key row', async () => {
    const exitCode = await main(
      ['bootstrap'],
      {
        SUBSTRATE_DATABASE_URL: POSTGRES_URL as string,
        SUBSTRATE_ADMIN_KEY_PATH: keyPath
      },
      (s) => out.push(s),
      (s) => err.push(s)
    );
    expect(exitCode).toBe(0);
    expect(err).toHaveLength(0);

    // stdout captured the human-readable summary.
    const stdout = out.join('');
    expect(stdout).toMatch(/substrate-admin bootstrap complete/);
    expect(stdout).toMatch(/kid:\s+[A-Za-z0-9_-]+/);
    expect(stdout).toMatch(/fingerprint:\s+sha256:/);
    expect(stdout).toContain(keyPath);

    // Key file written with mode 0600.
    expect(existsSync(keyPath)).toBe(true);
    const mode = statSync(keyPath).mode & 0o777;
    expect(mode).toBe(0o600);

    // Default (no --encrypt): PEM is cleartext PKCS#8, loads without passphrase.
    const pem = readFileSync(keyPath, 'utf8');
    expect(() => createPrivateKey({ key: pem })).not.toThrow();
    expect(stdout).toMatch(/unencrypted/);

    // Key row present with expected fields.
    const dataset = new PgDataset({ namespace: SYSTEM_NAMESPACE, sql });
    const { rows } = await dataset.read(KEY_TYPE, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('bootstrap-admin');
    expect(rows[0]?.algorithm).toBe('EdDSA');
    expect(rows[0]?.namespaces).toBe('*');
    expect(rows[0]?.capabilities).toBe('read,mutate,admin');
    // Bootstrap's principal id IS its UUID — kid and id must be identical.
    expect(rows[0]?.kid).toBe(rows[0]?.id);
  });

  it('second bootstrap run → exits with "already bootstrapped" error', async () => {
    // First run should succeed.
    const first = await main(
      ['bootstrap'],
      {
        SUBSTRATE_DATABASE_URL: POSTGRES_URL as string,
        SUBSTRATE_ADMIN_KEY_PATH: keyPath
      },
      (s) => out.push(s),
      (s) => err.push(s)
    );
    expect(first).toBe(0);

    // Second run refuses — the key file already exists, so the pre-check
    // fires before we ever open pg. Use a separate path to exercise the
    // other refusal branch (existing admin row).
    const secondKeyPath = join(tmp, 'admin-2.key');
    const secondOut: Array<string> = [];
    const secondErr: Array<string> = [];
    const second = await main(
      ['bootstrap'],
      {
        SUBSTRATE_DATABASE_URL: POSTGRES_URL as string,
        SUBSTRATE_ADMIN_KEY_PATH: secondKeyPath
      },
      (s) => secondOut.push(s),
      (s) => secondErr.push(s)
    );
    expect(second).toBe(1);
    expect(secondErr.join('')).toMatch(/already bootstrapped/i);
    // First run's key file is untouched.
    expect(existsSync(keyPath)).toBe(true);
    // Second run didn't write its file either.
    expect(existsSync(secondKeyPath)).toBe(false);
  });

  it('existing private-key file → refuses, no Key row written', async () => {
    // Pre-seed the key file — the CLI must refuse rather than overwrite.
    writeFileSync(keyPath, 'pre-existing', { mode: 0o600 });

    const exitCode = await main(
      ['bootstrap'],
      {
        SUBSTRATE_DATABASE_URL: POSTGRES_URL as string,
        SUBSTRATE_ADMIN_KEY_PATH: keyPath
      },
      (s) => out.push(s),
      (s) => err.push(s)
    );
    expect(exitCode).toBe(1);
    expect(err.join('')).toMatch(/already exists/i);

    // No row landed.
    const dataset = new PgDataset({ namespace: SYSTEM_NAMESPACE, sql });
    const { rows } = await dataset.read(KEY_TYPE, {});
    expect(rows).toHaveLength(0);
  });

  it('rejects SUBSTRATE_DATABASE_URL=memory with a clear message', async () => {
    const exitCode = await main(
      ['bootstrap'],
      { SUBSTRATE_DATABASE_URL: 'memory', SUBSTRATE_ADMIN_KEY_PATH: keyPath },
      (s) => out.push(s),
      (s) => err.push(s)
    );
    expect(exitCode).toBe(1);
    expect(err.join('')).toMatch(/postgres:\/\//);
  });

  it('unknown subcommand prints usage and exits 1', async () => {
    const exitCode = await main(
      ['frobulate'],
      { SUBSTRATE_DATABASE_URL: POSTGRES_URL as string, SUBSTRATE_ADMIN_KEY_PATH: keyPath },
      (s) => out.push(s),
      (s) => err.push(s)
    );
    expect(exitCode).toBe(1);
    expect(err.join('')).toMatch(/unknown command/i);
  });

  it('bootstrap --encrypt with passphrase → key file is PBES2-encrypted', async () => {
    const passphrase = 'bootstrap-secret-2026';
    const exitCode = await main(
      ['bootstrap', '--encrypt'],
      {
        SUBSTRATE_DATABASE_URL: POSTGRES_URL as string,
        SUBSTRATE_ADMIN_KEY_PATH: keyPath,
        SUBSTRATE_ADMIN_KEY_PASSPHRASE: passphrase
      },
      (s) => out.push(s),
      (s) => err.push(s)
    );
    expect(exitCode).toBe(0);
    expect(err).toHaveLength(0);
    expect(out.join('')).toMatch(/encrypted: aes-256-cbc\+pbes2/);

    const pem = readFileSync(keyPath, 'utf8');
    // Loading the encrypted PEM without the passphrase MUST fail — proof
    // that the on-disk format is encrypted (not a string-inspection fake).
    expect(() => createPrivateKey({ key: pem })).toThrow();
    expect(() => createPrivateKey({ key: pem, passphrase })).not.toThrow();

    const mode = statSync(keyPath).mode & 0o777;
    expect(mode).toBe(0o600);

    // Public key on the Key row is untouched by the encryption switch —
    // encryption is a local-file concern only.
    const dataset = new PgDataset({ namespace: SYSTEM_NAMESPACE, sql });
    const { rows } = await dataset.read(KEY_TYPE, {});
    expect(rows).toHaveLength(1);
    const pubKey = typeof rows[0]?.publicKey === 'string' ? rows[0].publicKey : '';
    expect(pubKey.startsWith('-----BEGIN PUBLIC KEY-----')).toBe(true);
  });

  it('SUBSTRATE_ADMIN_CAPABILITY override is stamped into the row', async () => {
    const exitCode = await main(
      ['bootstrap'],
      {
        SUBSTRATE_DATABASE_URL: POSTGRES_URL as string,
        SUBSTRATE_ADMIN_KEY_PATH: keyPath,
        SUBSTRATE_ADMIN_CAPABILITY: 'role=admin'
      },
      (s) => out.push(s),
      (s) => err.push(s)
    );
    expect(exitCode).toBe(0);
    const dataset = new PgDataset({ namespace: SYSTEM_NAMESPACE, sql });
    const { rows } = await dataset.read(KEY_TYPE, {});
    expect(rows[0]?.capabilities).toBe('read,mutate,role=admin');
  });

  /**
   * The genesis row must grant what the genesis CLAIM claims.
   *
   * `resolveAdminAuth` mints substrate-admin's token with {@link ADMIN_CAPABILITIES}
   * and `auth.ts` intersects that claim against this row per namespace. The
   * per-frame gate asks for `read` and `mutate` by name, which `admin` does not
   * satisfy, so a row seeded with `admin` alone leaves a fresh bootstrap unable
   * to read or write anything.
   *
   * Asserted against the constant rather than a literal, so the two sides
   * cannot drift apart.
   */
  it('the bootstrapped row grants everything the admin token claims — claim ∩ row must not narrow', async () => {
    const exitCode = await main(
      ['bootstrap'],
      { SUBSTRATE_DATABASE_URL: POSTGRES_URL as string, SUBSTRATE_ADMIN_KEY_PATH: keyPath },
      (s) => out.push(s),
      (s) => err.push(s)
    );
    expect(exitCode).toBe(0);

    const dataset = new PgDataset({ namespace: SYSTEM_NAMESPACE, sql });
    const { rows } = await dataset.read(KEY_TYPE, {});
    const granted = String(rows[0]?.capabilities ?? '').split(',');

    expect([...granted].sort()).toEqual([...ADMIN_CAPABILITIES].sort());
  });

  it('reports the seeded capabilities to the operator, so a narrowed genesis grant is visible', async () => {
    const exitCode = await main(
      ['bootstrap'],
      { SUBSTRATE_DATABASE_URL: POSTGRES_URL as string, SUBSTRATE_ADMIN_KEY_PATH: keyPath },
      (s) => out.push(s),
      (s) => err.push(s)
    );
    expect(exitCode).toBe(0);
    expect(out.join('')).toMatch(/capabilities:\s+read,mutate,admin/);
  });
});

/**
 * Constrained-schema bootstrap. Migration 0002 enforces a UUID-format CHECK
 * constraint on `rows.id` when `SUBSTRATE_ENFORCE_UUID_CHECK=true` — the
 * production-recommended setting — so bootstrap's kid must be UUID-shaped.
 *
 * Isolation: the constraints + 0002's tracking row are dropped in afterAll so
 * other test files (which don't enable the gate) don't inherit constrained
 * schema state via the shared test database.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe.skipIf(!POSTGRES_URL)('substrate-admin bootstrap (SUBSTRATE_ENFORCE_UUID_CHECK)', () => {
  let sql: Sql;
  let tmp: string;
  let keyPath: string;
  let out: Array<string>;
  let err: Array<string>;

  beforeAll(async () => {
    sql = postgres(POSTGRES_URL as string);
    // 0002 applies the CHECK constraint as a full table scan (not NOT VALID),
    // so any pre-existing non-UUID id from other test files in the shared
    // test DB would block the ALTER TABLE. Targeted DELETE — NOT TRUNCATE — so
    // only rows that would violate the constraint are removed and rows other
    // test files seed stay intact. The regex matches the UUID format 0002
    // enforces (see packages/substrate-dataset-pg/src/migrations/0002_*).
    //
    // short_ids has ON DELETE CASCADE on (namespace, type, row_id) →
    // (namespace, type, id), so the sidecar follows automatically (see
    // migration 0010). edges has no FK back to rows (text
    // from_id / to_id columns), so we delete edges that point at any
    // non-UUID row id explicitly — same predicate, both endpoints.
    await sql`
      DELETE FROM edges
       WHERE from_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          OR to_id   !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    `;
    await sql`
      DELETE FROM rows
       WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    `;
    // Re-run migrations with the gate flipped on. `force: true` clears the
    // tracking table so 0002 actually applies on a DB that was already
    // migrated under the default (unconstrained) gate.
    await runMigrations(sql, { enforceUuidCheck: true, force: true });
  });

  afterAll(async () => {
    // Strip the constraints + 0002's tracking row so unrelated pg-gated tests
    // sharing this DB don't inherit constrained schema between runs.
    await sql`ALTER TABLE rows DROP CONSTRAINT IF EXISTS rows_id_uuid_format`;
    await sql`ALTER TABLE short_ids DROP CONSTRAINT IF EXISTS short_ids_row_id_uuid_format`;
    await sql`ALTER TABLE edges DROP CONSTRAINT IF EXISTS edges_from_id_uuid_format`;
    await sql`ALTER TABLE edges DROP CONSTRAINT IF EXISTS edges_to_id_uuid_format`;
    await sql`DELETE FROM migrations WHERE version = '0002_uuid_format_check'`;
    await sql.end();
  });

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'substrate-admin-uuid-test-'));
    keyPath = join(tmp, 'admin.key');
    out = [];
    err = [];
    await sql`DELETE FROM rows WHERE namespace = ${SYSTEM_NAMESPACE} AND type = ${KEY_TYPE}`;
  });

  afterEach(async () => {
    rmSync(tmp, { recursive: true, force: true });
    await sql`DELETE FROM rows WHERE namespace = ${SYSTEM_NAMESPACE} AND type = ${KEY_TYPE}`;
  });

  it('bootstrap writes a UUID-shape kid that satisfies rows_id_uuid_format', async () => {
    const exitCode = await main(
      ['bootstrap'],
      { SUBSTRATE_DATABASE_URL: POSTGRES_URL as string, SUBSTRATE_ADMIN_KEY_PATH: keyPath },
      (s) => out.push(s),
      (s) => err.push(s)
    );
    expect(exitCode).toBe(0);
    expect(err).toHaveLength(0);

    // Stdout reports a UUID-shape kid AND a sha256 fingerprint as a separate
    // field, so the fingerprint does not overload the primary key.
    const stdout = out.join('');
    const kidMatch = stdout.match(/kid:\s+([A-Za-z0-9_-]+)/);
    expect(kidMatch).not.toBeNull();
    expect(kidMatch?.[1]).toMatch(UUID_RE);
    expect(stdout).toMatch(/fingerprint:\s+sha256:/);

    // Row landed and its id is the same UUID-shape kid.
    const dataset = new PgDataset({ namespace: SYSTEM_NAMESPACE, sql });
    const { rows } = await dataset.read(KEY_TYPE, {});
    expect(rows).toHaveLength(1);
    const rowId = typeof rows[0]?.id === 'string' ? rows[0].id : '';
    expect(rowId).toMatch(UUID_RE);
    expect(rowId).toBe(kidMatch?.[1]);
  });
});
