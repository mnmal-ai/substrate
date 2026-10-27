/** The `--help` text, kept beside the dispatch that has to stay true to it. */

import { AdminCliError } from './errors.js';

export const USAGE = [
  'Usage: substrate-admin <subcommand>',
  '       substrate-admin --version   print the package version (also -v, version)',
  '',
  'Subcommands:',
  '  bootstrap [--encrypt]                   seed the genesis admin Key',
  '  doctor [--url <base>]                   check this deployment end to end and say what is wrong',
  '  onboard [--url <base>] [--check]        walk a deployment to ready, offering to run each fix',
  '  list                                    print active Key rows (DIRECT to pg — does not authenticate)',
  '  list --url <base>                       ask a SERVER over the admin-gated route (authenticates)',
  '  revoke <kid>                            soft-delete a Key by kid',
  '  rotate <kid> --out <path> [--encrypt]   rotate a Key (new key to <path>)',
  '  register <kid> --pubkey <path> --ns <csv>   register an existing ed25519 pubkey as an agent Key',
  "  update <kid> [--ns <csv>] ...           change a live key's namespaces/caps/name in place",
  '  migrate-store [options]                 copy a store into a fresh, empty, partitioned PG 18 store',
  '',
  '  register transport: drives POST /substrate/v1/_system/keys (credential + directory row,',
  '    one transaction, no restart) using --url or SUBSTRATE_URL and an admin identity',
  '    (SUBSTRATE_ADMIN_TOKEN, or SUBSTRATE_ADMIN_KEY_PATH + SUBSTRATE_ADMIN_KEY_ID).',
  '    --direct forces the legacy direct-to-postgres write — break-glass only:',
  '    it needs the pg superuser password and CANNOT write the directory row.',
  '  register directory flags: --no-directory (credential only), --no-broadcast',
  '    (directory row with broadcastEligible false), --project <p>.',
  "  register flags: --ns <csv> is REQUIRED (use --ns '*' to grant every namespace);",
  '                  --name <n> --caps <csv> --allow-admin are optional.',
  '  update flags:   --name <n> --ns <csv> --caps <csv> --widen --allow-admin',
  '                  omitted flags leave that field unchanged; --widen is required',
  '                  only when the change grants authority the key does not have.',
  '  --ns entries may carry per-namespace capabilities:',
  '                  --ns inventory:read,notes:read+mutate   read inventory, write notes.',
  '                  A bare entry takes --caps, so --ns notes is unchanged.',
  '  --allow-unknown-ns (register + update): confirm a grant naming a namespace',
  '                  this deployment does not host. Without it such a grant is',
  '                  refused, because it is accepted by the store and then',
  '                  refused at every frame — it reads as granted and reaches',
  '                  nothing. Pass it to register ahead of a plugin install.',
  '  TARGET (register / revoke / update): --url <base> goes through a running',
  '                  server; --direct writes to SUBSTRATE_DATABASE_URL. Say neither and the',
  '                  target comes from SUBSTRATE_URL, or from SUBSTRATE_DATABASE_URL when no',
  '                  SUBSTRATE_URL is set. If BOTH are set and you name neither, the',
  '                  command REFUSES rather than guessing — these are credential',
  '                  writes and a silent choice can PATCH the wrong store. Every',
  '                  run prints the target and where it came from before acting.',
  '  doctor goes through the running server on purpose: it is the one command that can',
  '    answer NO about auth. It checks reachability, whether the server verifies',
  '    credentials at all, whether YOUR admin credential resolves, whether the grant it',
  '    resolves to confers admin, and how many admin keys the deployment has left.',
  '    A check it could not run prints as `skip`, never as a pass.',
  '  --encrypt produces a PKCS#8+PBES2 (aes-256-cbc) encrypted private-key PEM.',
  '  Passphrase is read from SUBSTRATE_ADMIN_KEY_PASSPHRASE (required when --encrypt is set).',
  '  An encrypted admin key is read with SUBSTRATE_ADMIN_KEY_PASSPHRASE for every command that signs.',
  '  migrate-store: reads the source and target connection strings from environment variables,',
  '    SUBSTRATE_MIGRATE_FROM_URL and SUBSTRATE_MIGRATE_TO_URL unless --from-env / --to-env name',
  '    others; a connection string on argv is refused. Stop the service first. The source is',
  '    only read. The target must be empty and on PostgreSQL 18; it is prepared with the same',
  '    migrations and plugins (SUBSTRATE_PLUGIN_DIR) serve uses, copied, indexed and verified.',
  '    SUBSTRATE_INDEX_DISK_PATH must be set (the target volume mount, or off).',
  '    --from-schema / --to-schema <s>  pin a side to schema <s>',
  '    --dry-run          preflight only: the plan, every refusal, nothing written',
  '    --verify-only      verify a finished copy against its source',
  '    --skip-index-build leave non-unique index builds to the first serve boot',
  '    --full-checksum    hash every row rather than a sample per type',
  '    --batch-rows <n>   rows between progress lines (default 10000)',
  '    --skip-table <t>   waive a source table nothing declares (repeatable)',
  '    --json             the final report as one JSON object on stdout; progress is on stderr',
  '    Exit: 0 copied and verified; 2 refused or a usage error; 3 verification failed; 1 otherwise.'
].join('\n');

/** One-line synopsis per subcommand — the shape the operator typed wrong. */
export const SYNOPSIS: Record<string, string> = {
  bootstrap: 'substrate-admin bootstrap [--encrypt]',
  doctor: 'substrate-admin doctor [--url <base> | --direct]',
  onboard: 'substrate-admin onboard [--url <base>] [--check]',
  list: 'substrate-admin list [--url <base>]',
  revoke: 'substrate-admin revoke <kid> [--url <base> | --direct]',
  rotate: 'substrate-admin rotate <kid> --out <path> [--encrypt]',
  register:
    'substrate-admin register <kid> --pubkey <path> --ns <csv> [--name <n>] [--caps <csv>] [--allow-admin]',
  update:
    'substrate-admin update <kid> [--name <n>] [--ns <csv>] [--caps <csv>] [--widen] [--allow-admin]',
  'migrate-store':
    'substrate-admin migrate-store [--from-env <VAR>] [--to-env <VAR>] [--from-schema <s>] [--to-schema <s>] [--dry-run | --verify-only] [--skip-index-build] [--full-checksum] [--batch-rows <n>] [--skip-table <t>]... [--json]'
};

/**
 * An argv-parse failure with the command's usage synopsis attached. Every
 * throw inside a parse*Args function goes through here; run-phase errors keep
 * bare messages because they name the refusing layer instead.
 */
export function argvError(cmd: string, message: string, exitCode = 1): AdminCliError {
  const synopsis = SYNOPSIS[cmd];
  return new AdminCliError(
    synopsis === undefined ? message : `${message}\nusage: ${synopsis}`,
    exitCode
  );
}

/**
 * Printed after every DIRECT-to-postgres credential write. No interceptor
 * fires, so the running server does not see the change until its re-prime
 * interval elapses or it restarts.
 */
export const RESTART_NOTE = [
  'A RUNNING binary will not see this change until its registry re-primes —',
  'restart it (e.g. `sudo systemctl restart substrate-binary`), or set',
  'SUBSTRATE_KEY_REFRESH_INTERVAL_MS so it converges without one.'
].join('\n');
