/**
 * Where the admin CLI's key files live, and the env it reads them from.
 *
 * These resolvers live together because they answer one question — *which
 * file is this deployment's admin identity?* — and `bootstrap` (the writer)
 * and `resolveAdminAuth` (the reader) must agree on it.
 */

import { resolveDefaultKeyPath, resolveDefaultKidPath } from '@mnmal-ai/substrate-policy';

export {
  resolveDefaultKeyPath,
  resolveDefaultKidPath
} from '@mnmal-ai/substrate-policy';

export interface AdminCliEnv {
  SUBSTRATE_DATABASE_URL?: string;
  SUBSTRATE_ADMIN_CAPABILITY?: string;
  SUBSTRATE_ADMIN_KEY_PATH?: string;
  /**
   * Passphrase for `--encrypt` on `bootstrap` / `rotate`. Required (non-empty)
   * when the flag is set; ignored otherwise. No TTY prompt fallback — env-only
   * by design so the CLI stays scriptable.
   */
  SUBSTRATE_ADMIN_KEY_PASSPHRASE?: string;
  /** Default base URL for route-driven subcommands (`register` without --url). */
  SUBSTRATE_URL?: string;
  /** Ready bearer for the admin route, with or without the `Bearer ` prefix. */
  SUBSTRATE_ADMIN_TOKEN?: string;
  /** kid that pairs with `SUBSTRATE_ADMIN_KEY_PATH`. */
  SUBSTRATE_ADMIN_KEY_ID?: string;
  /** `migrate-store`'s default source and target connection strings (`--from-env` / `--to-env` name others). */
  SUBSTRATE_MIGRATE_FROM_URL?: string;
  SUBSTRATE_MIGRATE_TO_URL?: string;
  HOME?: string;
}

// `bootstrap`'s name for `AdminCliEnv`.
export type BootstrapEnv = AdminCliEnv;

/**
 * Where `bootstrap` writes the kid. Beside the key when one was named
 * explicitly, else the default path.
 */
export function bootstrapKidPath(env: AdminCliEnv): string {
  return env.SUBSTRATE_ADMIN_KEY_PATH !== undefined && env.SUBSTRATE_ADMIN_KEY_PATH.length > 0
    ? `${resolveDefaultKeyPath(env).replace(/\.key$/, '')}.kid`
    : resolveDefaultKidPath(env);
}
