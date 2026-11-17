/**
 * The key list's layout: active keys grouped under their host (the part of the kid after the last
 * `@`), then revoked keys in a section of their own. Each row shows the agent name and its grant
 * as one aligned column per namespace, so the same namespace lines up down the list.
 */

import type { AdminKeyRow } from '@mnmal-ai/substrate/client';
import { compactGrant, rowGrant, shortCaps } from './grant.js';

const NO_HOST = '(no host)';

export const isRevoked = (r: AdminKeyRow): boolean => typeof r.revokedAt === 'string';

/** `agent@host` → [agent, host]; a kid without `@` has no host. */
export function splitKid(kid: string): [agent: string, host: string] {
  const at = kid.lastIndexOf('@');
  return at <= 0 ? [kid, NO_HOST] : [kid.slice(0, at), kid.slice(at + 1)];
}

const byText = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);

/** Display order: active keys by host then agent, then revoked keys, most recently revoked first. */
export function orderForView(rows: readonly AdminKeyRow[]): AdminKeyRow[] {
  const active = rows.filter((r) => !isRevoked(r));
  const revoked = rows.filter(isRevoked);
  active.sort((a, b) => {
    const [aa, ah] = splitKid(a.kid);
    const [ba, bh] = splitKid(b.kid);
    return byText(ah, bh) || byText(aa, ba);
  });
  revoked.sort(
    (a, b) => String(b.revokedAt).localeCompare(String(a.revokedAt)) || byText(a.kid, b.kid)
  );
  return [...active, ...revoked];
}

/** One display line; `row` is the index into the ordered rows when the line is selectable. */
export interface ListLine {
  text: string;
  row?: number;
  kind: 'host' | 'key' | 'revoked-head' | 'revoked' | 'gap';
}

/** Namespaces in column order: `*` first, then the most widely granted, then by name. */
function namespaceColumns(grants: ReadonlyArray<ReadonlyMap<string, string> | null>): string[] {
  const count = new Map<string, number>();
  for (const g of grants) for (const ns of g?.keys() ?? []) count.set(ns, (count.get(ns) ?? 0) + 1);
  return [...count.keys()].sort(
    (a, b) =>
      (b === '*' ? 1 : 0) - (a === '*' ? 1 : 0) ||
      (count.get(b) ?? 0) - (count.get(a) ?? 0) ||
      byText(a, b)
  );
}

/** The ordered rows as display lines (no cursor mark; the view adds it). */
export function listLines(rows: readonly AdminKeyRow[]): ListLine[] {
  const grants = rows.map((r): ReadonlyMap<string, string> | null => {
    const g = rowGrant(r);
    return g === null ? null : new Map([...g].map(([ns, caps]) => [ns, shortCaps(caps)]));
  });
  const active = rows.map((r, i) => i).filter((i) => !isRevoked(rows[i] as AdminKeyRow));
  const cols = namespaceColumns(active.map((i) => grants[i] ?? null));
  const colW = cols.map(
    (ns) => ns.length + 1 + Math.max(1, ...active.map((i) => grants[i]?.get(ns)?.length ?? 0))
  );
  const agentW = Math.max(
    4,
    ...active.map((i) => splitKid((rows[i] as AdminKeyRow).kid)[0].length)
  );

  const lines: ListLine[] = [];
  let host: string | undefined;
  rows.forEach((r, i) => {
    if (isRevoked(r)) {
      if (lines.every((l) => l.kind !== 'revoked-head')) {
        if (lines.length > 0) lines.push({ text: '', kind: 'gap' });
        lines.push({ text: 'revoked', kind: 'revoked-head' });
      }
      lines.push({
        text: `${r.kid}  ${String(r.revokedAt).slice(0, 10)}`,
        row: i,
        kind: 'revoked'
      });
      return;
    }
    const [agent, h] = splitKid(r.kid);
    if (h !== host) {
      if (host !== undefined) lines.push({ text: '', kind: 'gap' });
      lines.push({ text: h, kind: 'host' });
      host = h;
    }
    const g = grants[i];
    const grant =
      g === null || g === undefined
        ? compactGrant(r.namespaces, r.capabilities)
        : g.size === 0
          ? '(none)'
          : cols
              .map((ns, k) => {
                const caps = g.get(ns);
                return (caps === undefined ? '' : `${ns} ${caps}`).padEnd(colW[k] as number);
              })
              .join('  ')
              .trimEnd();
    lines.push({ text: `${agent.padEnd(agentW)}  ${grant}`, row: i, kind: 'key' });
  });
  return lines;
}
