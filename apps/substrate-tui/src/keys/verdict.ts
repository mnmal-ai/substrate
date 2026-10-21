/**
 * What the server will say about a key write, asked before it is sent. The rules are
 * substrate-policy's — the same functions the routes enforce with — so the preview and the verdict
 * cannot drift by construction; a refusal the preview did not predict is still shown verbatim.
 */

import type { AdminKeyRow } from '@mnmal-ai/substrate/client';
import {
  checkRevocable,
  checkUpdatable,
  decodeList,
  flattenGrant,
  type Grant,
  grantEntriesConfer,
  isActiveAdminKeyRow
} from '@mnmal-ai/substrate/client';
import type { Row } from '@mnmal-ai/substrate/sdk';
import { rowGrant, toWire } from './grant.js';

export type Flag = 'widen' | 'allowAdmin' | 'allowUnknownNs';
export type Verdict =
  | { readonly kind: 'refused'; readonly code: string; readonly message: string }
  | {
      readonly kind: 'ok';
      readonly tier: 1 | 2;
      readonly flags: readonly Flag[];
      readonly reasons: readonly string[];
    };

const EMPTY: Verdict = {
  kind: 'refused',
  code: 'empty_grant',
  message: 'a key needs at least one namespace — revoke removes all access'
};

const adminKids = (table: readonly AdminKeyRow[], cap: string) =>
  table.filter((r) => isActiveAdminKeyRow(r as unknown as Row, cap)).map((r) => r.kid);

const unhosted = (next: Grant, hosted: readonly string[]) =>
  flattenGrant(next).namespaces.filter((ns) => ns !== '*' && !hosted.includes(ns));

const starOf = (g: Grant) => [...(g.get('*') ?? [])].sort().join('+');

const rowGrantOrEmpty = (row: AdminKeyRow): Grant => rowGrant(row) ?? new Map();

export function updateVerdict(i: {
  row: AdminKeyRow;
  next: Grant;
  table: readonly AdminKeyRow[];
  hosted: readonly string[];
  adminCapability: string;
}): Verdict {
  if (i.next.size === 0) return EMPTY;
  const wire = toWire(i.next);
  const facts = {
    kid: i.row.kid,
    exists: true,
    existingRevokedAt: null,
    prevNamespaces: decodeList(i.row.namespaces),
    prevCapabilities: decodeList(i.row.capabilities),
    nextNamespaces: wire.namespaces,
    nextCapabilities: wire.capabilities,
    activeAdminKids: adminKids(i.table, i.adminCapability),
    adminCapability: i.adminCapability
  };
  const flags: Flag[] = [];
  const reasons: string[] = [];
  // checkUpdatable reports the first refusal only; lift each confirmable one in turn to collect all.
  let widen = false;
  let allowAdmin = false;
  for (;;) {
    const r = checkUpdatable({ ...facts, widen, allowAdmin });
    if (r === null) break;
    if (r.code === 'requires_widen' && !widen) {
      widen = true;
      flags.push('widen');
      reasons.push(r.message);
    } else if (r.code === 'requires_allow_admin' && !allowAdmin) {
      allowAdmin = true;
      flags.push('allowAdmin');
      reasons.push(r.message);
    } else {
      return { kind: 'refused', code: r.code, message: r.message };
    }
  }
  const unknown = unhosted(i.next, i.hosted);
  if (unknown.length > 0) {
    flags.push('allowUnknownNs');
    reasons.push(`names namespace(s) this deployment does not host: ${unknown.join(', ')}`);
  }
  const prevStar = starOf(rowGrantOrEmpty(i.row));
  if (prevStar !== starOf(i.next)) reasons.push('changes the * row, which reaches every namespace');
  if (!allowAdmin && grantEntriesConfer(wire.namespaces, wire.capabilities, i.adminCapability)) {
    reasons.push(`carries '${i.adminCapability}'`);
  }
  return { kind: 'ok', tier: reasons.length > 0 ? 2 : 1, flags, reasons };
}

export function revokeVerdict(i: {
  kid: string;
  table: readonly AdminKeyRow[];
  adminCapability: string;
}): Verdict {
  const r = checkRevocable({
    kid: i.kid,
    exists: true,
    existingRevokedAt: null,
    activeAdminKids: adminKids(i.table, i.adminCapability)
  });
  return r === null
    ? { kind: 'ok', tier: 1, flags: [], reasons: [] }
    : { kind: 'refused', code: r.code, message: r.message };
}

export function newKeyVerdict(i: {
  kind: 'register' | 'invite';
  next: Grant;
  hosted: readonly string[];
  adminCapability: string;
}): Verdict {
  if (i.next.size === 0) return EMPTY;
  const wire = toWire(i.next);
  const flags: Flag[] = [];
  const reasons: string[] = i.kind === 'register' ? ['registers a new identity'] : [];
  if (grantEntriesConfer(wire.namespaces, wire.capabilities, i.adminCapability)) {
    // The invites route has no admin opt-in: an admin invite is tier 2 with nothing to send.
    if (i.kind === 'register') flags.push('allowAdmin');
    reasons.push(`carries '${i.adminCapability}'`);
  }
  const unknown = unhosted(i.next, i.hosted);
  if (unknown.length > 0) {
    if (i.kind === 'register') flags.push('allowUnknownNs');
    reasons.push(`names namespace(s) this deployment does not host: ${unknown.join(', ')}`);
  }
  if (i.next.has('*')) reasons.push('grants the * row, which reaches every namespace');
  return { kind: 'ok', tier: reasons.length > 0 ? 2 : 1, flags, reasons };
}
