/** The grant editor's model: namespaces by capability, edited a cell at a time. */

import { capabilitiesFor, type Grant } from '@mnmal-ai/substrate/client';

export const CAPS = ['read', 'mutate', 'admin'] as const;
export type Cap = (typeof CAPS)[number];

export interface Matrix {
  readonly before: Grant;
  readonly grant: Grant;
  readonly rows: readonly string[];
  readonly hosted: ReadonlySet<string>;
  readonly row: number;
  readonly col: number;
}
export type Cell = { readonly held: 'on' | 'off' | 'inherited'; readonly diff: '+' | '-' | '' };

const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));

export function openMatrix(before: Grant, hosted: readonly string[]): Matrix {
  const granted = [...before.keys()];
  const star = granted.includes('*') ? ['*'] : [];
  const rest = granted.filter((ns) => ns !== '*');
  const extra = [...new Set(hosted)].filter((ns) => !before.has(ns)).sort();
  return {
    before,
    grant: before,
    rows: [...star, ...rest, ...extra],
    hosted: new Set(hosted),
    row: 0,
    col: 0
  };
}

export function move(m: Matrix, dRow: number, dCol: number): Matrix {
  return {
    ...m,
    row: clamp(m.row + dRow, m.rows.length - 1),
    col: clamp(m.col + dCol, CAPS.length - 1)
  };
}

export function toggle(m: Matrix): Matrix {
  const ns = m.rows[m.row];
  const cap = CAPS[m.col];
  if (ns === undefined || cap === undefined) return m;
  const caps = new Set(m.grant.get(ns) ?? []);
  if (caps.has(cap)) caps.delete(cap);
  else caps.add(cap);
  const grant = new Map(m.grant);
  grant.set(ns, caps);
  return { ...m, grant };
}

export function addNamespace(m: Matrix, ns: string): Matrix {
  const at = m.rows.indexOf(ns);
  if (at >= 0) return { ...m, row: at };
  const rows = ns === '*' ? ['*', ...m.rows] : [...m.rows, ns];
  return { ...m, rows, row: ns === '*' ? 0 : rows.length - 1 };
}

const explicit = (g: Grant, ns: string): ReadonlySet<string> | undefined => {
  const caps = g.get(ns);
  return caps !== undefined && caps.size > 0 ? caps : undefined;
};

export function cell(m: Matrix, ns: string, cap: Cap): Cell {
  const now = explicit(m.grant, ns);
  const was = explicit(m.before, ns);
  const on = now?.has(cap) === true;
  const wasOn = was?.has(cap) === true;
  const diff = on === wasOn ? '' : on ? '+' : '-';
  if (on) return { held: 'on', diff };
  // Inherited only where no explicit entry shadows the wildcard: what capabilitiesFor resolves.
  const inherited = ns !== '*' && now === undefined && capabilitiesFor(result(m), ns).has(cap);
  return { held: inherited ? 'inherited' : 'off', diff };
}

export function result(m: Matrix): Grant {
  const out = new Map<string, ReadonlySet<string>>();
  for (const ns of m.rows) {
    const caps = m.grant.get(ns);
    if (caps !== undefined && caps.size > 0) out.set(ns, new Set(caps));
  }
  return out;
}

export function changed(m: Matrix): boolean {
  const a = result(m);
  const b = result({ ...m, grant: m.before });
  if (a.size !== b.size) return true;
  for (const [ns, caps] of a) {
    const other = b.get(ns);
    if (other === undefined || other.size !== caps.size) return true;
    for (const c of caps) if (!other.has(c)) return true;
  }
  return false;
}
