/**
 * Facts about `_system/Key` rows that a CLIENT needs as much as the server: which rows are
 * admin keys, and how a stored grant reads. Shared so `substrate-admin`, substrate-tui and the server's
 * guards cannot disagree.
 */

import type { Row } from '@mnmal-ai/substrate-types';
import { decodeList } from './encoding.js';
import { capabilitiesFor, type Grant, parseGrantEntries } from './grant.js';

/** The kernel namespace holding Key, Invite and the admin routes' rows. */
export const SYSTEM_NAMESPACE = '_system';

/**
 * Does this row count as an ACTIVE ADMIN key? True when unrevoked, with a kid,
 * and its grant confers `adminCapability` in `_system` (explicit entry, else the
 * wildcard) — the same question `requireCapability` asks at dispatch, through
 * the same parser. Admin scoped to another namespace (e.g. `tasks`) does not
 * count.
 */
export function isActiveAdminKeyRow(row: Row, adminCapability: string): boolean {
  if (row.revokedAt != null) return false;
  const kid = row.kid;
  if (typeof kid !== 'string' || kid.length === 0) return false;
  let grant: Grant;
  try {
    grant = parseGrantEntries(decodeList(row.namespaces), decodeList(row.capabilities));
  } catch {
    // An unparseable grant authenticates nowhere, so it is no admin. Must not
    // throw: callers classify the whole key table inside a filter, and
    // rethrowing would break the very `revoke` that removes the offending row.
    return false;
  }
  return capabilitiesFor(grant, SYSTEM_NAMESPACE).has(adminCapability);
}

/**
 * The grant, one line per namespace, in the SAME syntax `--ns` accepts.
 *
 * `tasks:read+mutate` round-trips: paste a rendered line back into `--ns` and
 * it means what it says here.
 *
 * TOTAL, and it has to be: this runs inside a formatter, after the write has
 * already committed. `parseGrantEntries` throws on a malformed entry, and a
 * throw here would lose the operator the record of an operation that SUCCEEDED.
 * An unparseable grant falls back to naming the raw columns and saying so.
 */
export function describeGrant(namespaces: string, capabilities: string): string[] {
  let grant: ReadonlyMap<string, ReadonlySet<string>>;
  try {
    grant = parseGrantEntries(decodeList(namespaces), decodeList(capabilities));
  } catch (err) {
    return [
      `UNPARSEABLE — stored as namespaces='${namespaces}' capabilities='${capabilities}'`,
      `(${err instanceof Error ? err.message : String(err)})`
    ];
  }
  if (grant.size === 0) return ['(none — this key is granted nothing)'];
  // Capability order is the operator's own, never sorted: for a bare entry it is
  // the order they typed into --caps, and for an explicit one the order in the
  // entry itself. Sorting would make the echo stop matching the input.
  return [...grant].map(([ns, caps]) => `${ns}:${[...caps].join('+')}`);
}
