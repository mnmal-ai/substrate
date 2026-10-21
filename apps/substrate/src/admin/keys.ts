/**
 * Key row plumbing shared by every subcommand: reading rows, classifying
 * the admin ones, minting keypairs, and the write-attribution hint.
 *
 * `listActiveAdminKeys` classifies through `isActiveAdminKeyRow` rather than
 * reading the flat `capabilities` column: a key stored
 * `namespaces: '*:read+mutate+admin'` carries no `admin` in `capabilities`
 * and is nonetheless an admin.
 */

import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isActiveAdminKeyRow, KEY_TYPE } from '@mnmal-ai/substrate-compose';
import type { Dataset, Row, RowMetadata } from '@mnmal-ai/substrate-types';
import type { AdminCliEnv } from './env.js';
import { AdminCliError } from './errors.js';

/** Sentinel `actorKid` stamped on every audit row emitted by this CLI. */
export const CLI_ACTOR_KID = 'substrate-admin-cli';

/**
 * Substrate auto-fill hint for every `_system` write this CLI makes. Without
 * it the row metadata (`createdBy` / `updatedBy`) lands NULL.
 *
 * `kind: 'system'` rather than `'agent'`: this is a component acting, not a
 * registered identity signing.
 */
export const ACTOR_HINT = { identity: { kind: 'system', id: CLI_ACTOR_KID } } as const;

/**
 * Strip `_metadata` from a row read back for update, so the write's
 * {@link ACTOR_HINT} actually takes effect.
 *
 * A dataset auto-fills metadata from `options.identity` only when the
 * incoming row has NO `_metadata`, so a row built as `{ ...existing.row, ... }`
 * would silently keep the previous `updatedBy`.
 *
 * Stripping is safe and does not lose `createdBy`: the dataset merges per-field
 * against the STORED row (`createdBy: existing.createdBy ?? incoming.createdBy`),
 * so `created*` survive from storage while `updated*` come from the hint.
 */
export function forUpdate(row: Row): Row {
  const { _metadata: _dropped, ...rest } = row as Row & { _metadata?: unknown };
  return rest as Row;
}

export interface KeypairResult {
  publicKeyPem: string;
  privateKeyPem: string;
  encrypted: boolean;
}

/**
 * Mint an ed25519 keypair for `bootstrap` / `rotate`. When `wantsEncrypt` is
 * true, the private-key PEM is PKCS#8+PBES2 (aes-256-cbc) encrypted with
 * `SUBSTRATE_ADMIN_KEY_PASSPHRASE` — the env var MUST be set to a non-empty value
 * or this helper hard-errors. When false, the PEM is cleartext PKCS#8.
 *
 * At-rest encryption is purely operator-side: the server only ever reads the
 * public key from pg, so the encrypted-ness of the on-disk private key has no
 * server-side coupling.
 */
export function generateAdminKeypair(env: AdminCliEnv, wantsEncrypt: boolean): KeypairResult {
  if (wantsEncrypt) {
    const passphrase = env.SUBSTRATE_ADMIN_KEY_PASSPHRASE;
    if (passphrase === undefined || passphrase.length === 0) {
      throw new AdminCliError(
        '--encrypt requires SUBSTRATE_ADMIN_KEY_PASSPHRASE to be set to a non-empty value',
        6
      );
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { format: 'pem', type: 'spki' },
      privateKeyEncoding: {
        format: 'pem',
        type: 'pkcs8',
        cipher: 'aes-256-cbc',
        passphrase
      }
    });
    return {
      publicKeyPem: publicKey.toString(),
      privateKeyPem: privateKey.toString(),
      encrypted: true
    };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { format: 'pem', type: 'spki' },
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' }
  });
  return {
    publicKeyPem: publicKey.toString(),
    privateKeyPem: privateKey.toString(),
    encrypted: false
  };
}

export class BootstrapError extends Error {
  override readonly name = 'BootstrapError';
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Minimum view of a Key row used by admin CLI filter logic.
 * Fields are narrowed from the generic `Row` to the three the CLI reads;
 * anything else is carried through as `Row` when we need to echo preserved
 * fields (see `rotate`).
 */
export interface AdminKeyRow {
  kid: string;
  name: string;
  namespaces: string;
  capabilities: string;
  createdAt: string | null;
}

export function rowAsAdminKey(row: Row): AdminKeyRow | null {
  const kid = row.kid;
  if (typeof kid !== 'string' || kid.length === 0) return null;
  const name = typeof row.name === 'string' ? row.name : '';
  const namespaces = typeof row.namespaces === 'string' ? row.namespaces : '';
  const capabilities = typeof row.capabilities === 'string' ? row.capabilities : '';
  // Read from _metadata.createdAt — the row-metadata column shadows any body
  // field of that name.
  const meta = row._metadata as RowMetadata | undefined;
  const createdAt = meta?.createdAt ?? null;
  return { kid, name, namespaces, capabilities, createdAt };
}

/**
 * Read every non-revoked Key row whose grant confers `adminCapability`
 * on `_system` (per `isActiveAdminKeyRow`). Scans the whole table, which is
 * fine at CLI cadence.
 */
export async function listActiveAdminKeys(
  dataset: Dataset,
  adminCapability: string
): Promise<Array<AdminKeyRow>> {
  const { rows } = await dataset.read(KEY_TYPE, {});
  const out: Array<AdminKeyRow> = [];
  for (const row of rows) {
    // Classification lives in substrate-compose so the CLI and the route path
    // cannot disagree about what an active admin IS.
    if (!isActiveAdminKeyRow(row, adminCapability)) continue;
    const ak = rowAsAdminKey(row);
    if (ak === null) continue;
    out.push(ak);
  }
  return out;
}

/**
 * `bootstrap`-specific helper: first matching admin row or `null`. Wraps
 * `listActiveAdminKeys` so the bootstrap contract ("refuse if ANY admin row
 * exists") doesn't leak the array shape out of this module.
 */
export async function firstAdminKey(
  dataset: Dataset,
  adminCapability: string
): Promise<AdminKeyRow | null> {
  const all = await listActiveAdminKeys(dataset, adminCapability);
  return all[0] ?? null;
}

/** The capability name that means "admin" when `SUBSTRATE_ADMIN_CAPABILITY` is unset. */
export const DEFAULT_ADMIN_CAPABILITY = 'admin';

export async function readKeyById(
  dataset: Dataset,
  kid: string
): Promise<{ row: Row; revokedAt: Date | string | null } | null> {
  // Resolve by the kid field (the principal an agent signs with). Mirrors
  // registry.refresh — every Key row carries a kid (migration 0021).
  // A rotated principal also has revoked rows, in no particular order: prefer the live one.
  const { rows } = await dataset.read(KEY_TYPE, { where: { kid: { eq: kid } } });
  const row = rows.find((r) => r.revokedAt == null) ?? rows[0];
  if (row === undefined) return null;
  const revokedAt =
    row.revokedAt instanceof Date
      ? row.revokedAt
      : typeof row.revokedAt === 'string'
        ? row.revokedAt
        : null;
  return { row, revokedAt };
}

/**
 * Read a public-key PEM from disk and assert it is Ed25519. Returns the PEM
 * text verbatim for storage on the Key row. Throws AdminCliError(2) on a
 * missing/unreadable file, a private-key PEM (missing `BEGIN PUBLIC KEY`
 * header — prevents accidental private-key leakage when the operator passes
 * the wrong file to `--pubkey`), an unparseable PEM, or a non-ed25519 key.
 * `register` only mints/accepts Ed25519 agent identities (the one alg the
 * verifier + signer support).
 */
export function readEd25519PublicKey(path: string): string {
  let pem: string;
  try {
    pem = readFileSync(path, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AdminCliError(`register: cannot read --pubkey '${path}': ${msg}`, 2);
  }
  if (!pem.includes('BEGIN PUBLIC KEY')) {
    throw new AdminCliError(
      `register: --pubkey '${path}' is not a public-key PEM (missing 'BEGIN PUBLIC KEY' header) — did you pass the private key by mistake?`,
      2
    );
  }
  let keyType: string | undefined;
  try {
    keyType = createPublicKey(pem).asymmetricKeyType;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AdminCliError(`register: --pubkey '${path}' is not a valid public key: ${msg}`, 2);
  }
  if (keyType !== 'ed25519') {
    throw new AdminCliError(
      `register: --pubkey '${path}' is ${keyType ?? 'unknown'}, expected ed25519`,
      2
    );
  }
  return pem;
}
