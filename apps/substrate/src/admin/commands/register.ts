/**
 * `register` — add an existing ed25519 public key as an agent Key.
 *
 * `--ns` is REQUIRED and has no default, because a default here is an unbounded
 * grant nobody chose. The route path also writes the directory row in the same
 * transaction: a credential with no directory row keeps authenticating while
 * mail routing and agent listing quietly break.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  AUDIT_EVENT_TYPE,
  buildAuditRow,
  encodeList,
  grantEntriesConfer,
  grantEntryError,
  KEY_TYPE
} from '@mnmal-ai/substrate-compose';
import { trimTrailingSlashes } from '@mnmal-ai/substrate-types';
import { validateArgv } from '../argv.js';
import { type OpenDatasetFn, openPgDataset } from '../dataset.js';
import type { AdminCliEnv } from '../env.js';
import { AdminCliError } from '../errors.js';
import { grantLines } from '../grant-display.js';
import { resolveAdminAuth } from '../identity.js';
import { ACTOR_HINT, base64Url, CLI_ACTOR_KID, readEd25519PublicKey } from '../keys.js';
import { argvError } from '../usage.js';

export interface RegisterArgs {
  kid: string;
  pubkeyPath: string;
  name: string;
  namespaces: Array<string>;
  capabilities: Array<string>;
  allowAdmin: boolean;
  /** Confirms a grant naming a namespace this deployment does not host. */
  allowUnknownNs: boolean;
  /**
   * Base URL of a running Substrate. Present → drive the admin-gated
   * `POST /substrate/v1/_system/keys` route; `''` → the direct-to-postgres write,
   * kept as break-glass for a stack that will not boot; `null` → resolved from
   * `SUBSTRATE_URL` by the dispatcher.
   */
  url: string | null;
  /** `--no-directory` — register the credential with no directory row. */
  noDirectory: boolean;
  /** `--no-broadcast` — directory row with `broadcastEligible: false`. */
  noBroadcast: boolean;
  /** `--project <p>` — directory row's project scope. */
  project: string | null;
}

/**
 * Parse `register <kid> --pubkey <path> --ns <csv> [--name <n>] [--caps <csv>]
 * [--allow-admin]`. Positional <kid> exactly once, single-valued flags.
 * Defaults (kid as name, caps read,mutate) are resolved here; `--ns` has no
 * default and its absence throws `AdminCliError`.
 */
export function parseRegisterArgs(argv: ReadonlyArray<string>): RegisterArgs {
  try {
    return parseRegisterArgsInner(argv);
  } catch (err) {
    if (err instanceof AdminCliError) throw argvError('register', err.message, err.exitCode);
    throw err;
  }
}

function parseRegisterArgsInner(argv: ReadonlyArray<string>): RegisterArgs {
  const rest = argv.slice(1);
  validateArgv('register', rest);
  let kid: string | undefined;
  let pubkeyPath: string | undefined;
  let name: string | undefined;
  let nsCsv: string | undefined;
  let capsCsv: string | undefined;
  let allowAdmin = false;
  let allowUnknownNs = false;
  let url: string | undefined;
  let direct = false;
  let noDirectory = false;
  let noBroadcast = false;
  let project: string | undefined;

  const takeValue = (flag: string, i: number): string => {
    const val = rest[i + 1];
    if (val === undefined || val.length === 0 || val.startsWith('--')) {
      throw new AdminCliError(`register: ${flag} requires a value`, 1);
    }
    return val;
  };

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === undefined) continue;
    if (tok === '--pubkey') {
      if (pubkeyPath !== undefined) {
        throw new AdminCliError('register: --pubkey specified more than once', 1);
      }
      pubkeyPath = takeValue('--pubkey', i);
      i += 1;
    } else if (tok === '--name') {
      if (name !== undefined) {
        throw new AdminCliError('register: --name specified more than once', 1);
      }
      name = takeValue('--name', i);
      i += 1;
    } else if (tok === '--ns') {
      if (nsCsv !== undefined) {
        throw new AdminCliError('register: --ns specified more than once', 1);
      }
      nsCsv = takeValue('--ns', i);
      i += 1;
    } else if (tok === '--caps') {
      if (capsCsv !== undefined) {
        throw new AdminCliError('register: --caps specified more than once', 1);
      }
      capsCsv = takeValue('--caps', i);
      i += 1;
    } else if (tok === '--allow-admin') {
      if (allowAdmin) {
        throw new AdminCliError('register: --allow-admin specified more than once', 1);
      }
      allowAdmin = true;
    } else if (tok === '--allow-unknown-ns') {
      allowUnknownNs = true;
    } else if (tok === '--url') {
      if (direct) {
        throw new AdminCliError('register: --direct and --url are mutually exclusive', 1);
      }
      if (url !== undefined) {
        throw new AdminCliError('register: --url specified more than once', 1);
      }
      url = takeValue('--url', i);
      i += 1;
    } else if (tok === '--direct') {
      // Explicit opt-in to the legacy direct-to-postgres write. Spelled out
      // rather than inferred so "I am going behind the running server's back"
      // is a thing the operator typed, not a thing an unset variable chose.
      if (url !== undefined) {
        throw new AdminCliError('register: --direct and --url are mutually exclusive', 1);
      }
      direct = true;
      url = '';
    } else if (tok === '--no-directory') {
      noDirectory = true;
    } else if (tok === '--no-broadcast') {
      noBroadcast = true;
    } else if (tok === '--project') {
      if (project !== undefined) {
        throw new AdminCliError('register: --project specified more than once', 1);
      }
      project = takeValue('--project', i);
      i += 1;
    } else {
      // Only a bare token reaches here: validateArgv has already refused every
      // unknown flag and any second positional.
      kid = tok;
    }
  }

  if (kid === undefined || kid.length === 0) {
    throw new AdminCliError('register requires a <kid> positional arg', 1);
  }
  if (pubkeyPath === undefined || pubkeyPath.length === 0) {
    throw new AdminCliError('register requires --pubkey <path>', 1);
  }
  const splitCsv = (csv: string): Array<string> =>
    csv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  // Omission must not produce a grant: a default namespace set is authority
  // nobody chose. `--ns '*'` remains available when chosen explicitly.
  if (nsCsv === undefined) {
    throw new AdminCliError(
      'register requires --ns <csv> — namespaces are granted explicitly, never by default. ' +
        "Pass the namespaces this identity needs (e.g. --ns notes,recall), or --ns '*' " +
        'to deliberately grant every namespace.',
      1
    );
  }
  const namespaces = splitCsv(nsCsv);
  if (namespaces.length === 0) {
    throw new AdminCliError(
      `register: --ns '${nsCsv}' resolves to an empty namespace list — an identity that can ` +
        "reach nothing is almost certainly a mistake. Pass real namespaces, or --ns '*'.",
      1
    );
  }
  // An entry may carry per-namespace capabilities as `<ns>:<cap>[+<cap>]`.
  // Validated by calling the parser that will read it back, so a typo fails
  // here rather than surviving into a stored grant.
  const nsError = grantEntryError(namespaces, ['read', 'mutate']);
  if (nsError !== null) {
    throw new AdminCliError(`register: ${nsError} — e.g. --ns inventory:read,notes:read+mutate`, 1);
  }
  // `--caps` keeps a default deliberately: `read,mutate` is bounded, and
  // `admin` already requires --allow-admin.
  const capabilities = capsCsv === undefined ? ['read', 'mutate'] : splitCsv(capsCsv);

  return {
    kid,
    pubkeyPath,
    name: name ?? kid,
    namespaces,
    capabilities,
    allowAdmin,
    allowUnknownNs,
    url: url ?? null,
    noDirectory,
    noBroadcast,
    project: project ?? null
  };
}

export interface RegisterResult {
  kid: string;
  name: string;
  fingerprint: string;
  namespaces: string;
  capabilities: string;
  replacedRevoked: boolean;
  /** Which transport actually wrote the row — reported, never inferred. */
  via: 'route' | 'direct';
  /**
   * Whether a directory row landed. `false` from the direct path is not a
   * failure of that path so much as its defining limitation: a pg client has
   * no route to a plugin namespace, so it can only ever write the credential.
   */
  directoryCreated: boolean;
  /** Frame key when created; the server's reason when not. */
  directoryDetail: string;
}

/**
 * Register an existing Ed25519 public key as an agent Key row directly
 * in postgres, with one `key_registered` audit row written in the SAME tx.
 *
 * Unlike `bootstrap`/`rotate`, the kid is operator-chosen. The row id is a
 * freshly-minted UUID; the kid is the principal field stored separately. A
 * previously-revoked same-kid row is re-registered (same UUID id, clears
 * revokedAt). A LIVE same-kid row is refused — rotate/revoke is the path.
 */
export async function runRegister(
  args: RegisterArgs,
  env: AdminCliEnv,
  openDataset: OpenDatasetFn = openPgDataset
): Promise<RegisterResult> {
  if (grantEntriesConfer(args.namespaces, args.capabilities, 'admin') && !args.allowAdmin) {
    throw new AdminCliError(
      "register: 'admin' capability requires --allow-admin (bootstrap is the deliberate admin path)",
      1
    );
  }
  // Validate + read the pubkey BEFORE opening the dataset so a bad file bails
  // without a pg round-trip.
  const publicKeyPem = readEd25519PublicKey(args.pubkeyPath);
  const shaFull = createHash('sha256').update(publicKeyPem).digest();
  const fingerprint = `sha256:${base64Url(shaFull).slice(0, 8)}`;
  const namespaces = encodeList(args.namespaces);
  const capabilities = encodeList(args.capabilities);

  const { dataset, close } = await openDataset(env);
  try {
    const replacedRevoked = await dataset.withTransaction(async (tx) => {
      // A rotated principal also has revoked rows, in no particular order: prefer the live one.
      const { rows: existingRows } = await tx.read(KEY_TYPE, { where: { kid: { eq: args.kid } } });
      const existing = existingRows.find((r) => r.revokedAt == null) ?? existingRows[0];
      let wasRevoked = false;
      let rowId: string = randomUUID();
      if (existing !== undefined) {
        const existingRevokedAt =
          existing.revokedAt instanceof Date
            ? existing.revokedAt
            : typeof existing.revokedAt === 'string'
              ? existing.revokedAt
              : null;
        if (existingRevokedAt == null) {
          throw new AdminCliError(
            `kid '${args.kid}' is already registered and live — rotate or revoke it instead`,
            3
          );
        }
        wasRevoked = true;
        rowId = existing.id as string; // re-register over the revoked row (same id, clears revokedAt)
      }
      const now = new Date();
      await tx.write(
        KEY_TYPE,
        [
          {
            id: rowId,
            kid: args.kid,
            name: args.name,
            algorithm: 'EdDSA',
            publicKey: publicKeyPem,
            namespaces,
            capabilities,
            revokedAt: null
          }
        ],
        ACTOR_HINT
      );
      await tx.write(
        AUDIT_EVENT_TYPE,
        [
          buildAuditRow({
            actorKid: CLI_ACTOR_KID,
            kind: 'key_registered',
            targetKid: args.kid,
            details: {
              kid: args.kid,
              name: args.name,
              namespaces,
              capabilities,
              fingerprint,
              replacedRevoked: wasRevoked
            },
            now
          })
        ],
        ACTOR_HINT
      );
      return wasRevoked;
    });

    return {
      kid: args.kid,
      name: args.name,
      fingerprint,
      namespaces,
      capabilities,
      replacedRevoked,
      via: 'direct',
      directoryCreated: false,
      directoryDetail: 'direct-to-postgres cannot reach a plugin namespace'
    };
  } finally {
    await close();
  }
}

/**
 * Register a key through the admin-gated `POST /substrate/v1/_system/keys` route,
 * which needs an `admin` identity rather than postgres write access, and
 * writes the directory row in the same transaction. Throws `AdminCliError`
 * on a non-2xx response.
 */
export async function runRegisterViaRoute(
  args: RegisterArgs,
  baseUrl: string,
  env: AdminCliEnv,
  fetchImpl: typeof fetch = fetch
): Promise<RegisterResult> {
  if (grantEntriesConfer(args.namespaces, args.capabilities, 'admin') && !args.allowAdmin) {
    throw new AdminCliError(
      "register: 'admin' capability requires --allow-admin (bootstrap is the deliberate admin path)",
      1
    );
  }
  const publicKeyPem = readEd25519PublicKey(args.pubkeyPath);
  const fingerprint = `sha256:${base64Url(createHash('sha256').update(publicKeyPem).digest()).slice(0, 8)}`;

  const auth = resolveAdminAuth(env, baseUrl);
  if ('error' in auth) throw new AdminCliError(`register: ${auth.error}`, 1);

  const directoryParams: Record<string, unknown> = {};
  if (args.noBroadcast) directoryParams.broadcastEligible = false;
  if (args.project !== null) directoryParams.project = args.project;

  const body = {
    kid: args.kid,
    publicKey: publicKeyPem,
    name: args.name,
    algorithm: 'EdDSA',
    namespaces: args.namespaces,
    capabilities: args.capabilities,
    allowAdmin: args.allowAdmin,
    allowUnknownNs: args.allowUnknownNs,
    directory: {
      create: !args.noDirectory,
      ...(Object.keys(directoryParams).length > 0 ? { params: directoryParams } : {})
    }
  };

  const url = `${trimTrailingSlashes(baseUrl)}/substrate/v1/_system/keys`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth.ok },
      body: JSON.stringify(body),
      // A redirect would carry the token to wherever it points.
      redirect: 'error'
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AdminCliError(
      `register: could not reach ${url}: ${msg}. Pass --direct to write to postgres instead (break-glass; leaves no directory row).`,
      2
    );
  }

  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON body — surfaced verbatim below */
  }

  if (!res.ok) {
    const code = typeof parsed?.code === 'string' ? parsed.code : `http_${res.status}`;
    const message = typeof parsed?.message === 'string' ? parsed.message : text.slice(0, 500);
    // 404 means a binary predating the route. Say so, rather than letting the
    // generic failure read as "the server rejected this registration".
    if (res.status === 404) {
      throw new AdminCliError(
        `register: ${url} returned 404 — this server predates the keys route. Upgrade it, or pass --direct.`,
        2
      );
    }
    throw new AdminCliError(`register: ${code}: ${message}`, 3);
  }

  const dir = (parsed?.directory ?? {}) as Record<string, unknown>;
  return {
    kid: typeof parsed?.kid === 'string' ? parsed.kid : args.kid,
    name: args.name,
    fingerprint:
      typeof parsed?.fingerprint === 'string' ? (parsed.fingerprint as string) : fingerprint,
    namespaces: encodeList(args.namespaces),
    capabilities: encodeList(args.capabilities),
    replacedRevoked: parsed?.replacedRevoked === true,
    via: 'route',
    directoryCreated: dir.created === true,
    directoryDetail:
      dir.created === true
        ? typeof dir.frame === 'string'
          ? (dir.frame as string)
          : 'created'
        : typeof dir.reason === 'string'
          ? (dir.reason as string)
          : 'not created'
  };
}

export function formatRegisterOutput(
  result: RegisterResult,
  opts: { readonly adminRoot?: boolean } = {}
): string {
  const lines = [
    'substrate-admin register complete.',
    `kid:              ${result.kid}`,
    `name:             ${result.name}`,
    `fingerprint:      ${result.fingerprint}`,
    // The AUTHORITY leads; the columns follow, labelled as storage. Printing
    // `capabilities:` beside a per-namespace `namespaces:` reads as though the
    // flat list applied to every entry, and it does not — it is the default for
    // BARE entries only.
    ...grantLines('grant:            ', result.namespaces, result.capabilities),
    `  (stored as:     namespaces='${result.namespaces}' capabilities='${result.capabilities}')`,
    `transport:        ${result.via === 'route' ? 'POST /substrate/v1/_system/keys' : 'direct-to-postgres (--direct)'}`,
    `directory row:    ${result.directoryCreated ? `created in ${result.directoryDetail}` : `NOT created — ${result.directoryDetail}`}`
  ];
  if (result.replacedRevoked) {
    lines.push('re-registered over a previously-revoked kid.');
  }
  lines.push('');
  if (result.via === 'route') {
    // Describe the mechanism; do NOT assert the outcome. `register` holds only
    // a public key, so it cannot mint a probe token to verify the key works.
    lines.push(
      'This build refreshes the key registry post-commit, so no restart should be needed.'
    );
    lines.push(
      "Verify before relying on it: mint a token with this kid's private key and call /substrate/v1/whoami."
    );
  } else {
    lines.push(
      'A RUNNING binary will not see this key until its registry re-primes —',
      'restart it (e.g. `sudo systemctl restart substrate-binary`) for the key to verify.'
    );
  }
  if (!result.directoryCreated && opts.adminRoot === true) {
    lines.push(
      '',
      'No directory row, by design: admin roots are exempt by capability, like the bootstrap key.'
    );
  } else if (!result.directoryCreated) {
    // The half-identity warning. Auth still works without a directory row, so
    // nothing the operator does next will surface this.
    lines.push(
      '',
      'WARNING: this identity has a credential but NO directory row. It will',
      'authenticate normally and be invisible to fleet listing and mail routing.',
      result.via === 'direct'
        ? 'Re-run without --direct (or with --url) to write both rows in one transaction.'
        : result.directoryDetail === 'not_configured'
          ? // NOT a defect and NOT actionable: this deployment declares no
            // identity directory, so there is nowhere to put the row. Normal
            // for a per-self substrate with no mailbox.
            'This deployment has no identity directory configured, so there is nowhere' +
            ' to write one. Expected for a substrate with no mailbox; alarming for a' +
            ' fleet member. Configure SUBSTRATE_AGENT_DIRECTORY_TYPE if it should have one.'
          : 'Create the directory row by hand, or re-run without --no-directory.'
    );
  }
  lines.push('');
  return lines.join('\n');
}
