import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The admin-identity env both `substrate-admin` and substrate-tui read. */
export interface AdminEnv {
  SUBSTRATE_ADMIN_TOKEN?: string;
  SUBSTRATE_ADMIN_KEY_PATH?: string;
  SUBSTRATE_ADMIN_KEY_ID?: string;
  /** The capability that means admin; default `admin`. Read by the diagnosers, not the resolver. */
  SUBSTRATE_ADMIN_CAPABILITY?: string;
  HOME?: string;
}

/** Where the admin identity is: a ready bearer, a key to sign with, or why neither. */
export type AdminCredential =
  | { readonly kind: 'token'; readonly authorization: string }
  | { readonly kind: 'key'; readonly keyPath: string; readonly kid: string }
  | { readonly kind: 'error'; readonly error: string };

/**
 * Where `bootstrap` writes the admin private key, and where
 * {@link resolveAdminCredential} looks for it.
 */
export function resolveDefaultKeyPath(env: AdminEnv): string {
  if (env.SUBSTRATE_ADMIN_KEY_PATH !== undefined && env.SUBSTRATE_ADMIN_KEY_PATH.length > 0) {
    return env.SUBSTRATE_ADMIN_KEY_PATH;
  }
  const home = env.HOME ?? homedir();
  return join(home, '.config', 'substrate', 'admin.key');
}

/** Companion to {@link resolveDefaultKeyPath}, for the kid file. */
export function resolveDefaultKidPath(env: AdminEnv): string {
  const home = env.HOME ?? homedir();
  return join(home, '.config', 'substrate', 'admin.kid');
}

/**
 * Locate the admin credential, or explain what to set. Signing is the caller's
 * job: it may need a passphrase for the key first.
 *
 * Fail-loud: a message naming the missing key is more use than the 401 an
 * unauthenticated admin call would get.
 */
export function resolveAdminCredential(env: AdminEnv): AdminCredential {
  const token = env.SUBSTRATE_ADMIN_TOKEN;
  if (typeof token === 'string' && token.length > 0) {
    return {
      kind: 'token',
      authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`
    };
  }
  const bootstrapKeyPath = resolveDefaultKeyPath(env);
  const explicitKey =
    env.SUBSTRATE_ADMIN_KEY_PATH !== undefined && env.SUBSTRATE_ADMIN_KEY_PATH.length > 0;
  const keyPath = explicitKey ? (env.SUBSTRATE_ADMIN_KEY_PATH as string) : bootstrapKeyPath;
  let kid = env.SUBSTRATE_ADMIN_KEY_ID;
  if (kid === undefined || kid.length === 0) {
    // Beside the key when one was named (SUBSTRATE_ADMIN_KEY_PATH, or bootstrap's
    // SUBSTRATE_ADMIN_KEY_PATH), else the default path — mirrors where `bootstrap` writes it.
    const besideKey = (path: string) => `${path.replace(/\.key$/, '')}.kid`;
    const kidFile = explicitKey
      ? besideKey(env.SUBSTRATE_ADMIN_KEY_PATH as string)
      : env.SUBSTRATE_ADMIN_KEY_PATH !== undefined && env.SUBSTRATE_ADMIN_KEY_PATH.length > 0
        ? besideKey(bootstrapKeyPath)
        : resolveDefaultKidPath(env);
    try {
      kid = readFileSync(kidFile, 'utf8').trim();
    } catch {
      return {
        kind: 'error',
        error: `no admin identity: set SUBSTRATE_ADMIN_TOKEN, or SUBSTRATE_ADMIN_KEY_ID (no ${kidFile})`
      };
    }
  }
  return { kind: 'key', keyPath, kid };
}
