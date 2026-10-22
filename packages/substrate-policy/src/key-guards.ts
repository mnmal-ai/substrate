/**
 * Shared refusal rules for mutating a `_system/Key`, used by both the
 * `substrate-admin` CLI and the key routes so the lockout guard cannot drift.
 *
 * The READ is deliberately not shared: the CLI reads inside its own
 * `withTransaction`; the route reads through `engine.query` so the registry
 * interceptor fires. Each caller gathers the facts and hands them here.
 *
 * Refusals are RETURNED, not thrown. The CLI maps them to its exit codes and
 * the route maps them to HTTP statuses; a shared thrower would force one
 * caller's error vocabulary onto the other.
 */

import { isActiveAdminKeyRow, SYSTEM_NAMESPACE } from './admin-key.js';
import { capabilitiesFor, type Grant, parseGrantEntries } from './grant.js';

/** Why a key mutation is refused. `null` from a check means "allowed". */
export type KeyMutationRefusal =
  | { code: 'unknown_kid'; message: string }
  | { code: 'already_revoked'; message: string; revokedAt: string }
  | { code: 'last_active_admin'; message: string };

/** Normalise a `revokedAt` cell to an ISO string, or null when the key is live. */
export function revokedAtIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value);
  return s.length === 0 ? null : s;
}

/**
 * The revoke verdict.
 *
 * `activeAdminKids` is every kid that {@link isActiveAdminKeyRow} accepts,
 * gathered by the caller. Passing an INCOMPLETE list silently weakens the
 * lockout guard, so callers must read the whole key table, never a page of it.
 */
export function checkRevocable(input: {
  kid: string;
  /** The row's `revokedAt`, or `null` when live. Pass `undefined` for "no such row". */
  existingRevokedAt: unknown | undefined;
  exists: boolean;
  activeAdminKids: ReadonlyArray<string>;
}): KeyMutationRefusal | null {
  if (!input.exists) {
    return { code: 'unknown_kid', message: `no Key with kid ${input.kid}` };
  }
  const already = revokedAtIso(input.existingRevokedAt);
  if (already !== null) {
    return {
      code: 'already_revoked',
      message: `Key ${input.kid} already revoked at ${already}`,
      revokedAt: already
    };
  }
  // Lockout guard: the last active admin key MUST NOT be revocable. Retiring
  // the last admin is `rotate`, which mints a replacement in the same breath.
  if (input.activeAdminKids.length === 1 && input.activeAdminKids[0] === input.kid) {
    return {
      code: 'last_active_admin',
      message:
        `refusing to revoke the last active admin Key (${input.kid}). ` +
        'Rotate instead via `substrate-admin rotate`.'
    };
  }
  return null;
}

/** Does `granted` already cover `item`? A `*` grant covers everything. */
export function grantCovers(granted: ReadonlyArray<string>, item: string): boolean {
  return granted.includes('*') || granted.includes(item);
}

/**
 * Entries in `next` that `prev` did not already grant.
 *
 * This — not "is the new set a strict superset" — is the test that matters. A
 * lateral change like `tasks` -> `notes` is neither a superset nor a subset,
 * yet it hands the key an authority it did not hold. Empty result means the
 * change grants nothing new, i.e. it narrows, and narrowing needs no flag.
 */
export function newlyGranted(
  prev: ReadonlyArray<string>,
  next: ReadonlyArray<string>
): Array<string> {
  return next.filter((item) => !grantCovers(prev, item));
}

/**
 * Entries in `next` that `prev` did not already grant, as `(ns, cap)` PAIRS
 * (spec §6). A wildcard entry in `prev` covers any namespace at the
 * capabilities it conferred. A pure narrowing yields the empty set.
 *
 * Returns entries GROUPED BY NAMESPACE in the CLI's own spelling —
 * `recall:read+mutate`, not `recall:read, recall:mutate` — for the operator-
 * facing refusal message.
 */
export function newlyGrantedPairs(
  prev: Readonly<Record<string, ReadonlyArray<string>>>,
  next: Readonly<Record<string, ReadonlyArray<string>>>
): Array<string> {
  // What a namespace effectively holds, by `capabilitiesFor`'s rule: an
  // explicit entry beats the wildcard. Checking both independently missed
  // `['*', 'notes:read']` -> `['*']`, which hands `notes` the wildcard's caps.
  const effective = (grant: typeof prev, ns: string): ReadonlyArray<string> =>
    grant[ns] ?? grant['*'] ?? [];
  const byNs = new Map<string, Array<string>>();
  for (const ns of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    const had = effective(prev, ns);
    for (const cap of effective(next, ns)) {
      if (had.includes(cap)) continue;
      const bucket = byNs.get(ns);
      if (bucket === undefined) byNs.set(ns, [cap]);
      else bucket.push(cap);
    }
  }
  return [...byNs.entries()].map(([ns, caps]) => `${ns}:${[...caps].sort().join('+')}`).sort();
}

/**
 * Parse an entry list + default capabilities, or `null` when it will not parse.
 * Never throws: a malformed grant becomes a returned refusal, not an exception.
 */
function tryParseGrant(
  entries: ReadonlyArray<string>,
  defaultCapabilities: ReadonlyArray<string>
): Grant | null {
  try {
    return parseGrantEntries(entries, defaultCapabilities);
  } catch {
    return null;
  }
}

/** The `ns -> caps` shape {@link newlyGrantedPairs} compares. */
function grantAsRecord(grant: Grant): Record<string, Array<string>> {
  return Object.fromEntries([...grant].map(([ns, caps]) => [ns, [...caps]]));
}

/**
 * Does this grant confer `capability` in ANY namespace?
 *
 * Deliberately NOT scoped to `_system` the way the lockout floor is. The floor
 * asks "can this key administer the DEPLOYMENT"; the opt-in gate asks "is
 * authority named `admin` being handed out" anywhere. Scoping the gate would
 * make the namespace syntax a way around it.
 */
function confersAnywhere(grant: Grant, capability: string): boolean {
  for (const caps of grant.values()) if (caps.has(capability)) return true;
  return false;
}

/**
 * Does this entry list confer `capability` in any namespace?
 *
 * The shared predicate behind the `--allow-admin` / `allowAdmin` opt-in, so
 * `register` (CLI and route) and `update` cannot answer it differently. Reads
 * the parsed grant, not the flat list, so `--ns '_system:admin' --caps read`
 * still trips it.
 *
 * Returns `true` on an unparseable list: this is a confirmation gate, so the
 * safe failure is asking for confirmation, never handing a privilege over
 * unasked.
 */
export function grantEntriesConfer(
  entries: ReadonlyArray<string>,
  defaultCapabilities: ReadonlyArray<string>,
  capability: string
): boolean {
  const grant = tryParseGrant(entries, defaultCapabilities);
  return grant === null ? true : confersAnywhere(grant, capability);
}

/** Why an in-place key update is refused. `null` means allowed. */
export type KeyUpdateRefusal =
  | KeyMutationRefusal
  | { code: 'last_admin_deadmin'; message: string }
  | {
      code: 'requires_widen';
      message: string;
      namespacesGranted: Array<string>;
      capabilitiesGranted: Array<string>;
    }
  | { code: 'requires_allow_admin'; message: string }
  | { code: 'invalid_grant'; message: string };

/**
 * The in-place update verdict. Returns the first refusal, or `null` if allowed.
 *
 * ORDER IS PART OF THE RULE: **unconditional refusals outrank confirmable
 * ones.** One request can trip both the lockout and the widen gate; reporting
 * the confirmable one first sends the operator to add the flag, re-run, and
 * dead-end on the lockout.
 */
export function checkUpdatable(input: {
  kid: string;
  exists: boolean;
  existingRevokedAt: unknown | undefined;
  prevNamespaces: ReadonlyArray<string>;
  prevCapabilities: ReadonlyArray<string>;
  nextNamespaces: ReadonlyArray<string>;
  nextCapabilities: ReadonlyArray<string>;
  /** Every kid that {@link isActiveAdminKeyRow} accepts. Must be the WHOLE set. */
  activeAdminKids: ReadonlyArray<string>;
  adminCapability: string;
  widen: boolean;
  allowAdmin: boolean;
}): KeyUpdateRefusal | null {
  if (!input.exists) {
    return { code: 'unknown_kid', message: `no Key with kid ${input.kid}` };
  }
  const already = revokedAtIso(input.existingRevokedAt);
  if (already !== null) {
    return {
      code: 'already_revoked',
      message: `Key ${input.kid} was revoked at ${already} — update refuses a revoked key.`,
      revokedAt: already
    };
  }

  // One parse per side, shared by every rule below.
  const prevGrant = tryParseGrant(input.prevNamespaces, input.prevCapabilities);
  const nextGrant = tryParseGrant(input.nextNamespaces, input.nextCapabilities);
  if (prevGrant === null || nextGrant === null) {
    // Unconditional, and ahead of the lockout: a grant nobody can read supports
    // no verdict at all, so answering the later questions would mean guessing.
    return {
      code: 'invalid_grant',
      message:
        `Key ${input.kid}: ${prevGrant === null ? 'the stored' : 'the requested'} grant ` +
        "cannot be parsed — expected '<namespace>' or '<namespace>:<cap>[+<cap>...]' per entry."
    };
  }

  // Lockout FIRST. See the ordering note above. Scoped to `_system`, matching
  // `isActiveAdminKeyRow` exactly, because it is compared against the set
  // that builds.
  const dropsAdmin =
    capabilitiesFor(prevGrant, SYSTEM_NAMESPACE).has(input.adminCapability) &&
    !capabilitiesFor(nextGrant, SYSTEM_NAMESPACE).has(input.adminCapability);
  if (dropsAdmin && input.activeAdminKids.length === 1 && input.activeAdminKids[0] === input.kid) {
    return {
      code: 'last_admin_deadmin',
      message:
        `refusing to drop '${input.adminCapability}' from the last active admin Key ` +
        `(${input.kid}) — that would lock every operator out of this store.`
    };
  }

  // The widen question is asked over (namespace, capability) PAIRS: the flat
  // lists cannot tell a per-namespace narrowing from a widening.
  const pairsGranted = newlyGrantedPairs(grantAsRecord(prevGrant), grantAsRecord(nextGrant));
  const namespacesGranted = newlyGranted(input.prevNamespaces, input.nextNamespaces);
  const capabilitiesGranted = newlyGranted(input.prevCapabilities, input.nextCapabilities);
  if (!input.widen && pairsGranted.length > 0) {
    const parts: Array<string> = [`grants +${pairsGranted.join(',')}`];
    return {
      code: 'requires_widen',
      // Neutral wording. HOW to confirm differs per caller — the CLI says
      // `--widen`, the route says a body field — so the instruction is the
      // caller's to add.
      message: `update would GRANT authority ${input.kid} does not have (${parts.join('; ')}).`,
      namespacesGranted,
      capabilitiesGranted
    };
  }

  if (
    confersAnywhere(nextGrant, input.adminCapability) &&
    !confersAnywhere(prevGrant, input.adminCapability) &&
    !input.allowAdmin
  ) {
    return {
      code: 'requires_allow_admin',
      message: "granting the 'admin' capability requires explicit confirmation"
    };
  }
  return null;
}
