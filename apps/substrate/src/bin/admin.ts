#!/usr/bin/env node
/**
 * `substrate-admin` — admin CLI entrypoint (§5.12). This file is the ENTRYPOINT
 * and nothing else; the parts live under `../admin/`:
 *
 *   env.ts        which files hold the admin identity
 *   identity.ts   which store a write lands in, and which key signs it
 *   keys.ts       Key row plumbing, keypair minting, admin classification
 *   route.ts      driving PATCH /substrate/v1/_system/keys, refusal -> exit codes
 *   usage.ts      the help text
 *   main.ts       argv -> subcommand dispatch
 *   commands/*    one module per subcommand
 *
 * The public surface is re-exported below for tests, tooling and
 * `substrate federate enroll`.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openPgDataset } from '../admin/dataset.js';
import type { AdminCliEnv } from '../admin/env.js';
import { main } from '../admin/main.js';
import { createAsk } from '../admin/stdin-ask.js';

/**
 * Is this module the process entrypoint?
 *
 * Compares REALPATHS. Node resolves symlinks when it builds `import.meta.url`
 * but `process.argv[1]` is whatever the caller typed, so a naive comparison is
 * false whenever the file is reached through a link — which is EVERY install
 * under pnpm, whose `node_modules/<pkg>` is a symlink into `.pnpm/`, and
 * therefore every operational invocation including the `.bin` shim.
 *
 * Getting this wrong means `main` never runs: the CLI prints nothing and
 * **exits 0**, so `substrate-admin revoke <kid>` reports success and leaves the
 * key live.
 */
export function isEntrypointPath(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined || argv1.length === 0) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    // argv[1] may not exist on disk (a `node -e` run, a deleted file). Not the
    // entrypoint, and not an error worth surfacing from a predicate.
    return false;
  }
}

function isEntrypoint(): boolean {
  return isEntrypointPath(import.meta.url, process.argv[1]);
}

if (isEntrypoint()) {
  // Only an interactive onboard holds stdin open; every other subcommand stays scriptable.
  const interactive = process.stdin.isTTY === true && process.argv[2] === 'onboard';
  void main(
    process.argv.slice(2),
    process.env as AdminCliEnv,
    (s) => process.stdout.write(s),
    (s) => process.stderr.write(s),
    openPgDataset,
    interactive
      ? {
          ask: createAsk({
            input: process.stdin,
            output: process.stderr,
            terminal: true,
            // No prompt is open to notice a close, so leave now rather than after the request.
            onInterrupt: () => {
              process.stderr.write('\ninterrupted.\n');
              process.exit(130);
            }
          }),
          interactive: true
        }
      : { ask: async () => null, interactive: false }
  ).then((exitCode) => process.exit(exitCode));
}

// ---------------------------------------------------------------------------
// Re-exports — this file's public surface.
// ---------------------------------------------------------------------------

export {
  type BootstrapResult,
  formatBootstrapOutput,
  parseBootstrapArgs,
  runBootstrap
} from '../admin/commands/bootstrap.js';
export {
  type DirectoryReconciliation,
  type DoctorCheck,
  type DoctorReport,
  type DoctorStatus,
  doctorCommand,
  formatDoctorReport,
  reconcileIdentities,
  runDoctor
} from '../admin/commands/doctor.js';
export { type ListedKeyRow, parseListArgs, runList } from '../admin/commands/list.js';
export {
  formatChecklist,
  type OnboardActions,
  type OnboardIO,
  onboardCommand,
  runOnboard
} from '../admin/commands/onboard.js';
export {
  formatRegisterOutput,
  parseRegisterArgs,
  type RegisterResult,
  runRegister,
  runRegisterViaRoute
} from '../admin/commands/register.js';
export { formatRevokeOutput, type RevokeResult, runRevoke } from '../admin/commands/revoke.js';
export {
  formatRotateOutput,
  parseRotateArgs,
  type RotateResult,
  runRotate
} from '../admin/commands/rotate.js';
export {
  formatUpdateOutput,
  parseUpdateArgs,
  runUpdate,
  type UpdateResult
} from '../admin/commands/update.js';
export { type OpenDatasetFn, type OpenedDataset, openPgDataset } from '../admin/dataset.js';
export {
  type AdminCliEnv,
  type BootstrapEnv,
  bootstrapKidPath,
  resolveDefaultKeyPath,
  resolveDefaultKidPath
} from '../admin/env.js';
export { AdminCliError } from '../admin/errors.js';
export { describeGrant, grantLines } from '../admin/grant-display.js';
export {
  type AdminTarget,
  describeAdminTarget,
  resolveAdminAuth,
  resolveAdminTarget
} from '../admin/identity.js';
export {
  type AdminKeyRow,
  BootstrapError,
  listActiveAdminKeys,
  readEd25519PublicKey
} from '../admin/keys.js';
export { main } from '../admin/main.js';
