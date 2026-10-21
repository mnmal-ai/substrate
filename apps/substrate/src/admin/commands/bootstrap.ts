/**
 * `bootstrap` — seed the genesis admin Key on a fresh `_system` namespace.
 *
 * The one subcommand that CANNOT go through the route: it exists to create the
 * first admin identity, so there is none to present. Direct-to-postgres is not
 * a legacy path here, it is the only possible one.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { encodeList, KEY_TYPE, SYSTEM_NAMESPACE } from '@mnmal-ai/substrate-compose';
import { PgDataset, runMigrations } from '@mnmal-ai/substrate-dataset-pg';
import { ADMIN_CAPABILITIES } from '@mnmal-ai/substrate-policy';
import type { Sql } from 'postgres';
import postgres from 'postgres';
import { validateArgv } from '../argv.js';
import { type AdminCliEnv, bootstrapKidPath, resolveDefaultKeyPath } from '../env.js';
import { AdminCliError } from '../errors.js';
import {
  BootstrapError,
  base64Url,
  DEFAULT_ADMIN_CAPABILITY,
  firstAdminKey,
  generateAdminKeypair
} from '../keys.js';
import { argvError, RESTART_NOTE } from '../usage.js';
import { redactStore } from './onboard.js';

export interface BootstrapResult {
  kid: string;
  fingerprint: string;
  privateKeyPath: string;
  namespaces: string;
  capabilities: string;
  encrypted: boolean;
}

/**
 * What the genesis row grants: the admin capability plus `read` / `mutate`.
 *
 * `resolveAdminAuth` mints with `adminClaimCapabilities`, a superset of this
 * row for any `adminCapability`, and `auth.ts` intersects that claim against
 * the row, so the row is the ceiling. Derived from the same constant so the
 * two cannot drift; `admin` alone does not satisfy the per-frame `read` /
 * `mutate` gates.
 */
export function seedCapabilities(adminCapability: string): Array<string> {
  return [...ADMIN_CAPABILITIES.filter((c) => c !== DEFAULT_ADMIN_CAPABILITY), adminCapability];
}

/**
 * Perform the bootstrap.
 *
 * `wantsEncrypt` controls whether the on-disk private-key PEM is
 * PBES2-encrypted with `SUBSTRATE_ADMIN_KEY_PASSPHRASE`. Defaults to false.
 */
export async function runBootstrap(
  env: AdminCliEnv,
  wantsEncrypt = false,
  openSql: (url: string) => Sql = postgres
): Promise<BootstrapResult> {
  const storeSpec = env.SUBSTRATE_DATABASE_URL;
  if (storeSpec === undefined || storeSpec.length === 0) {
    throw new BootstrapError('SUBSTRATE_DATABASE_URL is required (must be a postgres:// URL)');
  }
  if (!storeSpec.startsWith('postgres://') && !storeSpec.startsWith('postgresql://')) {
    throw new BootstrapError(
      `SUBSTRATE_DATABASE_URL must be a postgres:// URL for bootstrap (got '${redactStore(storeSpec)}'). Memory-backed stores cannot persist the admin key across restarts.`
    );
  }
  const adminCapability =
    env.SUBSTRATE_ADMIN_CAPABILITY !== undefined && env.SUBSTRATE_ADMIN_CAPABILITY.length > 0
      ? env.SUBSTRATE_ADMIN_CAPABILITY
      : DEFAULT_ADMIN_CAPABILITY;
  const seededCapabilities = seedCapabilities(adminCapability);
  const privateKeyPath = resolveDefaultKeyPath(env);

  // Resolve file refusal BEFORE opening the pg connection so we don't spin up
  // substrate just to bail. Writing admin key material to an existing file
  // would clobber prior operator work.
  //
  // All THREE files `resolveAdminAuth` consults are guarded here, not just the
  // one bootstrap overwrites. The store-level `firstAdminKey` check below
  // cannot stand in for these: it speaks only for the store being
  // bootstrapped, not for the identity already on this box.
  if (existsSync(privateKeyPath)) {
    throw new BootstrapError(
      `private key path '${privateKeyPath}' already exists — move it aside and retry`
    );
  }
  const kidPath = bootstrapKidPath(env);
  if (existsSync(kidPath)) {
    throw new BootstrapError(`kid path '${kidPath}' already exists — move it aside and retry`);
  }
  // Mint the keypair BEFORE opening pg so a bad --encrypt passphrase env
  // fails loud without a pg round-trip. `generateAdminKeypair` throws
  // AdminCliError(6) when --encrypt is set but SUBSTRATE_ADMIN_KEY_PASSPHRASE is
  // missing/empty.
  const { publicKeyPem, privateKeyPem, encrypted } = generateAdminKeypair(env, wantsEncrypt);

  const sql = openSql(storeSpec);
  let dataset: PgDataset;
  try {
    await runMigrations(sql);
    dataset = new PgDataset({
      namespace: SYSTEM_NAMESPACE,
      sql
    });
    // Held across the check and the write, so two concurrent bootstraps
    // cannot both find no admin and both create one.
    return await dataset.withAdvisoryLock('substrate:bootstrap', async () => {
      const existing = await firstAdminKey(dataset, adminCapability);
      if (existing !== null) {
        throw new BootstrapError(
          `admin Key already bootstrapped (kid: ${existing.kid}). Revoke or purge it via the _system namespace before running bootstrap again.`
        );
      }

      // kid is a fresh UUID — the only shape the optional
      // `rows_id_uuid_format` CHECK constraint (gated on
      // SUBSTRATE_ENFORCE_UUID_CHECK) accepts. The fingerprint is a separate
      // operator-facing value.
      const kid = randomUUID();
      const shaFull = createHash('sha256').update(publicKeyPem).digest();
      const fingerprint = `sha256:${base64Url(shaFull).slice(0, 8)}`;

      const parentDir = dirname(privateKeyPath);
      // mkdirSync with `recursive: true` is a no-op for existing dirs; the mode
      // only applies to freshly-created segments. Key-file is 0600 regardless.
      mkdirSync(parentDir, { recursive: true, mode: 0o700 });
      // `wx`: never overwrite a key file that appeared after the check above.
      writeFileSync(privateKeyPath, privateKeyPem, { mode: 0o600, flag: 'wx' });
      // Persist the kid beside the key, where `resolveAdminAuth` looks for it.
      // Next to the key rather than a fixed path so a box administering two
      // deployments keeps them separate. `kidPath` is resolved with the guards
      // above so the path checked and the path written cannot diverge.
      writeFileSync(kidPath, `${kid}\n`, { mode: 0o600, flag: 'wx' });

      const now = new Date();
      await dataset.write(
        KEY_TYPE,
        [
          {
            id: kid,
            kid, // bootstrap's principal id IS its UUID (no token change)
            name: 'bootstrap-admin',
            algorithm: 'EdDSA',
            publicKey: publicKeyPem,
            namespaces: '*',
            capabilities: encodeList(seededCapabilities),
            revokedAt: null
          }
        ],
        { identity: { kind: 'system', id: 'bootstrap' }, now }
      );

      return {
        kid,
        fingerprint,
        privateKeyPath,
        namespaces: '*',
        capabilities: seededCapabilities.join(','),
        encrypted
      };
    });
  } finally {
    // Close the pool whether or not we succeeded. Swallow errors from
    // `.end()` — a failing close AFTER a successful write is less important
    // than surfacing the underlying bootstrap error to the operator.
    try {
      await sql.end();
    } catch {
      // noop
    }
  }
}

export function formatBootstrapOutput(result: BootstrapResult): string {
  const encLabel = result.encrypted ? 'encrypted: aes-256-cbc+pbes2' : 'unencrypted';
  return [
    'substrate-admin bootstrap complete.',
    `kid:              ${result.kid}`,
    `fingerprint:      ${result.fingerprint}`,
    `private key:      ${result.privateKeyPath}   (mode 0600, ${encLabel})`,
    `namespaces:       ${result.namespaces}`,
    `capabilities:     ${result.capabilities}`,
    '',
    `Use the private key to sign JWTs with kid=${result.kid} to authenticate as admin.`,
    '',
    RESTART_NOTE,
    ''
  ].join('\n');
}

export interface BootstrapArgs {
  wantsEncrypt: boolean;
}

export function parseBootstrapArgs(argv: ReadonlyArray<string>): BootstrapArgs {
  try {
    return parseBootstrapArgsInner(argv);
  } catch (err) {
    if (err instanceof AdminCliError) throw argvError('bootstrap', err.message, err.exitCode);
    throw err;
  }
}

function parseBootstrapArgsInner(argv: ReadonlyArray<string>): BootstrapArgs {
  // argv[0] is 'bootstrap'. Unknown flags and stray positionals are refused by
  // `validateArgv` per `ARGV_SPEC`; what remains here is this command's own.
  const rest = argv.slice(1);
  validateArgv('bootstrap', rest);
  let wantsEncrypt = false;
  for (const tok of rest) {
    if (tok === '--encrypt') {
      if (wantsEncrypt) {
        throw new AdminCliError('bootstrap: --encrypt specified more than once', 1);
      }
      wantsEncrypt = true;
    }
  }
  return { wantsEncrypt };
}
