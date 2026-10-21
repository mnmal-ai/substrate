/**
 * `update` — change a live key's grant in place, leaving the keypair alone.
 *
 * An omitted flag leaves that field unchanged; `--ns` REPLACES rather than
 * merges. Widening authority needs `--widen`, narrowing does not, and the audit
 * event carries before AND after so a grant change is reconstructable from the
 * trail rather than from whoever remembers running it.
 */

import {
  AUDIT_EVENT_TYPE,
  buildAuditRow,
  checkUpdatable,
  decodeList,
  encodeList,
  grantEntryError,
  KEY_TYPE,
  newlyGranted
} from '@mnmal-ai/substrate-compose';
import { validateArgv } from '../argv.js';
import { type OpenDatasetFn, openPgDataset } from '../dataset.js';
import type { AdminCliEnv } from '../env.js';
import { AdminCliError } from '../errors.js';
import { grantLines } from '../grant-display.js';
import { ACTOR_HINT, CLI_ACTOR_KID, forUpdate, listActiveAdminKeys, readKeyById } from '../keys.js';
import { UPDATE_EXIT_CODES } from '../route.js';
import { argvError, RESTART_NOTE } from '../usage.js';

export interface UpdateArgs {
  kid: string;
  /** `undefined` means LEAVE UNCHANGED — never "reset to a default". */
  name: string | undefined;
  namespaces: Array<string> | undefined;
  capabilities: Array<string> | undefined;
  widen: boolean;
  allowAdmin: boolean;
  /** Confirms a grant naming a namespace this deployment does not host. */
  allowUnknownNs: boolean;
  /**
   * Route base URL. `null` means the operator said nothing, so the dispatcher
   * resolves from `SUBSTRATE_URL` and the ROUTE is the default — a direct write
   * never reaches the running registry. `''` is `--direct`.
   */
  url: string | null;
}

export interface AuthoritySnapshot {
  name: string;
  namespaces: string;
  capabilities: string;
}

export interface UpdateResult {
  kid: string;
  before: AuthoritySnapshot;
  after: AuthoritySnapshot;
  /** False when the requested authority already matched — nothing was written. */
  changed: boolean;
}

/**
 * Parse `update <kid> [--ns <csv>] [--caps <csv>] [--name <n>] [--widen]
 * [--allow-admin]`.
 *
 * Unlike `parseRegisterArgs`, an omitted flag means LEAVE UNCHANGED: the
 * defaulting `register` does at parse time (caps → read,mutate, name → kid)
 * is deliberately not repeated, so `update <kid> --name foo` cannot change
 * the grant.
 */
export function parseUpdateArgs(argv: ReadonlyArray<string>): UpdateArgs {
  try {
    return parseUpdateArgsInner(argv);
  } catch (err) {
    if (err instanceof AdminCliError) throw argvError('update', err.message, err.exitCode);
    throw err;
  }
}

function parseUpdateArgsInner(argv: ReadonlyArray<string>): UpdateArgs {
  const rest = argv.slice(1);
  validateArgv('update', rest);
  let kid: string | undefined;
  let name: string | undefined;
  let nsCsv: string | undefined;
  let capsCsv: string | undefined;
  let widen = false;
  let allowAdmin = false;
  let allowUnknownNs = false;
  let url: string | null = null;

  const takeValue = (flag: string, i: number): string => {
    const val = rest[i + 1];
    if (val === undefined || val.length === 0 || val.startsWith('--')) {
      throw new AdminCliError(`update: ${flag} requires a value`, 1);
    }
    return val;
  };

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === undefined) continue;
    if (tok === '--name') {
      if (name !== undefined) {
        throw new AdminCliError('update: --name specified more than once', 1);
      }
      name = takeValue('--name', i);
      i += 1;
    } else if (tok === '--ns') {
      if (nsCsv !== undefined) {
        throw new AdminCliError('update: --ns specified more than once', 1);
      }
      nsCsv = takeValue('--ns', i);
      i += 1;
    } else if (tok === '--caps') {
      if (capsCsv !== undefined) {
        throw new AdminCliError('update: --caps specified more than once', 1);
      }
      capsCsv = takeValue('--caps', i);
      i += 1;
    } else if (tok === '--url') {
      if (url === '') {
        throw new AdminCliError('update: --direct and --url are mutually exclusive', 1);
      }
      if (url !== null) {
        throw new AdminCliError('update: --url specified more than once', 1);
      }
      url = takeValue('--url', i);
      i += 1;
    } else if (tok === '--direct') {
      if (url !== null && url !== '') {
        throw new AdminCliError('update: --direct and --url are mutually exclusive', 1);
      }
      url = '';
    } else if (tok === '--allow-unknown-ns') {
      allowUnknownNs = true;
    } else if (tok === '--widen') {
      if (widen) {
        throw new AdminCliError('update: --widen specified more than once', 1);
      }
      widen = true;
    } else if (tok === '--allow-admin') {
      if (allowAdmin) {
        throw new AdminCliError('update: --allow-admin specified more than once', 1);
      }
      allowAdmin = true;
    } else {
      // Only a bare token reaches here: validateArgv has already refused every
      // unknown flag and any second positional.
      kid = tok;
    }
  }

  if (kid === undefined || kid.length === 0) {
    throw new AdminCliError('update requires a <kid> positional arg', 1);
  }
  const splitCsv = (csv: string): Array<string> =>
    csv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  const namespaces = nsCsv === undefined ? undefined : splitCsv(nsCsv);
  // Same check as `register`, through the same parser. A malformed entry here
  // would otherwise be stored and only misbehave at verification.
  if (namespaces !== undefined) {
    const nsError = grantEntryError(namespaces, ['read', 'mutate']);
    if (nsError !== null) {
      throw new AdminCliError(`update: ${nsError} — e.g. --ns inventory:read,notes:read+mutate`, 1);
    }
  }

  return {
    kid,
    name,
    namespaces,
    capabilities: capsCsv === undefined ? undefined : splitCsv(capsCsv),
    widen,
    allowAdmin,
    allowUnknownNs,
    url
  };
}

/**
 * NOTE on `--allow-unknown-ns`: the unhosted-namespace check is ROUTE-SIDE
 * only, because it needs the engine's federated schema. A `--direct` update
 * can still write a grant naming a namespace nobody hosts.
 */
export async function runUpdate(
  args: UpdateArgs,
  env: AdminCliEnv,
  openDataset: OpenDatasetFn = openPgDataset
): Promise<UpdateResult> {
  if (args.name === undefined && args.namespaces === undefined && args.capabilities === undefined) {
    throw new AdminCliError(
      'update requires at least one of --ns, --caps or --name — there is nothing to change',
      1
    );
  }
  const adminCapability =
    env.SUBSTRATE_ADMIN_CAPABILITY !== undefined && env.SUBSTRATE_ADMIN_CAPABILITY.length > 0
      ? env.SUBSTRATE_ADMIN_CAPABILITY
      : 'admin';

  const { dataset, close } = await openDataset(env);
  try {
    return await dataset.withTransaction(async (tx) => {
      const existing = await readKeyById(tx, args.kid);
      const prevNs = decodeList(existing?.row.namespaces);
      const prevCaps = decodeList(existing?.row.capabilities);
      const prevName = typeof existing?.row.name === 'string' ? existing.row.name : '';

      const nextNs = args.namespaces ?? prevNs;
      const nextCaps = args.capabilities ?? prevCaps;
      const nextName = args.name ?? prevName;

      // Every refusal rule — including the ORDER they are applied in — lives in
      // substrate-compose so the route transport shares them. This caller supplies
      // the facts and translates the verdict into its own exit codes.
      const refusal = checkUpdatable({
        kid: args.kid,
        exists: existing !== null,
        existingRevokedAt: existing?.revokedAt,
        prevNamespaces: prevNs,
        prevCapabilities: prevCaps,
        nextNamespaces: nextNs,
        nextCapabilities: nextCaps,
        activeAdminKids: (await listActiveAdminKeys(tx, adminCapability)).map((a) => a.kid),
        adminCapability,
        widen: args.widen === true,
        allowAdmin: args.allowAdmin === true
      });
      if (refusal !== null) {
        // The shared guard decides; this caller words it. `--widen` and
        // `--allow-admin` are CLI flags the route does not have, so the
        // actionable half of the message belongs here.
        const suffix =
          refusal.code === 'requires_widen'
            ? ' Pass --widen to confirm it is deliberate. Narrowing a grant needs no flag.'
            : refusal.code === 'requires_allow_admin'
              ? ''
              : '';
        const message =
          refusal.code === 'requires_allow_admin'
            ? "update: granting the 'admin' capability requires --allow-admin"
            : `${refusal.message}${suffix}`;
        throw new AdminCliError(message, UPDATE_EXIT_CODES[refusal.code]);
      }

      // Recomputed for the audit row via the same shared helper the verdict
      // used, so what is recorded cannot disagree with what was enforced.
      const nsGranted = newlyGranted(prevNs, nextNs);
      const capsGranted = newlyGranted(prevCaps, nextCaps);

      const before: AuthoritySnapshot = {
        name: prevName,
        namespaces: encodeList(prevNs),
        capabilities: encodeList(prevCaps)
      };
      const after: AuthoritySnapshot = {
        name: nextName,
        namespaces: encodeList(nextNs),
        capabilities: encodeList(nextCaps)
      };
      const changed =
        after.name !== before.name ||
        after.namespaces !== before.namespaces ||
        after.capabilities !== before.capabilities;

      // A no-op writes NOTHING — not the row, not an audit row — so the trail
      // is not padded with non-events.
      if (!changed) {
        return { kid: args.kid, before, after, changed: false };
      }

      const now = new Date();
      await tx.write(
        KEY_TYPE,
        [
          forUpdate({
            // `checkUpdatable` refuses `unknown_kid` when `exists` is false, so
            // null is unreachable; the proof lives across the call and TS
            // cannot follow it. See the matching note in `runRevoke`.
            ...existing!.row,
            name: after.name,
            namespaces: after.namespaces,
            capabilities: after.capabilities
          })
        ],
        ACTOR_HINT
      );
      await tx.write(
        AUDIT_EVENT_TYPE,
        [
          buildAuditRow({
            actorKid: CLI_ACTOR_KID,
            kind: 'key_authority_updated',
            targetKid: args.kid,
            details: {
              before,
              after,
              namespacesGranted: nsGranted,
              capabilitiesGranted: capsGranted,
              widened: nsGranted.length > 0 || capsGranted.length > 0,
              cliSubcommand: 'update'
            },
            now
          })
        ],
        ACTOR_HINT
      );
      return { kid: args.kid, before, after, changed: true };
    });
  } finally {
    await close();
  }
}

export function formatUpdateOutput(result: UpdateResult): string {
  if (!result.changed) {
    return [
      `substrate-admin update: no change — ${result.kid} already carries this authority.`,
      `name:             ${result.before.name}`,
      ...grantLines('grant:            ', result.before.namespaces, result.before.capabilities),
      `  (stored as:     namespaces='${result.before.namespaces}' capabilities='${result.before.capabilities}')`,
      '',
      'Nothing was written and no audit row was emitted.',
      ''
    ].join('\n');
  }
  // before → after on every line, including the unchanged ones, so the full
  // authority is visible at the moment it is set.
  const row = (label: string, b: string, a: string): string =>
    b === a ? `${label}${b === '' ? '(empty)' : b}  (unchanged)` : `${label}${b}  ->  ${a}`;
  // The grant is what MOVED, so it gets before and after in full rather than a
  // per-column diff. A change can leave both columns looking similar while the
  // authority inverts — `--ns notes --caps read` to `--ns notes:read+mutate`
  // moves no column dramatically and hands out write access.
  const beforeGrant = grantLines(
    'grant  before:    ',
    result.before.namespaces,
    result.before.capabilities
  );
  const afterGrant = grantLines(
    '       after:     ',
    result.after.namespaces,
    result.after.capabilities
  );
  return [
    'substrate-admin update complete.',
    `kid:              ${result.kid}`,
    row('name:             ', result.before.name, result.after.name),
    ...beforeGrant,
    ...afterGrant,
    `  (stored as:     namespaces='${result.after.namespaces}' capabilities='${result.after.capabilities}')`,
    '',
    RESTART_NOTE,
    ''
  ].join('\n');
}
