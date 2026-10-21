/**
 * `rotate` — mint a fresh keypair for an existing kid and retire the old row,
 * in one transaction.
 *
 * `--out` is required and must not already exist. An admin tool that silently
 * clobbers an operator's private key destroys the only copy of a credential.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AUDIT_EVENT_TYPE, buildAuditRow, KEY_TYPE } from '@mnmal-ai/substrate-compose';
import { validateArgv } from '../argv.js';
import { type OpenDatasetFn, openPgDataset } from '../dataset.js';
import type { AdminCliEnv } from '../env.js';
import { AdminCliError } from '../errors.js';
import {
  ACTOR_HINT,
  base64Url,
  CLI_ACTOR_KID,
  forUpdate,
  generateAdminKeypair,
  readKeyById
} from '../keys.js';
import { argvError, RESTART_NOTE } from '../usage.js';

export interface RotateResult {
  oldKid: string;
  newKid: string;
  fingerprint: string;
  privateKeyPath: string;
  name: string;
  namespaces: string;
  capabilities: string;
  encrypted: boolean;
}

export interface RotateArgs {
  kid: string;
  outPath: string;
  wantsEncrypt: boolean;
}

export function parseRotateArgs(argv: ReadonlyArray<string>): RotateArgs {
  try {
    return parseRotateArgsInner(argv);
  } catch (err) {
    if (err instanceof AdminCliError) throw argvError('rotate', err.message, err.exitCode);
    throw err;
  }
}

function parseRotateArgsInner(argv: ReadonlyArray<string>): RotateArgs {
  // argv[0] is 'rotate'; positional + flag follow. We accept either
  // `rotate <kid> --out <path>` or `rotate --out <path> <kid>` for operator
  // ergonomics, but only one `--out` / `--encrypt` is permitted and `<kid>`
  // must appear exactly once. `--encrypt` is a boolean with no value.
  const rest = argv.slice(1);
  validateArgv('rotate', rest);
  let kid: string | undefined;
  let outPath: string | undefined;
  let wantsEncrypt = false;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    // Narrowing: tsconfig has noUncheckedIndexedAccess so rest[i] is string|undefined
    // even though the loop bound guarantees non-undefined. One-line guard is cleaner
    // than scattering `!` assertions through the branches.
    if (tok === undefined) continue;
    if (tok === '--out') {
      if (outPath !== undefined) {
        throw new AdminCliError('rotate: --out specified more than once', 1);
      }
      const val = rest[i + 1];
      if (val === undefined || val.length === 0 || val.startsWith('--')) {
        throw new AdminCliError('rotate: --out requires a path argument', 1);
      }
      outPath = val;
      i += 1;
    } else if (tok === '--encrypt') {
      if (wantsEncrypt) {
        throw new AdminCliError('rotate: --encrypt specified more than once', 1);
      }
      wantsEncrypt = true;
    } else {
      // Only a bare token reaches here: validateArgv has already refused every
      // unknown flag and any second positional.
      kid = tok;
    }
  }
  if (kid === undefined || kid.length === 0) {
    throw new AdminCliError('rotate requires a <kid> positional arg', 1);
  }
  if (outPath === undefined || outPath.length === 0) {
    throw new AdminCliError('rotate requires --out <path>', 1);
  }
  return { kid, outPath, wantsEncrypt };
}

export async function runRotate(
  kid: string,
  outPath: string,
  env: AdminCliEnv,
  wantsEncrypt = false,
  openDataset: OpenDatasetFn = openPgDataset
): Promise<RotateResult> {
  if (kid === undefined || kid.length === 0) {
    throw new AdminCliError('rotate requires a <kid> positional arg');
  }
  if (outPath === undefined || outPath.length === 0) {
    throw new AdminCliError('rotate requires --out <path>');
  }
  // Refuse clobber BEFORE opening the dataset — same posture as bootstrap.
  if (existsSync(outPath)) {
    throw new AdminCliError(`--out path already exists: ${outPath} (move it aside and retry)`, 2);
  }
  // Mint the keypair BEFORE opening the dataset so a bad passphrase env
  // bails without a pg round-trip. `generateAdminKeypair` throws
  // AdminCliError(6) when --encrypt is set without SUBSTRATE_ADMIN_KEY_PASSPHRASE.
  const { publicKeyPem, privateKeyPem, encrypted } = generateAdminKeypair(env, wantsEncrypt);

  // Persist the key BEFORE the transaction revokes the old one: a write that
  // fails after commit would leave the principal with no usable key.
  try {
    mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 });
    writeFileSync(outPath, privateKeyPem, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AdminCliError(
      `failed to write private key to '${outPath}': ${msg}. Nothing was changed.`,
      5
    );
  }

  let committed = false;
  const { dataset, close } = await openDataset(env).catch((err: unknown) => {
    rmSync(outPath, { force: true });
    throw err;
  });
  try {
    // New kid is a fresh UUID for parity with `bootstrap` and to satisfy
    // the optional UUID CHECK constraint when enforced. The fingerprint
    // remains a sha256-derived operator-facing value, surfaced separately.
    const newKid = randomUUID();
    const shaFull = createHash('sha256').update(publicKeyPem).digest();
    const fingerprint = `sha256:${base64Url(shaFull).slice(0, 8)}`;

    const { name, namespaces, capabilities } = await dataset.withTransaction(async (tx) => {
      const existing = await readKeyById(tx, kid);
      if (existing === null) {
        throw new AdminCliError(`no Key with kid ${kid}`, 3);
      }
      if (existing.revokedAt != null) {
        throw new AdminCliError(`cannot rotate revoked Key ${kid}`, 4);
      }
      const preservedName = typeof existing.row.name === 'string' ? existing.row.name : '';
      const preservedAlgorithm =
        typeof existing.row.algorithm === 'string' ? existing.row.algorithm : 'EdDSA';
      // Runtime guard: the keypair we mint is ed25519, so preserving a
      // non-EdDSA algorithm string would write a row whose stored algorithm
      // label contradicts its public key material. Refuse rather than silently
      // drift — when the CLI grows RS256/ES256 support, this branch becomes
      // an algorithm-aware generator dispatch.
      if (preservedAlgorithm !== 'EdDSA') {
        throw new AdminCliError(
          `cannot rotate Key with algorithm '${preservedAlgorithm}' — only EdDSA is currently supported by the CLI`,
          5
        );
      }
      const preservedNamespaces =
        typeof existing.row.namespaces === 'string' ? existing.row.namespaces : '';
      const preservedCapabilities =
        typeof existing.row.capabilities === 'string' ? existing.row.capabilities : '';
      // readKeyById found this row BY its kid field, so kid is a non-empty string.
      const preservedKid = existing.row.kid as string;
      const now = new Date();

      // REVOKE FIRST, then insert. A unique index over `(body->>'kid')` WHERE
      // `revokedAt IS NULL` forbids two live rows per principal, and it is
      // checked per statement, not at commit — so insert-then-revoke fails on
      // pg. Both writes share one transaction, so no reader sees either
      // intermediate state.
      await tx.write(KEY_TYPE, [forUpdate({ ...existing.row, revokedAt: now })], ACTOR_HINT);
      await tx.write(
        KEY_TYPE,
        [
          {
            id: newKid,
            kid: preservedKid, // principal survives rotation
            name: preservedName,
            // Preserve the algorithm string so a future ES256/RS256 rotation
            // doesn't silently coerce to EdDSA. The keypair IS EdDSA regardless,
            // which is the one algorithm we currently support at the CLI
            // seam — documented mismatch for a later upgrade.
            algorithm: preservedAlgorithm,
            publicKey: publicKeyPem,
            namespaces: preservedNamespaces,
            capabilities: preservedCapabilities,
            revokedAt: null
          }
        ],
        ACTOR_HINT
      );
      await tx.write(
        AUDIT_EVENT_TYPE,
        [
          buildAuditRow({
            actorKid: CLI_ACTOR_KID,
            kind: 'key_rotated',
            targetKid: kid,
            details: { oldKid: kid, newKid, name: preservedName },
            now
          })
        ],
        ACTOR_HINT
      );

      return {
        name: preservedName,
        namespaces: preservedNamespaces,
        capabilities: preservedCapabilities
      };
    });

    committed = true;

    return {
      oldKid: kid,
      newKid,
      fingerprint,
      privateKeyPath: outPath,
      name,
      namespaces,
      capabilities,
      encrypted
    };
  } finally {
    // The key file is only worth keeping if its public half is now live.
    if (!committed) rmSync(outPath, { force: true });
    await close();
  }
}

export function formatRotateOutput(result: RotateResult): string {
  const encLabel = result.encrypted ? 'encrypted: aes-256-cbc+pbes2' : 'unencrypted';
  return [
    'substrate-admin rotate complete.',
    `old kid:         ${result.oldKid}`,
    `new kid:         ${result.newKid}`,
    `fingerprint:     ${result.fingerprint}`,
    `private key:     ${result.privateKeyPath}   (mode 0600, ${encLabel})`,
    `namespaces:      ${result.namespaces}`,
    `capabilities:    ${result.capabilities}`,
    '',
    `Use the new private key to sign JWTs with kid=${result.newKid} to authenticate. The old key is revoked and no longer valid.`,
    '',
    RESTART_NOTE,
    ''
  ].join('\n');
}
