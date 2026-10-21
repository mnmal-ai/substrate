/**
 * Key-file helpers for onboarding: generating a keypair for the register steps, and
 * knowing in advance when `bootstrap` would refuse. Both refuse to overwrite, like
 * `bootstrap`: clobbering key material destroys an identity silently.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type AdminCliEnv, bootstrapKidPath, resolveDefaultKeyPath } from '../env.js';
import { AdminCliError } from '../errors.js';
import { generateAdminKeypair } from '../keys.js';

/** `~` and `~/…` against HOME; a shell would have done this, a prompt does not. */
function expandHome(env: AdminCliEnv, path: string): string {
  if (path !== '~' && !path.startsWith('~/')) return path;
  return join(env.HOME ?? homedir(), path.slice(1));
}

/**
 * Writes `<path>` (0600) and `<path>.pub`, plus `<path minus .key>.kid` when a kid is
 * given — the file the credential resolver reads beside a named key. Creates missing
 * parent directories 0700. On a failed write, removes whatever this call already wrote.
 */
export function writeKeypair(
  env: AdminCliEnv,
  path: string,
  kid?: string
): { privateKeyPath: string; publicKeyPath: string; kidPath?: string } {
  const privateKeyPath = expandHome(env, path);
  const publicKeyPath = `${privateKeyPath}.pub`;
  const kidPath = kid === undefined ? undefined : `${privateKeyPath.replace(/\.key$/, '')}.kid`;
  const targets = [privateKeyPath, publicKeyPath, ...(kidPath === undefined ? [] : [kidPath])];
  for (const p of targets) {
    if (existsSync(p)) throw new AdminCliError(`'${p}' already exists — choose another path`, 1);
  }
  const { publicKeyPem, privateKeyPem } = generateAdminKeypair(env, false);
  mkdirSync(dirname(privateKeyPath), { recursive: true, mode: 0o700 });
  const written: string[] = [];
  try {
    // `wx` closes the window between the existence check and the write.
    writeFileSync(privateKeyPath, privateKeyPem, { mode: 0o600, flag: 'wx' });
    written.push(privateKeyPath);
    writeFileSync(publicKeyPath, publicKeyPem, { mode: 0o644, flag: 'wx' });
    written.push(publicKeyPath);
    if (kidPath !== undefined && kid !== undefined) {
      writeFileSync(kidPath, `${kid}\n`, { mode: 0o600, flag: 'wx' });
    }
  } catch (err) {
    // A private key without its .pub would block a retry at the same path for nothing.
    for (const p of written) rmSync(p, { force: true });
    throw err;
  }
  return { privateKeyPath, publicKeyPath, ...(kidPath === undefined ? {} : { kidPath }) };
}

/**
 * The files whose presence makes `bootstrap` refuse — its own guards, checked without
 * opening postgres, so onboard offers bootstrap only when it can succeed.
 */
export function bootstrapBlockers(env: AdminCliEnv): string[] {
  return [resolveDefaultKeyPath(env), bootstrapKidPath(env)].filter((p) => existsSync(p));
}
