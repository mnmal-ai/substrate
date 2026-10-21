/**
 * `substrate federate <verb>` — dispatcher and argument parsing.
 *
 * Note the prerequisite asymmetry, which the runbook states explicitly:
 * `enroll` runs on the CALLEE and needs SUBSTRATE_DATABASE_URL (it writes the invite row
 * directly); `join` and `check` run on the CALLER and never touch a database.
 */

import type { Capability } from '@mnmal-ai/substrate-compose';
import { AdminCliError } from '../../admin/errors.js';
import { formatCheckOutput, runCheck } from './check.js';
import { parseDuration } from './duration.js';
import { type EnrollArgs, formatEnrollOutput, runEnroll } from './enroll.js';
import { loadEnvFile } from './env-file.js';
import { formatJoinOutput, type JoinArgs, runJoin } from './join.js';
import { JoinTokenError } from './token.js';

/**
 * Mirrors `packages/substrate-compose/src/compose.ts`'s `Capability` union — the
 * only spellings any route's `gate()` call ever recognises. Anything else
 * mints a credential that authenticates but never satisfies a capability
 * check, diagnosable only via `substrate federate check` after the fact.
 */
const KNOWN_CAPABILITIES: ReadonlyArray<Capability> = ['read', 'mutate', 'admin'];

export const FEDERATE_USAGE = [
  'Usage: substrate federate <verb> [args...]',
  '',
  'Verbs:',
  '  enroll --origin <url> --ns <csv> [--caps <csv>] [--ttl 15m] [--allow-admin]',
  '      ON THE CALLEE. Mints a single-use enrollment token. Needs SUBSTRATE_DATABASE_URL.',
  '      --caps admin requires --allow-admin — the credential leaves this machine.',
  '',
  '  join [--name <n>] [--key-out <path>]',
  '      ON THE CALLER. Redeems the token in SUBSTRATE_JOIN_TOKEN and prints the config to paste.',
  '      A <token> positional still works but is visible in ps and shell history.',
  '',
  '  check [<name>] [--env-file <path>]',
  '      ON THE CALLER. Diagnoses a configured bridge end to end.',
  '',
  '  TLS is always verified. For a private CA, set NODE_EXTRA_CA_CERTS.'
].join('\n');

function splitCsv(csv: string): Array<string> {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Shared single-value flag reader — rejects a missing value or a following flag. */
function takeValue(rest: ReadonlyArray<string>, index: number, verb: string, flag: string): string {
  const value = rest[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    throw new AdminCliError(`${verb}: ${flag} requires a value`, 1);
  }
  return value;
}

export function parseEnrollArgs(argv: ReadonlyArray<string>): EnrollArgs {
  const rest = argv.slice(1);
  let origin: string | undefined;
  let nsCsv: string | undefined;
  let capsCsv: string | undefined;
  let ttlRaw: string | undefined;
  let allowAdmin = false;

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === undefined) continue;
    if (tok === '--origin') {
      if (origin !== undefined)
        throw new AdminCliError('enroll: --origin specified more than once', 1);
      origin = takeValue(rest, i, 'enroll', '--origin');
      i += 1;
    } else if (tok === '--ns') {
      if (nsCsv !== undefined) throw new AdminCliError('enroll: --ns specified more than once', 1);
      nsCsv = takeValue(rest, i, 'enroll', '--ns');
      i += 1;
    } else if (tok === '--caps') {
      if (capsCsv !== undefined)
        throw new AdminCliError('enroll: --caps specified more than once', 1);
      capsCsv = takeValue(rest, i, 'enroll', '--caps');
      i += 1;
    } else if (tok === '--ttl') {
      if (ttlRaw !== undefined)
        throw new AdminCliError('enroll: --ttl specified more than once', 1);
      ttlRaw = takeValue(rest, i, 'enroll', '--ttl');
      i += 1;
    } else if (tok === '--allow-admin') {
      if (allowAdmin) throw new AdminCliError('enroll: --allow-admin specified more than once', 1);
      allowAdmin = true;
    } else if (tok.startsWith('--')) {
      throw new AdminCliError(`enroll: unknown flag ${tok}`, 1);
    } else {
      throw new AdminCliError(`enroll: unexpected positional arg '${tok}'`, 1);
    }
  }

  if (origin === undefined) {
    throw new AdminCliError('enroll requires --origin <url> (the callee base URL)', 1);
  }
  let normalisedOrigin: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AdminCliError(`enroll: --origin '${origin}' must be http(s)`, 1);
    }
    normalisedOrigin = url.origin;
  } catch (err) {
    if (err instanceof AdminCliError) throw err;
    throw new AdminCliError(`enroll: --origin '${origin}' is not a valid URL`, 1);
  }

  if (nsCsv === undefined) {
    throw new AdminCliError(
      'enroll requires --ns <csv> naming the namespaces this peer may query',
      1
    );
  }
  const namespaces = splitCsv(nsCsv);
  if (namespaces.length === 0) {
    throw new AdminCliError('enroll: --ns must name at least one namespace', 1);
  }
  if (namespaces.includes('*')) {
    throw new AdminCliError(
      "enroll: --ns does not accept the wildcard '*' — name the namespaces explicitly. " +
        'A wildcard grant cannot produce a usable SUBSTRATE_BRIDGES entry, because there is no ' +
        'local alias for `*`, and a federation credential should never get wildcard access ' +
        'by default.',
      1
    );
  }

  const capabilities = capsCsv === undefined ? ['read'] : splitCsv(capsCsv);
  if (capabilities.length === 0) {
    throw new AdminCliError('enroll: --caps must name at least one capability', 1);
  }
  const unknownCaps = capabilities.filter((c) => !KNOWN_CAPABILITIES.includes(c as Capability));
  if (unknownCaps.length > 0) {
    throw new AdminCliError(
      `enroll: unknown --caps value '${unknownCaps.join("', '")}' — valid values are ` +
        `${KNOWN_CAPABILITIES.join(', ')}. A misspelled capability mints a credential that ` +
        'authenticates but satisfies no capability check — diagnosable only after the fact via ' +
        '`substrate federate check`.',
      1
    );
  }
  // Mirrors `substrate-admin register`'s `--allow-admin` guardrail — the same
  // posture on a path where the credential leaves this machine. `enroll` running at
  // all already implies SUBSTRATE_DATABASE_URL access, so this is not a privilege escalation; it is
  // a deliberateness check, same as the sibling CLI's.
  if (capabilities.includes('admin') && !allowAdmin) {
    throw new AdminCliError(
      'enroll: --caps admin requires --allow-admin — this credential is redeemable remotely ' +
        'by whoever holds the token, so minting an admin-scoped one needs to be deliberate, not ' +
        'a `--caps` typo away from `mutate`.',
      1
    );
  }

  let ttlMs: number;
  try {
    ttlMs = parseDuration(ttlRaw ?? '15m');
  } catch (err) {
    throw new AdminCliError(`enroll: ${err instanceof Error ? err.message : String(err)}`, 1);
  }

  return { origin: normalisedOrigin, namespaces, capabilities, ttlMs };
}

/**
 * The token comes from `SUBSTRATE_JOIN_TOKEN`, or from a positional, which the
 * caller warns about: argv is readable by every user on the box via `ps`.
 */
export function parseJoinArgs(
  argv: ReadonlyArray<string>,
  env: { SUBSTRATE_JOIN_TOKEN?: string } = {}
): JoinArgs {
  const rest = argv.slice(1);
  let token: string | undefined;
  let name: string | undefined;
  let keyOut: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === undefined) continue;
    if (tok === '--name') {
      if (name !== undefined) throw new AdminCliError('join: --name specified more than once', 1);
      name = takeValue(rest, i, 'join', '--name');
      i += 1;
    } else if (tok === '--key-out') {
      if (keyOut !== undefined)
        throw new AdminCliError('join: --key-out specified more than once', 1);
      keyOut = takeValue(rest, i, 'join', '--key-out');
      i += 1;
    } else if (tok.startsWith('--')) {
      throw new AdminCliError(`join: unknown flag ${tok}`, 1);
    } else {
      if (token !== undefined) {
        throw new AdminCliError(`join: unexpected positional arg '${tok}'`, 1);
      }
      token = tok;
    }
  }

  const envToken = env.SUBSTRATE_JOIN_TOKEN;
  if (envToken !== undefined && envToken.length > 0) {
    if (token !== undefined) {
      throw new AdminCliError('join: token given both in SUBSTRATE_JOIN_TOKEN and on argv', 1);
    }
    token = envToken;
  }
  if (token === undefined || token.length === 0) {
    throw new AdminCliError('join requires a token: set SUBSTRATE_JOIN_TOKEN', 1);
  }
  return { token, name, keyOut };
}

export interface CheckArgs {
  name: string | undefined;
  envFile: string | undefined;
}

export function parseCheckArgs(argv: ReadonlyArray<string>): CheckArgs {
  const rest = argv.slice(1);
  let name: string | undefined;
  let envFile: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === undefined) continue;
    if (tok === '--env-file') {
      if (envFile !== undefined)
        throw new AdminCliError('check: --env-file specified more than once', 1);
      envFile = takeValue(rest, i, 'check', '--env-file');
      i += 1;
    } else if (tok.startsWith('--')) {
      throw new AdminCliError(`check: unknown flag ${tok}`, 1);
    } else {
      if (name !== undefined) {
        throw new AdminCliError(`check: unexpected positional arg '${tok}'`, 1);
      }
      name = tok;
    }
  }
  return { name, envFile };
}

export async function runFederate(
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  out: (s: string) => void,
  errOut: (s: string) => void
): Promise<number> {
  const verb = argv[0];
  if (verb === undefined || verb === '--help' || verb === '-h') {
    const write = verb === undefined ? errOut : out;
    write(`${FEDERATE_USAGE}\n`);
    return verb === undefined ? 1 : 0;
  }

  try {
    switch (verb) {
      case 'enroll': {
        const args = parseEnrollArgs(argv);
        const result = await runEnroll(args, env);
        out(formatEnrollOutput(result));
        return 0;
      }
      case 'join': {
        const args = parseJoinArgs(argv, env);
        if (env.SUBSTRATE_JOIN_TOKEN === undefined || env.SUBSTRATE_JOIN_TOKEN.length === 0) {
          errOut(
            'warning: a token on the command line is visible in ps and shell history; pass it in SUBSTRATE_JOIN_TOKEN instead\n'
          );
        }
        const result = await runJoin(args);
        out(formatJoinOutput(result));
        return 0;
      }
      case 'check': {
        const args = parseCheckArgs(argv);
        const effectiveEnv =
          args.envFile === undefined ? env : { ...env, ...loadEnvFile(args.envFile) };
        const results = await runCheck(args.name, effectiveEnv);
        out(formatCheckOutput(results));
        return results.every((r) => r.ok) ? 0 : 1;
      }
      default:
        errOut(`substrate federate: unknown verb '${verb}'\n\n${FEDERATE_USAGE}\n`);
        return 1;
    }
  } catch (err) {
    const exitCode =
      err instanceof AdminCliError || err instanceof JoinTokenError ? err.exitCode : 1;
    errOut(`${err instanceof Error ? err.message : String(err)}\n`);
    return exitCode;
  }
}
