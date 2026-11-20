/**
 * The key list's layout: active keys grouped in bands by host (the part of the kid after the last
 * `@`, compared without case), then revoked keys in a band of their own. Each row shows the agent
 * name and its grant as one aligned column per namespace, as toned parts.
 */

import type { AdminKeyRow } from '@mnmal-ai/substrate/client';
import { cellWidth, cutToWidth } from '@mnmal-ai/surface-kit';
import { type Part, truncateParts } from '../lines.js';
import { clean } from '../text.js';
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
    return (
      (bh === NO_HOST ? 1 : 0) - (ah === NO_HOST ? 1 : 0) ||
      byText(ah.toLowerCase(), bh.toLowerCase()) ||
      byText(aa.toLowerCase(), ba.toLowerCase())
    );
  });
  revoked.sort(
    (a, b) => String(b.revokedAt).localeCompare(String(a.revokedAt)) || byText(a.kid, b.kid)
  );
  return [...active, ...revoked];
}

/** Namespaces in column order: `*` first, then the most widely granted, then by name. */
function namespaceColumns(grants: ReadonlyArray<ReadonlyMap<string, unknown> | null>): string[] {
  const count = new Map<string, number>();
  for (const g of grants) for (const ns of g?.keys() ?? []) count.set(ns, (count.get(ns) ?? 0) + 1);
  return [...count.keys()].sort(
    (a, b) =>
      (b === '*' ? 1 : 0) - (a === '*' ? 1 : 0) ||
      (count.get(b) ?? 0) - (count.get(a) ?? 0) ||
      byText(a, b)
  );
}

/** The widest a name may be before it truncates with `…`. */
export const NAME_CAP = 22;
const BAND_END = 50;
const GUTTER = '   ';

/** One display line; `row` is the index into the ordered rows when the line is selectable. */
export interface ListLine {
  parts: Part[];
  row?: number;
  kind: 'band' | 'key' | 'revoked-band' | 'revoked' | 'gap';
}

/** Terminal cells the parts take. */
const len = (parts: readonly Part[]) => parts.reduce((n, p) => n + cellWidth(p.text), 0);
/** A gap is one space: an empty Ink `Text` renders no row at all. */
const pad = (n: number): Part[] => (n > 0 ? [{ text: ' '.repeat(n) }] : []);

/** `── label ──── count`, the count ending at one shared column. */
function band(label: string, count: number, width: number, kind: ListLine['kind']): ListLine {
  const l = clean(label);
  const n = String(count);
  const rule = Math.max(2, Math.min(width, BAND_END) - (4 + cellWidth(l) + 2 + cellWidth(n)));
  const labelPart: Part =
    kind === 'band'
      ? { text: l, tone: 'text', bold: true }
      : { text: l, tone: 'dimMid', bold: true };
  return {
    parts: truncateParts(
      [
        { text: ' ── ', tone: 'dim' },
        labelPart,
        { text: ' ' },
        { text: '─'.repeat(rule), tone: 'dim' },
        { text: ' ' },
        { text: n, tone: 'dimMid' }
      ],
      width
    ),
    kind
  };
}

/** The majority spelling of each host (lowercased), a tie going to the spelling that sorts first. */
function hostLabels(rows: readonly AdminKeyRow[]): Map<string, string> {
  const spellings = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (isRevoked(r)) continue;
    const h = splitKid(r.kid)[1];
    const m = spellings.get(h.toLowerCase()) ?? new Map<string, number>();
    m.set(h, (m.get(h) ?? 0) + 1);
    spellings.set(h.toLowerCase(), m);
  }
  return new Map(
    [...spellings].map(([k, m]) => [
      k,
      [...m].sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))[0]?.[0] ?? k
    ])
  );
}

/** A hostless key's name and a dimMid short id sized to the cap; its kid when it has no name. */
function hostlessName(name: string, kid: string): Part[] {
  if (name === '') return [{ text: kid, tone: 'text' }];
  const n = Math.min(8, NAME_CAP - cellWidth(name) - 2);
  return n < 4
    ? [{ text: name, tone: 'text' }]
    : [
        { text: name, tone: 'text' },
        { text: ' ' },
        { text: `${cutToWidth(kid, n)}…`, tone: 'dimMid' }
      ];
}

const capPart = (c: string): Part =>
  c === 'a' ? { text: c, tone: 'warn', bold: true } : { text: c, tone: 'text' };

/** The ordered rows as display lines, each truncated to `width` (the view adds the cursor). */
export function listLines(rows: readonly AdminKeyRow[], width: number): ListLine[] {
  // Each namespace's capabilities as tokens, so a spelled-out `(name)` is toned as one.
  const grants = rows.map((r): ReadonlyMap<string, string[]> | null => {
    const g = rowGrant(r);
    return g === null
      ? null
      : new Map([...g].map(([ns, caps]) => [clean(ns), shortCaps(caps).map(clean)]));
  });
  const active = rows.flatMap((r, i) => (isRevoked(r) ? [] : [i]));
  const cols = namespaceColumns(active.map((i) => grants[i] ?? null));
  const colW = cols.map(
    (ns) =>
      cellWidth(ns) +
      1 +
      Math.max(1, ...active.map((i) => cellWidth(grants[i]?.get(ns)?.join('') ?? '')))
  );
  const labels = hostLabels(rows);

  // Name parts per active row: the agent and a dimMid `@host` when it differs from the band label,
  // or for a hostless key its name and a dimMid short id.
  const names = new Map<number, Part[]>();
  for (const i of active) {
    const r = rows[i] as AdminKeyRow;
    const [agent, host] = splitKid(r.kid);
    const parts: Part[] =
      host === NO_HOST
        ? hostlessName(clean(r.name), clean(r.kid))
        : [
            { text: clean(agent), tone: 'text' },
            ...(host === labels.get(host.toLowerCase())
              ? []
              : [{ text: `@${clean(host)}`, tone: 'dimMid' } as Part])
          ];
    names.set(i, truncateParts(parts, NAME_CAP));
  }
  const nameW = Math.max(4, ...[...names.values()].map(len));

  const grantParts = (i: number): Part[] => {
    const r = rows[i] as AdminKeyRow;
    const g = grants[i];
    if (g === null || g === undefined)
      return [{ text: clean(compactGrant(r.namespaces, r.capabilities)), tone: 'text' }];
    if (g.size === 0) return [{ text: '(none)', tone: 'dim' }];
    const last = cols.findLastIndex((ns) => g.has(ns));
    const out: Part[] = [];
    cols.slice(0, last + 1).forEach((ns, k) => {
      const caps = g.get(ns);
      if (k > 0) out.push({ text: '  ' });
      if (caps === undefined) {
        out.push(...pad(colW[k] as number));
        return;
      }
      const star = ns === '*';
      out.push({
        text: clean(ns),
        tone: star ? 'warn' : 'dimMid',
        ...(star ? { bold: true } : {})
      });
      out.push({ text: ' ' }, ...caps.map(capPart));
      if (k < last)
        out.push(...pad((colW[k] as number) - cellWidth(ns) - 1 - cellWidth(caps.join(''))));
    });
    return out;
  };

  const lines: ListLine[] = [];
  const push = (l: ListLine) => lines.push({ ...l, parts: truncateParts(l.parts, width) });
  const revokedCount = rows.length - active.length;
  let host: string | undefined;
  rows.forEach((r, i) => {
    if (isRevoked(r)) {
      if (lines.every((l) => l.kind !== 'revoked-band')) {
        if (lines.length > 0) push({ parts: [{ text: ' ' }], kind: 'gap' });
        lines.push(band('revoked', revokedCount, width, 'revoked-band'));
      }
      push({
        parts: [
          { text: GUTTER },
          { text: clean(r.kid), tone: 'dim', strike: true },
          { text: `  ${clean(String(r.revokedAt).slice(0, 10))}`, tone: 'dim' }
        ],
        row: i,
        kind: 'revoked'
      });
      return;
    }
    const key = splitKid(r.kid)[1].toLowerCase();
    if (key !== host) {
      if (host !== undefined) push({ parts: [{ text: ' ' }], kind: 'gap' });
      const count = active.filter(
        (j) => splitKid((rows[j] as AdminKeyRow).kid)[1].toLowerCase() === key
      ).length;
      lines.push(band(labels.get(key) ?? key, count, width, 'band'));
      host = key;
    }
    const name = names.get(i) as Part[];
    push({
      parts: [{ text: GUTTER }, ...name, ...pad(nameW - len(name) + 2), ...grantParts(i)],
      row: i,
      kind: 'key'
    });
  });
  return lines;
}

/** A line as the cursor row: a `glyph` gutter, then a selection band padded out to `width`. */
export function selectLine(line: ListLine, cursorGlyph: string, width = 0): Part[] {
  const body = line.parts.slice(1).map(
    (p): Part => ({
      text: p.text,
      bg: 'selection',
      tone: 'surface',
      bold: true,
      ...(p.strike ? { strike: true } : {})
    })
  );
  const fill = width - cellWidth(`${cursorGlyph}  `) - len(body);
  const last = body[body.length - 1];
  if (last !== undefined && fill > 0)
    body[body.length - 1] = { ...last, text: last.text + ' '.repeat(fill) };
  return [{ text: `${cursorGlyph}  `, tone: 'selection' }, ...body];
}
