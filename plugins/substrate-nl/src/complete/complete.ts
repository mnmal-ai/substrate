/**
 * Keystroke-speed completion over a served namespace pack. Pure, and imports
 * types only, so the `@mnmal-ai/substrate-nl/complete` subpath runs in a browser
 * or a TUI without pulling the plugin's server dependencies.
 */
import type { NamespaceRulings } from '../pack/rulings.js';
import type { NamespacePack } from '../pack/types.js';

export type CompletePack = NamespacePack & { rulings?: NamespaceRulings };

export interface NlSuggestion {
  replace: [start: number, end: number];
  insert: string;
  label: string;
  detail?: string;
  score: number;
}

interface Pool {
  insert: string;
  label: string;
  detail?: string;
}

/** Own-key lookup: inherited names (`constructor`, `__proto__`) are not entries. Inlined so this module imports types only. */
const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined =>
  rec !== undefined && Object.hasOwn(rec, key) ? rec[key] : undefined;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const DSL_OPERATORS: Record<string, string> = {
  gte: '>=',
  lte: '<=',
  gt: '>',
  lt: '<',
  between: '..',
  neq: '!',
  contains: '~'
};
const OPERATOR_FORM = /^[<>!~.]/;

const isHigh = (u: number) => u >= 0xd800 && u <= 0xdbff;
const isLow = (u: number) => u >= 0xdc00 && u <= 0xdfff;

/** The token around `cursor`: [start, end). Whitespace-delimited; a trailing `field:` stays one token. */
function tokenAt(draft: string, cursor: number): [number, number] {
  let c = Number.isFinite(cursor) ? Math.max(0, Math.min(Math.trunc(cursor), draft.length)) : 0;
  // A cursor between the halves of a surrogate pair moves back to the code-point boundary.
  if (c > 0 && c < draft.length && isHigh(draft.charCodeAt(c - 1)) && isLow(draft.charCodeAt(c)))
    c--;
  let start = c;
  while (start > 0 && !/\s/.test(draft[start - 1] as string)) start--;
  let end = c;
  while (end < draft.length && !/\s/.test(draft[end] as string)) end++;
  return [start, end];
}

function typeIn(words: string[], pack: CompletePack): string | undefined {
  const aliases = pack.rulings?.typeAliases ?? {};
  for (const w of words) {
    const lw = w.toLowerCase();
    const aliased = own(aliases, lw);
    if (aliased !== undefined) return aliased;
    for (const t of Object.values(pack.types)) if (t.phrases.includes(lw)) return t.name;
  }
  return undefined;
}

function rank(prefix: string, pool: Pool[], replace: [number, number]): NlSuggestion[] {
  const p = prefix.toLowerCase();
  const seen = new Set<string>();
  const out: NlSuggestion[] = [];
  for (const x of pool) {
    const k = x.insert.toLowerCase();
    if (seen.has(x.insert) || k === p) continue;
    const score = k.startsWith(p) ? 2 : p.length > 0 && k.includes(p) ? 1 : 0;
    if (score === 0) continue;
    seen.add(x.insert);
    out.push({
      replace,
      insert: x.insert,
      label: x.label,
      ...(x.detail !== undefined ? { detail: x.detail } : {}),
      score
    });
  }
  return out.sort(
    (a, b) => b.score - a.score || a.insert.length - b.insert.length || cmp(a.insert, b.insert)
  );
}

export function complete(draft: string, cursor: number, pack: CompletePack): NlSuggestion[] {
  if (draft.trim() === '') return [];
  const [start, end] = tokenAt(draft, cursor);
  const token = draft.slice(start, end);
  const before = draft
    .slice(0, start)
    .split(/\s+/)
    .filter((w) => w !== '');
  const type = typeIn(before, pack);

  const colon = token.indexOf(':');
  if (colon > 0 && type !== undefined) {
    const typed = token.slice(0, colon);
    const fieldName = own(pack.rulings?.fieldAliases, typed) ?? typed;
    const f = own(own(pack.types, type)?.fields, fieldName);
    if (f === undefined) return [];
    const valueStart = start + colon + 1;
    const pool: Pool[] = [
      ...(f.enum ?? []).map((v) => ({ insert: v, label: v })),
      ...Object.entries(f.aliases ?? {}).map(([alias, canon]) => ({
        insert: alias,
        label: `${alias} → ${canon}`
      })),
      ...Object.entries(pack.values)
        .filter(([, refs]) => refs.some((r) => r.type === type && r.field === fieldName))
        .map(([v, refs]) => ({ insert: refs.find((r) => r.type === type)?.value ?? v, label: v }))
    ];
    const prefix = token.slice(colon + 1);
    if (OPERATOR_FORM.test(prefix)) return [];
    if (prefix === '') {
      const replace: [number, number] = [valueStart, end];
      const seen = new Set<string>();
      const values = pool
        .filter((x) => !seen.has(x.insert) && seen.add(x.insert))
        .sort((a, b) => cmp(a.insert, b.insert))
        .map((x) => ({ replace, insert: x.insert, label: x.label, score: 2 }));
      const ops = f.operators.flatMap((op) => {
        const form = own(DSL_OPERATORS, op);
        return form === undefined
          ? []
          : [{ replace, insert: form, label: form, detail: op, score: 1 }];
      });
      return [...values, ...ops];
    }
    return rank(prefix, pool, [valueStart, end]);
  }

  if (token === '') return [];
  const pool: Pool[] = [];
  if (type === undefined) {
    for (const t of Object.values(pack.types))
      for (const ph of t.phrases)
        pool.push({ insert: ph, label: ph, detail: `${pack.namespace}/${t.name}` });
    for (const [alias, t] of Object.entries(pack.rulings?.typeAliases ?? {}))
      pool.push({ insert: alias, label: alias, detail: `${pack.namespace}/${t}` });
  } else {
    for (const f of Object.values(own(pack.types, type)?.fields ?? {})) {
      if (f.kind === 'metadata') continue;
      pool.push({ insert: `${f.name}:`, label: f.name, detail: f.operators.join(' ') });
      for (const ph of f.phrases)
        if (ph !== f.name) pool.push({ insert: `${f.name}:`, label: ph, detail: f.name });
    }
    for (const [alias, canon] of Object.entries(pack.rulings?.fieldAliases ?? {}))
      pool.push({ insert: `${alias}:`, label: `${alias} → ${canon}`, detail: canon });
    for (const [word, preds] of Object.entries(pack.rulings?.valueAliases ?? {})) {
      const p = preds[0];
      if (!/\s/.test(word) && p !== undefined)
        pool.push({ insert: word, label: word, detail: `${p.type}.${p.field}` });
    }
  }
  for (const [v, refs] of Object.entries(pack.values)) {
    if (refs.some((r) => r.field === 'project'))
      pool.push({ insert: refs[0]?.value ?? v, label: refs[0]?.value ?? v, detail: 'project' });
  }
  return rank(token, pool, [start, end]);
}
