/**
 * `substrate federate check` — diagnose a configured bridge, naming the fault.
 *
 * All six failure modes below present to a caller identically, as
 * `_completeness: { complete: false, unreachable: ["peer-b"] }`; this command
 * tells them apart.
 *
 * Steps run in dependency order and stop at the first failure — a scope
 * verdict computed against an unreachable peer would be noise. That applies to
 * config/key file/reachable/auth, which are properties of the coordinator, not
 * of any one namespace. Scope and namespace are properties of a GRANT, and one
 * coordinator can carry several — `formatJoinOutput` emits one `SUBSTRATE_BRIDGES`
 * entry per namespace under a single coordinator name — so those two steps run
 * once per configured namespace rather than stopping at the first.
 */

import { existsSync } from 'node:fs';
import { makeAuthorizationProvider } from '@mnmal-ai/substrate-policy';
import type { BridgeCredential } from '@mnmal-ai/substrate-types';
import { coversNamespace, grantedIn, grantOf } from '@mnmal-ai/substrate-types';
import { AdminCliError } from '../../admin/errors.js';
import { type BridgeSpec, parseBridgeCreds, parseBridges } from '../../main.js';
import { type HttpJsonFn, httpJson } from './http.js';

export type CheckStatus = 'ok' | 'fail' | 'skipped';

export interface CheckStep {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface CheckResult {
  bridge: string;
  ok: boolean;
  steps: Array<CheckStep>;
}

export interface CheckDeps {
  httpJson?: HttpJsonFn;
  /** Overridden in tests so a stub key file needn't be a real Ed25519 PEM. */
  tokenFor?: (cred: BridgeCredential) => string;
}

/**
 * `GET /substrate/v1/whoami`. `authEnabled` separates "the peer verifies nothing"
 * from "your credential did not arrive", which step 4 must tell apart.
 */
interface WhoamiIdentity {
  // `capabilities` is NULLABLE on the wire: `/substrate/v1/whoami` emits `null`
  // whenever the peer's grant is non-uniform, which must not read as "no
  // capabilities". Read `grants` instead.
  capabilities?: readonly string[] | null;
  namespaces?: readonly string[] | null;
  /** The authority. Reads identically on every surface; prefer it. */
  grants?: Record<string, string[]> | null;
  [k: string]: unknown;
}

interface WhoamiBody {
  authEnabled?: unknown;
  identity?: WhoamiIdentity | null;
}

/**
 * Step names for the per-namespace pair. A single namespace (the common case)
 * keeps the plain `scope`/`namespace` labels; two or more get the namespace
 * folded into the label so an operator can see which one failed without
 * cross-referencing detail text.
 */
function namespaceStepNames(namespaces: ReadonlyArray<string>): Array<string> {
  if (namespaces.length <= 1) return ['scope', 'namespace'];
  return namespaces.flatMap((ns) => [`scope:${ns}`, `namespace:${ns}`]);
}

export async function runCheck(
  name: string | undefined,
  env: NodeJS.ProcessEnv,
  deps: CheckDeps = {}
): Promise<Array<CheckResult>> {
  const call = deps.httpJson ?? httpJson;
  const mintToken =
    deps.tokenFor ?? ((cred: BridgeCredential) => makeAuthorizationProvider(cred)());

  const specs = parseBridges(env.SUBSTRATE_BRIDGES);
  const creds = parseBridgeCreds(env.SUBSTRATE_BRIDGE_CREDENTIALS);

  // One result per coordinator name, carrying EVERY namespace configured
  // under it. Config/key file/reachable/auth are per-coordinator (checked
  // once, against the first spec's url/origin); scope/namespace are
  // per-namespace and checked for every spec in the group — see `checkOne`.
  const byName = new Map<string, Array<BridgeSpec>>();
  for (const spec of specs) {
    const existing = byName.get(spec.name);
    if (existing === undefined) byName.set(spec.name, [spec]);
    else existing.push(spec);
  }

  const targets: Array<{ name: string; specs: Array<BridgeSpec> }> =
    name === undefined
      ? [...byName.entries()].map(([n, list]) => ({ name: n, specs: list }))
      : [{ name, specs: byName.get(name) ?? [] }];

  if (targets.length === 0) {
    throw new AdminCliError(
      'no bridges configured — SUBSTRATE_BRIDGES is empty. Run `substrate federate join` first, ' +
        'or pass --env-file pointing at the env file your instance actually reads.',
      2
    );
  }

  const results: Array<CheckResult> = [];
  for (const target of targets) {
    results.push(await checkOne(target.name, target.specs, creds, call, mintToken));
  }
  return results;
}

async function checkOne(
  bridgeName: string,
  specs: Array<BridgeSpec>,
  creds: { get(name: string): BridgeCredential | undefined },
  call: HttpJsonFn,
  mintToken: (cred: BridgeCredential) => string
): Promise<CheckResult> {
  const spec = specs[0];
  const namespaces = specs.map((s) => s.ns);
  const stepNames = ['config', 'key file', 'reachable', 'auth', ...namespaceStepNames(namespaces)];

  const steps: Array<CheckStep> = stepNames.map((n) => ({
    name: n,
    status: 'skipped' as CheckStatus,
    detail: ''
  }));
  const setStep = (index: number, status: CheckStatus, detail: string): void => {
    const step = steps[index];
    if (step !== undefined) {
      step.status = status;
      step.detail = detail;
    }
  };
  const pass = (index: number, detail: string): void => setStep(index, 'ok', detail);
  const fail = (index: number, detail: string): CheckResult => {
    setStep(index, 'fail', detail);
    return { bridge: bridgeName, ok: false, steps };
  };

  // 1 — config
  if (spec === undefined) {
    return fail(0, `bridge '${bridgeName}' is not configured in SUBSTRATE_BRIDGES`);
  }
  const cred = creds.get(bridgeName);
  if (cred === undefined) {
    return fail(0, `bridge '${bridgeName}' has no entry in SUBSTRATE_BRIDGE_CREDENTIALS`);
  }
  let specOrigin: string;
  try {
    specOrigin = new URL(spec.url).origin;
  } catch {
    return fail(0, `bridge url '${spec.url}' is malformed`);
  }
  if (specOrigin !== cred.origin) {
    return fail(
      0,
      `bridge url origin '${specOrigin}' does not match the credential origin '${cred.origin}'`
    );
  }
  pass(0, `SUBSTRATE_BRIDGES + CREDS agree on ${specOrigin}`);

  // 2 — key file
  if (!existsSync(cred.keyPath)) {
    return fail(1, `key file '${cred.keyPath}' does not exist`);
  }
  let authorization: string;
  try {
    authorization = mintToken(cred);
  } catch (err) {
    return fail(
      1,
      `key file '${cred.keyPath}' could not be used to mint a token: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  pass(1, cred.keyPath);

  // 3 — reachable
  try {
    const health = await call(`${cred.origin}/health`);
    if (health.status !== 200) {
      return fail(2, `${cred.origin}/health returned HTTP ${health.status}`);
    }
  } catch (err) {
    return fail(2, `${cred.origin} — ${err instanceof Error ? err.message : String(err)}`);
  }
  pass(2, `${cred.origin}/health`);

  // 4 — auth
  let whoami: WhoamiBody;
  try {
    const res = await call(`${cred.origin}/substrate/v1/whoami`, {
      headers: { authorization }
    });
    if (res.status === 401) {
      return fail(
        3,
        `peer does not recognise kid '${cred.kid}' — register it there, or it was revoked`
      );
    }
    if (res.status === 404) {
      // A version mismatch, not a credential problem: a peer predating whoami,
      // or one serving it only at the old `/substrate/v1/_system/whoami` path. Both
      // mean "upgrade the peer"; the old path is named so an operator can tell
      // which.
      return fail(
        3,
        `${cred.origin} does not expose /substrate/v1/whoami — the peer is likely running a release ` +
          'that predates it, or one still serving the older `/substrate/v1/_system/whoami`. ' +
          'Upgrade the peer, or verify auth by hand in the meantime.'
      );
    }
    if (res.status !== 200) {
      return fail(3, `whoami returned HTTP ${res.status}`);
    }
    whoami = (res.body ?? {}) as WhoamiBody;
  } catch (err) {
    return fail(3, `whoami failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (whoami.authEnabled !== true) {
    return fail(
      3,
      'peer reports auth DISABLED — your credential is not being verified. Anything that ' +
        '"works" against it proves nothing'
    );
  }
  // Auth is ON and the peer still resolved no identity. Only reachable when the
  // request carried no Authorization header — a present-but-invalid token 401s
  // above. So this is a fault in THIS command's own credential wiring, not at
  // the peer.
  if (whoami.identity === null || whoami.identity === undefined) {
    return fail(
      3,
      `the peer verified nothing for kid '${cred.kid}' — auth is enabled there, but this ` +
        'request arrived without a credential. Check SUBSTRATE_BRIDGE_CREDENTIALS / the key path rather ' +
        'than the peer'
    );
  }
  // Report the peer's grant. whoami answers callers with no credential, so a
  // 200 does not by itself prove the peer granted `read`. Resolved through
  // the same function the server's own gates use, so this report cannot drift
  // from what the peer will actually enforce.
  const granted = grantOf(whoami.identity);
  const summary =
    granted === null
      ? 'peer reported no grant'
      : Object.entries(granted)
          // An empty entry is a real grant of nothing, not a typo.
          .map(([ns, caps]) => `${ns}:${caps.length > 0 ? caps.join('+') : '(nothing)'}`)
          .join(', ');
  pass(3, `peer accepted kid '${cred.kid}' — grant: ${summary}`);

  // 5/6 — scope + namespace, once per configured namespace under this
  // coordinator. Unlike steps 1-4, a failure here does not short-circuit the
  // rest of the loop — an operator diagnosing a multi-namespace bridge needs
  // to see every grant's status, not just the first one checked.
  let anyNsFailed = false;
  for (let i = 0; i < specs.length; i++) {
    const nsSpec = specs[i];
    if (nsSpec === undefined) continue;
    const scopeIdx = 4 + i * 2;
    const namespaceIdx = 5 + i * 2;

    if (!coversNamespace(granted, nsSpec.ns)) {
      setStep(scopeIdx, 'fail', `peer grants ${summary} — this bridge needs '${nsSpec.ns}'`);
      anyNsFailed = true;
      continue;
    }
    // The read-only warning belongs HERE, not on step 3, because it is a
    // per-namespace fact: a peer can grant `mutate` on one bridged namespace
    // and `read` on another, and a single global verdict is wrong for one of
    // them. Informational, never a failure — a read-only bridge is valid, but
    // its refused writes surface to the caller as a bridge error.
    const here = grantedIn(granted, nsSpec.ns);
    const writable = here.includes('mutate') || here.includes('admin');
    setStep(
      scopeIdx,
      'ok',
      `peer grants '${nsSpec.ns}': ${here.length === 0 ? '(nothing)' : here.join(', ')}` +
        (writable ? '' : ' — read-only, writes through this bridge will be refused')
    );

    try {
      const schema = await call(`${cred.origin}/substrate/v1/schema/${nsSpec.ns}`);
      if (schema.status !== 200) {
        setStep(
          namespaceIdx,
          'fail',
          `peer is reachable and authorised but does not serve namespace '${nsSpec.ns}' (HTTP ${schema.status})`
        );
        anyNsFailed = true;
        continue;
      }
    } catch (err) {
      setStep(
        namespaceIdx,
        'fail',
        `schema lookup failed: ${err instanceof Error ? err.message : String(err)}`
      );
      anyNsFailed = true;
      continue;
    }
    setStep(namespaceIdx, 'ok', `peer serves '${nsSpec.ns}'`);
  }

  return { bridge: bridgeName, ok: !anyNsFailed, steps };
}

export function formatCheckOutput(results: Array<CheckResult>): string {
  const lines: Array<string> = [];
  for (const result of results) {
    lines.push('', `${result.bridge}`);
    for (const step of result.steps) {
      const mark = step.status === 'ok' ? 'OK  ' : step.status === 'fail' ? 'FAIL' : '--  ';
      lines.push(`  ${mark}  ${step.name.padEnd(10)}  ${step.detail}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
