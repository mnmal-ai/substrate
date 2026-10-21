/**
 * `substrate-admin doctor` — diagnoses an admin deployment through checks that
 * can each answer NO.
 *
 *   1. **Route-only.** Every auth claim is checked through the running server;
 *      a direct postgres read never authenticates, so it cannot test auth.
 *   2. **A SKIP is not an OK.** A check whose precondition failed renders as
 *      `skip` with the reason — never as a pass, and never omitted.
 *   3. **Shared classifiers.** Admin checks use `isActiveAdminKeyRow` and
 *      `capabilitiesFor`, the same predicates the server's guards use, so the
 *      doctor cannot agree with a copy that has drifted from the guard.
 */

import {
  DIAGNOSE_CHECKS,
  type DiagnoseResult,
  type DoctorReport,
  type DoctorStatus,
  diagnose
} from '@mnmal-ai/substrate-client';
import { validateArgv } from '../argv.js';
import type { AdminCliEnv } from '../env.js';
import {
  type AdminTarget,
  describeAdminTarget,
  resolveAdminAuth,
  resolveAdminTarget
} from '../identity.js';
import { argvError } from '../usage.js';

export {
  type DirectoryReconciliation,
  type DoctorCheck,
  type DoctorReport,
  type DoctorStatus,
  reconcileIdentities
} from '@mnmal-ai/substrate-client';

/** The NO a non-route target gets: doctor and onboard both refuse to measure through postgres. */
export const DIRECT_TARGET_REFUSAL = {
  name: 'target',
  status: 'no' as const,
  detail:
    'resolved to the postgres store, bypassing the running server. Nothing below can ' +
    'be measured from there: a direct read never authenticates, so it answers a ' +
    'different question from the one you asked (this is what made `substrate-admin list` ' +
    'misleading — it printed the admin row while admin auth was broken).',
  fix:
    'Pass `--url <base>`, or set SUBSTRATE_URL, so the checks go through the server that ' +
    'is doing the refusing.'
};

/**
 * Runs every check against `target`, in dependency order. A failure
 * short-circuits its dependants into explicit skips.
 */
export async function runDoctor(
  env: AdminCliEnv,
  target: AdminTarget,
  fetchImpl: typeof fetch = fetch
): Promise<DoctorReport> {
  if (target.kind !== 'route') {
    return {
      checks: [
        DIRECT_TARGET_REFUSAL,
        ...DIAGNOSE_CHECKS.map((name) => ({
          name,
          status: 'skip' as const,
          detail: 'not asked — target answered no'
        }))
      ],
      exitCode: 1
    };
  }
  const result = await diagnoseTarget(env, target.baseUrl, fetchImpl);
  return {
    checks: [
      {
        name: 'target',
        status: 'ok',
        detail: describeAdminTarget('doctor', target).replace(/^doctor: /, '')
      },
      ...result.checks
    ],
    exitCode: result.exitCode
  };
}

/** Diagnose `baseUrl` with the admin credential `env` resolves — shared by doctor and onboard. */
export async function diagnoseTarget(
  env: AdminCliEnv,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<DiagnoseResult> {
  const auth = resolveAdminAuth(env, baseUrl);
  return diagnose({
    baseUrl,
    credential:
      'error' in auth
        ? { error: auth.error }
        : { authorization: () => auth.ok, label: describeCredential(env) },
    ...(env.SUBSTRATE_ADMIN_CAPABILITY !== undefined && env.SUBSTRATE_ADMIN_CAPABILITY.length > 0
      ? { adminCapability: env.SUBSTRATE_ADMIN_CAPABILITY }
      : {}),
    // A redirect would carry the token to wherever it points.
    fetch: (input, init) => fetchImpl(input, { ...init, redirect: 'error' })
  });
}

/** Which credential the run used, without printing any of it. */
function describeCredential(env: AdminCliEnv): string {
  if (env.SUBSTRATE_ADMIN_TOKEN !== undefined && env.SUBSTRATE_ADMIN_TOKEN.length > 0) {
    return 'SUBSTRATE_ADMIN_TOKEN';
  }
  const key =
    env.SUBSTRATE_ADMIN_KEY_PATH !== undefined && env.SUBSTRATE_ADMIN_KEY_PATH.length > 0
      ? env.SUBSTRATE_ADMIN_KEY_PATH
      : 'the default admin key path';
  return `${key} (the file path only — no key material is read out here)`;
}

const GLYPH: Record<DoctorStatus, string> = { ok: 'ok  ', no: 'NO  ', skip: 'skip' };

/**
 * Renders the report. The trailer counts skips separately from passes so a
 * reader cannot sum unasked checks into a verdict.
 */
export function formatDoctorReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.name.length));
  const lines: string[] = ['substrate-admin doctor', ''];
  for (const check of report.checks) {
    lines.push(`  ${GLYPH[check.status]}  ${check.name.padEnd(width)}  ${check.detail}`);
    if (check.fix !== undefined) lines.push(`        ${' '.repeat(width)}  fix: ${check.fix}`);
  }
  const ok = report.checks.filter((c) => c.status === 'ok').length;
  const no = report.checks.filter((c) => c.status === 'no').length;
  const skipped = report.checks.filter((c) => c.status === 'skip').length;
  lines.push(
    '',
    skipped > 0
      ? `${ok} ok, ${no} failed, ${skipped} NOT ASKED (a skipped check is not a passing one).`
      : `${ok} ok, ${no} failed.`
  );
  return `${lines.join('\n')}\n`;
}

/** Resolve the target and run — the shape `main` dispatches to. */
export async function doctorCommand(
  argv: readonly string[],
  env: AdminCliEnv,
  fetchImpl: typeof fetch = fetch
): Promise<DoctorReport> {
  // Doctor takes no required arguments, so without this a mistyped flag would
  // silently run against whatever `SUBSTRATE_URL` names.
  validateArgv('doctor', argv);

  // One left-to-right pass; a repeated `--url` is refused rather than
  // silently picking one.
  let url: string | undefined;
  let direct = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok === '--url') {
      if (url !== undefined) {
        throw argvError('doctor', 'doctor: --url specified more than once', 1);
      }
      url = argv[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (tok === '--direct') direct = true;
  }
  const explicitUrl = direct ? '' : (url ?? null);
  return runDoctor(env, resolveAdminTarget(explicitUrl, env), fetchImpl);
}
