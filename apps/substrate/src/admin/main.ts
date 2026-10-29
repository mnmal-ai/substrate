/**
 * Argv -> subcommand dispatch.
 *
 * Every case here is thin on purpose: parse, resolve the target, call the
 * command module, format. The logic lives in `./commands/`, so this file stays
 * readable as the map of what the CLI can do.
 */

import pkg from '../../package.json' with { type: 'json' };
import { ARGV_SPEC, validateArgv } from './argv.js';
import { formatBootstrapOutput, parseBootstrapArgs, runBootstrap } from './commands/bootstrap.js';
import { doctorCommand, formatDoctorReport } from './commands/doctor.js';
import {
  formatListOutput,
  formatRemoteListOutput,
  parseListArgs,
  runList
} from './commands/list.js';
import { migrateStoreCommand } from './commands/migrate-store.js';
import { type OnboardIO, onboardCommand } from './commands/onboard.js';
import {
  formatRegisterOutput,
  parseRegisterArgs,
  runRegister,
  runRegisterViaRoute
} from './commands/register.js';
import { formatRevokeOutput, runRevoke } from './commands/revoke.js';
import { formatRotateOutput, parseRotateArgs, runRotate } from './commands/rotate.js';
import { formatUpdateOutput, parseUpdateArgs, runUpdate } from './commands/update.js';
import { type OpenDatasetFn, openPgDataset } from './dataset.js';
import type { AdminCliEnv } from './env.js';
import { AdminCliError } from './errors.js';
import { describeAdminTarget, resolveAdminTarget } from './identity.js';
import { BootstrapError } from './keys.js';
import {
  REVOKE_EXIT_CODES,
  runKeyListViaRoute,
  runKeyPatchViaRoute,
  UPDATE_EXIT_CODES
} from './route.js';
import { argvError, USAGE } from './usage.js';

/**
 * CLI entry point. Parses `process.argv`, dispatches to the requested
 * sub-command, and writes human-readable output. Returns the exit code so the
 * top-level runner can call `process.exit` once.
 */
export async function main(
  argv: readonly string[],
  env: AdminCliEnv,
  out: (s: string) => void,
  errOut: (s: string) => void,
  openDataset: OpenDatasetFn = openPgDataset,
  prompt: { ask: OnboardIO['ask']; interactive: boolean } = {
    ask: async () => null,
    interactive: false
  }
): Promise<number> {
  const command = argv[0];
  if (command === undefined) {
    errOut(`${USAGE}\n`);
    return 1;
  }
  // The version is asked for to check a binary is new enough, so it answers
  // before argv validation, like usage below.
  if (command === '--version' || command === '-v' || command === 'version') {
    out(`${pkg.version}\n`);
    return 0;
  }
  // Usage is a REQUEST, not an error: stdout and exit 0. A `--help` anywhere
  // in the argv wins over running the command — `doctor` takes no required
  // arguments and would otherwise run a live diagnostic.
  if (command === 'help' || argv.some((a) => a === '--help' || a === '-h')) {
    out(`${USAGE}\n`);
    return 0;
  }

  try {
    // ONE argv contract, checked once, before anything dispatches. `ARGV_SPEC`
    // is also what "known command" means: a subcommand added to the switch
    // below without an entry there is refused here rather than running
    // unvalidated.
    if (ARGV_SPEC[command] === undefined) {
      errOut(`unknown command: ${command}\n${USAGE}\n`);
      return 1;
    }
    // migrate-store validates its own argv, so a refusal echoing a pasted connection string is redacted.
    if (command !== 'migrate-store') validateArgv(command, argv.slice(1));
    switch (command) {
      case 'bootstrap': {
        const parsed = parseBootstrapArgs(argv);
        const result = await runBootstrap(env, parsed.wantsEncrypt);
        out(formatBootstrapOutput(result));
        return 0;
      }
      case 'doctor': {
        // The only subcommand that asks questions instead of making changes,
        // and the only one whose value is in the NOs. Its report is written to
        // stdout even when checks fail — a diagnosis is the output, not an
        // error condition — so the exit code carries the verdict.
        const report = await doctorCommand(argv.slice(1), env);
        out(formatDoctorReport(report));
        return report.exitCode;
      }
      case 'onboard':
        return onboardCommand(argv.slice(1), env, { out, ask: prompt.ask }, prompt.interactive);
      case 'list': {
        const args = parseListArgs(argv.slice(1));
        // Two modes answering two questions. Without --url: what does the local
        // store hold. With --url: what does THAT server say to THIS credential.
        if (args.url !== undefined) {
          const remote = await runKeyListViaRoute(args.url, env);
          out(formatRemoteListOutput(remote, args.url));
          return 0;
        }
        const rows = await runList(env, openDataset);
        out(formatListOutput(rows));
        return 0;
      }
      case 'revoke': {
        const rest = argv.slice(1);
        // ONE left-to-right pass extracts everything; a repeated `--url` is
        // refused, since it decides WHICH SERVER gets the revocation.
        //
        // Unknown flags and a second positional are refused by `validateArgv`
        // above, under `revoke`'s own descriptor, so a bare token here is the
        // kid and nothing else.
        let kid: string | undefined;
        let url: string | undefined;
        let direct = false;
        for (let i = 0; i < rest.length; i++) {
          const tok = rest[i];
          if (tok === undefined) continue;
          if (tok === '--url') {
            if (url !== undefined) {
              throw argvError('revoke', 'revoke: --url specified more than once', 1);
            }
            url = rest[i + 1] ?? '';
            i += 1;
            continue;
          }
          if (tok === '--direct') {
            direct = true;
            continue;
          }
          kid = tok;
        }
        if (kid === undefined || kid.length === 0) {
          errOut(`revoke requires a <kid> positional arg\n${USAGE}\n`);
          return 1;
        }
        // `--direct` is the empty string; saying nothing resolves from
        // SUBSTRATE_URL. Same posture as `register`: the route is the default and
        // going behind the running server's back has to be typed. For revoke
        // that default matters more — a direct write leaves the credential
        // authenticating.
        if (direct && url !== undefined) {
          throw argvError('revoke', 'revoke: --direct and --url are mutually exclusive', 1);
        }
        const explicitUrl = direct ? '' : (url ?? null);
        const target = resolveAdminTarget(explicitUrl, env);
        errOut(`${describeAdminTarget('revoke', target)}\n`);
        if (target.kind === 'route') {
          const payload = await runKeyPatchViaRoute(
            { kid, revoke: true },
            target.baseUrl,
            env,
            REVOKE_EXIT_CODES
          );
          out(
            `Key ${String(payload.kid)} revoked at ${String(payload.revokedAt)} — ` +
              'the running server saw it.\n'
          );
          return 0;
        }
        const result = await runRevoke(kid, env, openDataset);
        out(formatRevokeOutput(result));
        return 0;
      }
      case 'rotate': {
        const parsed = parseRotateArgs(argv);
        const result = await runRotate(
          parsed.kid,
          parsed.outPath,
          env,
          parsed.wantsEncrypt,
          openDataset
        );
        out(formatRotateOutput(result));
        return 0;
      }
      case 'register': {
        const parsed = parseRegisterArgs(argv);
        // `--direct` is `''`; "said nothing" is null. The route is what an
        // operator gets by default, and going behind the running server's back
        // is something they have to type — and WHICH server is stated rather
        // than inferred silently from the environment.
        const target = resolveAdminTarget(parsed.url, env);
        errOut(`${describeAdminTarget('register', target)}\n`);
        const result =
          target.kind === 'route'
            ? await runRegisterViaRoute(parsed, target.baseUrl, env)
            : await runRegister(parsed, env, openDataset);
        out(formatRegisterOutput(result));
        return 0;
      }
      case 'update': {
        const parsed = parseUpdateArgs(argv);
        const target = resolveAdminTarget(parsed.url, env);
        errOut(`${describeAdminTarget('update', target)}\n`);
        if (target.kind === 'route') {
          const payload = await runKeyPatchViaRoute(
            {
              kid: parsed.kid,
              ...(parsed.name !== undefined ? { name: parsed.name } : {}),
              ...(parsed.namespaces !== undefined ? { namespaces: parsed.namespaces } : {}),
              ...(parsed.capabilities !== undefined ? { capabilities: parsed.capabilities } : {}),
              widen: parsed.widen === true,
              allowAdmin: parsed.allowAdmin === true,
              // The ROUTE reads this — `key-patch.ts` refuses a grant naming
              // an unhosted namespace unless `allowUnknownNs` is true.
              allowUnknownNs: parsed.allowUnknownNs
            },
            target.baseUrl,
            env,
            UPDATE_EXIT_CODES
          );
          out(`Key ${String(payload.kid)} updated via the route — the running server saw it.\n`);
          return 0;
        }
        const result = await runUpdate(parsed, env, openDataset);
        out(formatUpdateOutput(result));
        return 0;
      }
      case 'migrate-store':
        return migrateStoreCommand(argv.slice(1), env, out, errOut);
      default:
        errOut(`unknown command: ${command}\n${USAGE}\n`);
        return 1;
    }
  } catch (err) {
    const exitCode =
      err instanceof BootstrapError || err instanceof AdminCliError ? err.exitCode : 1;
    errOut(`${err instanceof Error ? err.message : String(err)}\n`);
    return exitCode;
  }
}
