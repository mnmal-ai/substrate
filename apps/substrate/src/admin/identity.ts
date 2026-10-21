/**
 * WHICH store a credential write lands in, and WHICH identity signs it —
 * each resolved explicitly and reported with where the choice came from.
 */

import { tokenAudience } from '@mnmal-ai/substrate-client';
import {
  adminClaimCapabilities,
  makeAuthorizationProvider,
  resolveAdminCredential
} from '@mnmal-ai/substrate-policy';
import type { AdminCliEnv } from './env.js';
import { AdminCliError } from './errors.js';

/**
 * Where a route-capable subcommand is about to write, and WHY that was chosen.
 * `source` is reported so a misdirected write is not mistaken for a
 * credentials problem.
 */
export type AdminTarget =
  | { kind: 'route'; baseUrl: string; source: 'flag' | 'env' }
  | { kind: 'direct'; source: 'flag' | 'fallback' };

/**
 * Resolve the target for `update` / `revoke` / `register`.
 *
 * `explicitUrl` is the parser's tri-state: a base URL from `--url`, the empty
 * string from `--direct`, and `null` for "said nothing".
 *
 * When both `SUBSTRATE_URL` and `SUBSTRATE_DATABASE_URL` are set ambiently and no flag
 * chooses, this throws naming both escape hatches rather than picking: they
 * name two different stores, and a credential write to the wrong one can
 * succeed.
 */
export function resolveAdminTarget(explicitUrl: string | null, env: AdminCliEnv): AdminTarget {
  if (explicitUrl !== null) {
    return explicitUrl.length > 0
      ? { kind: 'route', baseUrl: explicitUrl, source: 'flag' }
      : { kind: 'direct', source: 'flag' };
  }
  const ambientUrl =
    env.SUBSTRATE_URL !== undefined && env.SUBSTRATE_URL.length > 0 ? env.SUBSTRATE_URL : null;
  const ambientStore =
    env.SUBSTRATE_DATABASE_URL !== undefined && env.SUBSTRATE_DATABASE_URL.length > 0
      ? env.SUBSTRATE_DATABASE_URL
      : null;
  if (ambientUrl !== null && ambientStore !== null) {
    throw new AdminCliError(
      'two targets given and neither was chosen: SUBSTRATE_URL names a running server ' +
        `(${ambientUrl}) and SUBSTRATE_DATABASE_URL names a postgres store. This is a credential write, ` +
        'so it will not guess. Pass `--url <base>` to go through the server, or `--direct` ' +
        'to write to SUBSTRATE_DATABASE_URL.',
      1
    );
  }
  return ambientUrl !== null
    ? { kind: 'route', baseUrl: ambientUrl, source: 'env' }
    : { kind: 'direct', source: 'fallback' };
}

/**
 * One line, printed BEFORE the write, naming the destination and its
 * provenance, so a misdirected command is self-diagnosing.
 */
export function describeAdminTarget(command: string, target: AdminTarget): string {
  if (target.kind === 'route') {
    const from = target.source === 'flag' ? '--url' : 'SUBSTRATE_URL';
    return `${command}: targeting ${target.baseUrl} (from ${from})`;
  }
  const from = target.source === 'flag' ? '--direct' : 'SUBSTRATE_DATABASE_URL';
  return `${command}: targeting the postgres store DIRECTLY, bypassing the running server (from ${from})`;
}

/**
 * Build the `Authorization` value for an admin route at `baseUrl`, or explain
 * what to set. A minted token names `baseUrl`'s origin as its `aud`; a
 * `baseUrl` that is plain http to a non-loopback host is refused.
 *
 * Fail-loud: a message naming the missing key is more use than the 401 an
 * unauthenticated admin call would get.
 */
export function resolveAdminAuth(
  env: AdminCliEnv,
  baseUrl: string
): { ok: string } | { error: string } {
  let audience: string;
  try {
    audience = tokenAudience(baseUrl);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const cred = resolveAdminCredential(env);
  if (cred.kind === 'error') return { error: cred.error };
  if (cred.kind === 'token') return { ok: cred.authorization };
  const passphrase =
    env.SUBSTRATE_ADMIN_KEY_PASSPHRASE !== undefined &&
    env.SUBSTRATE_ADMIN_KEY_PASSPHRASE.length > 0
      ? { passphrase: env.SUBSTRATE_ADMIN_KEY_PASSPHRASE }
      : {};
  try {
    // The admin set, not the default: the registry row narrows the claim by
    // intersection, so a token claiming only `read`/`mutate` against an
    // admin-granted row intersects to NOTHING. Claiming the superset costs
    // nothing: the row is still the authority.
    return {
      ok: makeAuthorizationProvider(
        { keyPath: cred.keyPath, kid: cred.kid },
        { capabilities: adminClaimCapabilities(env), audience, ...passphrase }
      )()
    };
  } catch (err) {
    return {
      error: `could not sign with ${cred.keyPath}: ${err instanceof Error ? err.message : err}`
    };
  }
}
