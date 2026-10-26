/**
 * The library behind `substrate-admin doctor` and substrate-tui's `/doctor` — diagnoses
 * a deployment, and the identity presented to it, through checks that can each
 * answer NO.
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
  capabilitiesFor,
  type Grant,
  isActiveAdminKeyRow,
  SYSTEM_NAMESPACE
} from '@mnmal-ai/substrate-policy';
import type { Row } from '@mnmal-ai/substrate-types';
import { trimTrailingSlashes } from '@mnmal-ai/substrate-types';

/**
 * `ok` — asked and answered yes. `no` — asked and answered no. `skip` — NOT
 * ASKED, because a precondition failed.
 */
export type DoctorStatus = 'ok' | 'no' | 'skip';

export interface DoctorCheck {
  /** Stable short label, safe to grep for in a support thread. */
  readonly name: string;
  readonly status: DoctorStatus;
  /** What was measured, in the terms the operator typed. */
  readonly detail: string;
  /** Present on `no` — the next command, not a restatement of the failure. */
  readonly fix?: string;
  /** The HTTP status that decided this verdict, when a response decided it. Match on this,
   *  never on `detail`, which is prose for an operator and free to change. */
  readonly httpStatus?: number;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  /** 0 when nothing answered `no`. Skips do not fail the run; they are visible. */
  readonly exitCode: number;
}

const CHECK_REACHABLE = 'reachable';
const CHECK_AUTH_ENABLED = 'auth-enabled';
const CHECK_CREDENTIAL = 'credential';
const CHECK_IDENTITY = 'identity';
const CHECK_ADMIN = 'admin-capability';
const CHECK_FLOOR = 'admin-floor';
const CHECK_NAMESPACES = 'namespaces';
const CHECK_DIR = 'key-directory';
const CHECK_STORAGE = 'storage';

/** Every check downstream of a failure, so a skip is never silent. */
const DOWNSTREAM: Record<string, readonly string[]> = {
  [CHECK_REACHABLE]: [
    CHECK_AUTH_ENABLED,
    CHECK_CREDENTIAL,
    CHECK_IDENTITY,
    CHECK_ADMIN,
    CHECK_FLOOR,
    CHECK_NAMESPACES,
    CHECK_DIR,
    CHECK_STORAGE
  ],
  [CHECK_CREDENTIAL]: [
    CHECK_IDENTITY,
    CHECK_ADMIN,
    CHECK_FLOOR,
    CHECK_NAMESPACES,
    CHECK_DIR,
    CHECK_STORAGE
  ],
  [CHECK_IDENTITY]: [CHECK_ADMIN, CHECK_FLOOR, CHECK_DIR, CHECK_STORAGE],
  [CHECK_ADMIN]: [CHECK_FLOOR, CHECK_DIR, CHECK_STORAGE],
  [CHECK_FLOOR]: [CHECK_DIR]
};

class Checks {
  private readonly rows: DoctorCheck[] = [];

  ok(name: string, detail: string): void {
    this.rows.push({ name, status: 'ok', detail });
  }

  /** Asked and unanswerable — recorded explicitly so absence never reads as health. */
  skip(name: string, detail: string): void {
    this.rows.push({ name, status: 'skip', detail });
  }

  /** Record a failure AND every check it makes unanswerable. */
  no(name: string, detail: string, fix: string, httpStatus?: number): void {
    this.rows.push({
      name,
      status: 'no',
      detail,
      fix,
      ...(httpStatus !== undefined ? { httpStatus } : {})
    });
    for (const dep of DOWNSTREAM[name] ?? []) {
      this.rows.push({ name: dep, status: 'skip', detail: `not asked — ${name} answered no` });
    }
  }

  has(name: string): boolean {
    return this.rows.some((c) => c.name === name);
  }

  done(): DoctorReport {
    return { checks: this.rows, exitCode: this.rows.some((c) => c.status === 'no') ? 1 : 0 };
  }
}

/** The `grants` block `GET /substrate/v1/whoami` returns, resolved back into a Grant. */
function grantFromWhoami(grants: unknown): Grant | null {
  if (grants === null || typeof grants !== 'object' || Array.isArray(grants)) return null;
  const out = new Map<string, ReadonlySet<string>>();
  for (const [ns, caps] of Object.entries(grants as Record<string, unknown>)) {
    if (!Array.isArray(caps)) return null;
    out.set(ns, new Set(caps.filter((c): c is string => typeof c === 'string')));
  }
  return out;
}

async function getJson(
  url: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> } | { error: string }> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

/**
 * Pages every live (non-revoked) Key row. Paged to completion because an
 * admin floor computed off one page is wrong.
 *
 * Rows are returned raw — callers classify with `isActiveAdminKeyRow`, not by
 * reading `capabilities`: a key stored `namespaces: '*:read+mutate+admin'`
 * carries no `admin` in `capabilities` and is nonetheless an admin.
 */
async function listLiveKeys(
  baseUrl: string,
  authorization: string,
  fetchImpl: typeof fetch
): Promise<{ rows: Row[] } | { error: string }> {
  const frameKey = `${SYSTEM_NAMESPACE}/Key`;
  const rows: Row[] = [];
  let cursor: string | null = null;
  for (;;) {
    const params: Record<string, unknown> = {
      where: { revokedAt: { eq: null } },
      limit: 200,
      ...(cursor !== null ? { cursor } : {})
    };
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/substrate/v1/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization },
        body: JSON.stringify({
          [frameKey]: {
            params,
            fields: { kid: true, namespaces: true, capabilities: true, revokedAt: true }
          }
        })
      });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const data = payload.data as Record<string, unknown> | undefined;
    // Presence, not emptiness: a rejected frame comes back with its key absent,
    // and reading that as an empty store would report a false lockout.
    if (data === undefined || !(frameKey in data)) {
      const errors = JSON.stringify(payload.errors ?? payload);
      return { error: `HTTP ${res.status}, frame absent: ${errors}` };
    }
    const page = data[frameKey];
    if (!Array.isArray(page)) return { error: `unexpected shape for ${frameKey}` };
    rows.push(...(page as Row[]));
    const pagination = (
      payload._pagination as Record<string, { hasMore?: boolean; nextCursor?: string }>
    )?.[frameKey];
    if (pagination?.hasMore !== true) break;
    // A partial table read as complete is the defect this guards: it would
    // miscount the admin floor or the directory rather than fail.
    if (typeof pagination.nextCursor !== 'string') {
      return { error: `${frameKey}: server reported hasMore with no nextCursor` };
    }
    cursor = pagination.nextCursor;
  }
  return { rows };
}

/**
 * Page the AgentIdentity directory. Returns `{ absent }` — NOT an empty list —
 * when the frame never came back: this credential may simply lack read on
 * `cortext` (an `_system`-scoped admin does), and an empty directory reads as
 * "every live key is orphaned", which is the opposite of what was measured.
 */
async function listDirectoryIdentities(
  baseUrl: string,
  authorization: string,
  fetchImpl: typeof fetch
): Promise<{ rows: Row[] } | { absent: string } | { error: string }> {
  const frameKey = 'cortext/AgentIdentity';
  const rows: Row[] = [];
  let cursor: string | null = null;
  for (;;) {
    const params: Record<string, unknown> = {
      limit: 200,
      ...(cursor !== null ? { cursor } : {})
    };
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/substrate/v1/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization },
        body: JSON.stringify({
          [frameKey]: { params, fields: { kid: true, host: true, active: true } }
        })
      });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const data = payload.data as Record<string, unknown> | undefined;
    if (data === undefined || !(frameKey in data)) {
      const errors = JSON.stringify(payload.errors ?? payload);
      return { absent: `HTTP ${res.status}, frame absent: ${errors}` };
    }
    const page = data[frameKey];
    if (!Array.isArray(page)) return { error: `unexpected shape for ${frameKey}` };
    rows.push(...(page as Row[]));
    const pagination = (
      payload._pagination as Record<string, { hasMore?: boolean; nextCursor?: string }>
    )?.[frameKey];
    if (pagination?.hasMore !== true) break;
    // A partial table read as complete is the defect this guards: it would
    // miscount the admin floor or the directory rather than fail.
    if (typeof pagination.nextCursor !== 'string') {
      return { error: `${frameKey}: server reported hasMore with no nextCursor` };
    }
    cursor = pagination.nextCursor;
  }
  return { rows };
}

export interface DirectoryReconciliation {
  /** Inactive directory row, live signing credential — the dangerous direction. */
  readonly retiredWithLiveKey: readonly string[];
  /** Live credential, no directory row, not admin-exempt. */
  readonly liveKeyWithoutRow: readonly string[];
  /** Active directory row with a live credential that is not admin-capable. */
  readonly agentKids: readonly string[];
}

/**
 * Reconciles live Key rows against AgentIdentity rows, returning retired
 * identities that still hold a live key and live keys with no directory row.
 *
 * Admin keys are exempt from the second list by CAPABILITY, never by kid: the
 * bootstrap root of trust has no directory row by design.
 *
 * A row whose `active` is absent counts as ACTIVE — only an explicit `false`
 * deactivates. Rows predating the field must not read as decommissioned.
 * A key row with no string kid is unmatchable and ignored (doctor is not a
 * corruption scanner).
 */
export function reconcileIdentities(
  keys: readonly Row[],
  identities: readonly Row[],
  adminCapability: string
): DirectoryReconciliation {
  const liveByKid = new Map<string, Row>();
  for (const key of keys) {
    if (typeof key.kid !== 'string' || key.kid.length === 0) continue;
    if (!liveByKid.has(key.kid)) liveByKid.set(key.kid, key);
  }
  const activeByKid = new Map<string, boolean>();
  for (const identity of identities) {
    if (typeof identity.kid !== 'string' || identity.kid.length === 0) continue;
    if (!activeByKid.has(identity.kid)) activeByKid.set(identity.kid, identity.active !== false);
  }
  const retiredWithLiveKey: string[] = [];
  const liveKeyWithoutRow: string[] = [];
  const agentKids: string[] = [];
  for (const [kid, key] of liveByKid) {
    const active = activeByKid.get(kid);
    const admin = isActiveAdminKeyRow(key, adminCapability);
    if (active === false) {
      retiredWithLiveKey.push(kid);
    } else if (active === undefined && !admin) {
      liveKeyWithoutRow.push(kid);
    } else if (active === true && !admin) {
      agentKids.push(kid);
    }
  }
  retiredWithLiveKey.sort();
  liveKeyWithoutRow.sort();
  agentKids.sort();
  return { retiredWithLiveKey, liveKeyWithoutRow, agentKids };
}

/**
 * What diagnose measured, as data. A field is ABSENT when the check that measures it did not
 * run — absent never means empty, so a reader cannot take "not looked" for "none found".
 */
export interface DiagnoseFacts {
  readonly adminKids?: readonly string[];
  readonly liveKeyCount?: number;
  readonly retiredWithLiveKey?: readonly string[];
  readonly liveKeyWithoutRow?: readonly string[];
  readonly agentKids?: readonly string[];
}

/** The identity the server resolved, when the identity check passed; else null. */
export interface DiagnoseResult extends DoctorReport {
  readonly identity: string | null;
  readonly facts: DiagnoseFacts;
}

export type DiagnoseCredential =
  | { readonly authorization: () => string; readonly label: string }
  /** `fix` replaces the default advice, which names the admin env: a caller diagnosing some
   *  other identity knows what that identity needs. */
  | { readonly error: string; readonly fix?: string };

export interface DiagnoseOpts {
  readonly baseUrl: string;
  readonly credential: DiagnoseCredential;
  /** Default 'admin'. */
  readonly adminCapability?: string;
  /** Default true. False: the admin-only checks are skipped as not asked, not failed. */
  readonly expectAdmin?: boolean;
  readonly fetch?: typeof fetch;
}

/** Every check `diagnose` can emit, in dependency order: what a caller marks NOT ASKED when it
 *  cannot run diagnose at all (the CLI's direct-to-postgres target). */
export const DIAGNOSE_CHECKS: readonly string[] = [
  CHECK_REACHABLE,
  CHECK_AUTH_ENABLED,
  CHECK_CREDENTIAL,
  CHECK_IDENTITY,
  CHECK_ADMIN,
  CHECK_FLOOR,
  CHECK_NAMESPACES,
  CHECK_DIR,
  CHECK_STORAGE
];

/**
 * Runs every check against `opts.baseUrl`, in dependency order. A failure
 * short-circuits its dependants into explicit skips.
 */
export async function diagnose(opts: DiagnoseOpts): Promise<DiagnoseResult> {
  const checks = new Checks();
  const fetchImpl = opts.fetch ?? fetch;
  const adminCapability = opts.adminCapability ?? 'admin';
  const baseUrl = trimTrailingSlashes(opts.baseUrl);
  let identityId: string | null = null;
  let facts: DiagnoseFacts = {};
  const done = (): DiagnoseResult => ({ ...checks.done(), identity: identityId, facts });

  const health = await getJson(`${baseUrl}/health`, fetchImpl);
  if ('error' in health) {
    checks.no(
      CHECK_REACHABLE,
      `${baseUrl}/health could not be reached: ${health.error}`,
      'Check the URL, that the service is up (`systemctl status substrate-binary`), and that ' +
        'TLS trusts the certificate.'
    );
    return done();
  }
  if (health.status !== 200) {
    checks.no(
      CHECK_REACHABLE,
      `${baseUrl}/health answered HTTP ${health.status}`,
      'The server is answering but unhealthy — read `journalctl -u substrate-binary`.',
      health.status
    );
    return done();
  }
  checks.ok(CHECK_REACHABLE, `${baseUrl} is up, version ${String(health.body.version ?? '?')}`);

  // The auth posture is read BEFORE presenting a credential, so a server that
  // checks no credentials is reported as such rather than as a bad credential.
  // An unsigned /substrate/v1/whoami answers every caller with `authEnabled`.
  const posture = await getJson(`${baseUrl}/substrate/v1/whoami`, fetchImpl);
  const authEnabled = 'error' in posture ? undefined : posture.body.authEnabled;
  if (authEnabled === false) {
    checks.no(
      CHECK_AUTH_ENABLED,
      'the deployment has auth DISABLED — it verifies nothing, and every caller is ' +
        'anonymous. An admin credential cannot resolve here no matter how correct it is, ' +
        'and `policy_denied: no identity` is what that looks like from three layers up.',
      'Set SUBSTRATE_AUTH_MODE on the server (attribute or required) and restart it — the ' +
        'setting is read at boot, so an edit alone changes nothing.'
    );
  } else if (authEnabled === true) {
    checks.ok(CHECK_AUTH_ENABLED, 'the server verifies credentials (authEnabled true)');
  } else {
    checks.ok(
      CHECK_AUTH_ENABLED,
      'could not read authEnabled from /substrate/v1/whoami — treating as unknown, not as on'
    );
  }

  const cred = opts.credential;
  if ('error' in cred) {
    checks.no(
      CHECK_CREDENTIAL,
      cred.error,
      cred.fix ??
        'Set SUBSTRATE_ADMIN_TOKEN, or SUBSTRATE_ADMIN_KEY_PATH + SUBSTRATE_ADMIN_KEY_ID, or run ' +
          '`substrate-admin bootstrap` on a deployment that has no admin yet.'
    );
    return done();
  }
  checks.ok(CHECK_CREDENTIAL, `a token was minted from ${cred.label}`);
  const authorization = cred.authorization();

  // Hosted namespaces come from /substrate/v1/onboard, which needs a key once auth is
  // on, so it is read with the credential just minted.
  const onboard = await getJson(`${baseUrl}/substrate/v1/onboard`, fetchImpl, { authorization });
  const onboardFix =
    'The server is up but could not say what it hosts — read `journalctl -u substrate-binary`.';
  const binary =
    'error' in onboard ? undefined : (onboard.body.binary as Record<string, unknown> | undefined);
  if ('error' in onboard) {
    checks.no(
      CHECK_NAMESPACES,
      `${baseUrl}/substrate/v1/onboard could not be reached: ${onboard.error}`,
      onboardFix
    );
  } else if (onboard.status === 401 || onboard.status === 403) {
    // A refused credential is the identity check's verdict; failing here too would count it twice.
    checks.skip(
      CHECK_NAMESPACES,
      `not asked — /substrate/v1/onboard refused the credential (HTTP ${onboard.status}); see identity`
    );
  } else if (onboard.status !== 200) {
    checks.no(
      CHECK_NAMESPACES,
      `${baseUrl}/substrate/v1/onboard answered HTTP ${onboard.status}`,
      onboardFix,
      onboard.status
    );
  } else if (binary === undefined) {
    checks.no(
      CHECK_NAMESPACES,
      '/substrate/v1/onboard answered 200 with no `binary` block, so the hosted namespaces are unknown',
      onboardFix,
      onboard.status
    );
  } else {
    const coordinators = Array.isArray(binary.coordinators) ? binary.coordinators : [];
    const hosted = new Set<string>([SYSTEM_NAMESPACE]);
    for (const c of coordinators as Array<Record<string, unknown>>) {
      for (const ns of Array.isArray(c.namespaces) ? c.namespaces : []) {
        if (typeof ns === 'string') hosted.add(ns);
      }
    }
    for (const ns of Array.isArray(binary.virtualNamespaces) ? binary.virtualNamespaces : []) {
      if (typeof ns === 'string') hosted.add(ns);
    }
    checks.ok(CHECK_NAMESPACES, `hosted: ${[...hosted].sort().join(', ')}`);
  }

  const whoami = await getJson(`${baseUrl}/substrate/v1/whoami`, fetchImpl, { authorization });
  if ('error' in whoami) {
    checks.no(
      CHECK_IDENTITY,
      `${baseUrl}/substrate/v1/whoami could not be reached: ${whoami.error}`,
      'The health check passed, so this is likely a proxy or path problem rather than a ' +
        'down server.'
    );
    return done();
  }
  const identity = whoami.body.identity as Record<string, unknown> | null | undefined;
  if (whoami.status === 401) {
    checks.no(
      CHECK_IDENTITY,
      'the server REJECTED the credential (401). It arrived and did not verify — a wrong ' +
        'key/kid pair, or a kid with no live Key row.',
      'Confirm the kid names a live row (`substrate-admin list`) and that the private key ' +
        "beside it is the pair for that row's public key.",
      whoami.status
    );
    return done();
  }
  if (identity === null || identity === undefined) {
    checks.no(
      CHECK_IDENTITY,
      'the server saw NO identity on the request. The credential never arrived — this is ' +
        'not a rejection (that would be a 401), it is an absence.',
      'Check the token is being sent as `Authorization: Bearer …` and that no proxy is ' +
        'stripping the header.',
      whoami.status
    );
    return done();
  }
  checks.ok(CHECK_IDENTITY, `the server resolved this credential as ${String(identity.id)}`);
  identityId = String(identity.id);
  if (opts.expectAdmin === false) {
    for (const name of [CHECK_ADMIN, CHECK_FLOOR, CHECK_DIR, CHECK_STORAGE]) {
      checks.skip(name, 'not asked — this identity was not expected to be an admin');
    }
    return done();
  }

  const grant = grantFromWhoami(identity.grants);
  if (grant === null) {
    checks.no(
      CHECK_ADMIN,
      'the whoami response carried no readable `grants` block, so what this identity may ' +
        'do cannot be established from here.',
      'Check `version` above against the client you are running: a server older than ' +
        'this client may not send `grants`.'
    );
    return done();
  }
  const substrateCaps = capabilitiesFor(grant, SYSTEM_NAMESPACE);
  if (!substrateCaps.has(adminCapability)) {
    checks.no(
      CHECK_ADMIN,
      `the identity authenticates but its grant does not confer '${adminCapability}' on ` +
        `${SYSTEM_NAMESPACE} — it has ${JSON.stringify(identity.grants)}. Every admin route ` +
        'will answer policy_denied, which names the missing capability but not that the ' +
        'credential itself is fine.',
      `Widen the grant: substrate-admin update ${String(identity.id)} ` +
        `--ns '${SYSTEM_NAMESPACE}:read+mutate+${adminCapability}' --widen --allow-admin`
    );
    return done();
  }
  checks.ok(
    CHECK_ADMIN,
    `the grant confers '${adminCapability}' on ${SYSTEM_NAMESPACE} — this identity can administer`
  );

  const config = await getJson(`${baseUrl}/substrate/v1/config`, fetchImpl, { authorization });
  const storage =
    'error' in config ? undefined : (config.body.storage as Record<string, unknown> | undefined);
  if ('error' in config || config.status !== 200) {
    checks.skip(
      CHECK_STORAGE,
      `not asked — /substrate/v1/config ${'error' in config ? `could not be reached: ${config.error}` : `answered HTTP ${config.status}`}`
    );
  } else if (storage === undefined) {
    checks.skip(CHECK_STORAGE, 'not asked — the server reports no storage section (memory store)');
  } else {
    const warnings = Array.isArray(storage.warnings) ? storage.warnings.map(String) : [];
    // Info lines (open index recommendations) are shown, never counted as a fault.
    const info = Array.isArray(storage.info)
      ? storage.info.map((l) => `\n${String(l)}`).join('')
      : '';
    if (warnings.length === 0) {
      checks.ok(CHECK_STORAGE, `${String(storage.layout)} layout, no warnings${info}`);
    } else {
      checks.no(
        CHECK_STORAGE,
        `${String(storage.layout)} layout, ${warnings.length} warning(s):\n${warnings.join('\n')}${info}`,
        'Each warning names what to move or drop; indexes are never dropped automatically.'
      );
    }
  }

  const floor = await listLiveKeys(baseUrl, authorization, fetchImpl);
  if ('error' in floor) {
    checks.no(
      CHECK_FLOOR,
      `could not read ${SYSTEM_NAMESPACE}/Key: ${floor.error}`,
      'The identity is admin, so this is a route or store problem rather than a ' +
        'permission one — read `journalctl -u substrate-binary`.'
    );
    return done();
  }
  const admins = floor.rows
    .filter((row) => isActiveAdminKeyRow(row, adminCapability))
    .map((row) => String(row.kid));
  facts = { ...facts, adminKids: admins, liveKeyCount: floor.rows.length };
  if (admins.length === 0) {
    checks.no(
      CHECK_FLOOR,
      `${floor.rows.length} live keys and NONE of them classifies as admin — yet the credential ` +
        'above just authenticated as one. The two answers disagree, which means the ' +
        'classifier and the policy have diverged.',
      'Report it — do not revoke anything until it is ' + 'understood.'
    );
    return done();
  }
  const roster = admins.join(', ');
  checks.ok(
    CHECK_FLOOR,
    admins.length === 1
      ? `1 admin key of ${floor.rows.length} live: ${roster}. NOTE: it is the last one — the floor ` +
          'will refuse to revoke it, and losing it locks the deployment out of its own ' +
          'admin surface. Register a second before you need one.'
      : `${admins.length} admin keys of ${floor.rows.length} live: ${roster}. Succession is ` +
          'possible — either can be rotated out while the other administers.'
  );

  const directory = await listDirectoryIdentities(baseUrl, authorization, fetchImpl);
  if ('error' in directory) {
    checks.no(
      CHECK_DIR,
      `could not read cortext/AgentIdentity: ${directory.error}`,
      'The identity is admin, so this is a route or store problem rather than a ' +
        'permission one — read `journalctl -u substrate-binary`.'
    );
    return done();
  }
  if ('absent' in directory) {
    checks.skip(
      CHECK_DIR,
      'not asked — the directory frame never came back. This credential cannot read ' +
        `cortext/AgentIdentity (${directory.absent}), so there is no directory to ` +
        'reconcile against, and an empty one would read as "every live key is ' +
        'orphaned". Re-run with an identity granted read on cortext to get this check.'
    );
    return done();
  }
  const { retiredWithLiveKey, liveKeyWithoutRow, agentKids } = reconcileIdentities(
    floor.rows,
    directory.rows,
    adminCapability
  );
  facts = { ...facts, retiredWithLiveKey, liveKeyWithoutRow, agentKids };
  if (retiredWithLiveKey.length > 0) {
    const kids = retiredWithLiveKey.join(', ');
    checks.no(
      CHECK_DIR,
      `decommissioned ${retiredWithLiveKey.length === 1 ? 'agent' : 'agents'} with a LIVE signing ` +
        `credential: ${kids}. The directory says retired; the key ` +
        'table still verifies — and the table is what the server checks.',
      `Revoke ${retiredWithLiveKey.length === 1 ? 'it' : 'them'} if the decommission stands ` +
        `(\`substrate-admin revoke ${kids}\`), or re-activate the directory row if it does not.`
    );
    return done();
  }
  if (liveKeyWithoutRow.length > 0) {
    const kids = liveKeyWithoutRow.join(', ');
    checks.no(
      CHECK_DIR,
      `live ${liveKeyWithoutRow.length === 1 ? 'credential' : 'credentials'} with no directory ` +
        `row: ${kids}. Nothing references these identities, so no ` +
        'other surface will ever surface them (admin-capable keys are exempt — the ' +
        'bootstrap root of trust has no row by design).',
      'If the identity is real, register its directory row; if it is unattended ' +
        `machinery nobody owns, revoke the key (\`substrate-admin revoke ${kids}\`).`
    );
    return done();
  }
  checks.ok(
    CHECK_DIR,
    `credential table and directory agree: ${floor.rows.length} live keys, ` +
      `${directory.rows.length} directory rows, no retired row holding a live key and no ` +
      'live key without a row (admin roots exempt by capability, not by name).'
  );
  return done();
}
