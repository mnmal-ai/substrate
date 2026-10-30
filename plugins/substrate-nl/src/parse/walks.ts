/**
 * Walk composition (typed edge walks spec §6). A question that names fields
 * of other types through `fieldPhrases` rulings, compares them, windows them
 * in time, picks one neighbour or orders by a declared derive, is read as
 * walks from the seed type over the pack's declared crossRefs.
 *
 * Nothing here guesses. A part with no unique shortest crossRef path, or
 * that the grammar cannot express, is DROPPED with a reason, never
 * approximated; several equally short paths ask for clarification.
 */

import type { Dropped, NlFieldPhrase, PlanClause } from '@mnmal-ai/substrate/sdk';
import { own } from '../own.js';
import type { NamespaceRulings } from '../pack/rulings.js';
import type { NamespacePack } from '../pack/types.js';
import { type Comparison, parseComparison } from './compare.js';
import type { DateRange } from './time.js';

export interface Hop {
  dir: 'in' | 'out';
  /** The type the hop leaves. */
  from: string;
  /** The type that declares the crossRef. */
  owner: string;
  field: string;
  /** The type the hop reaches. */
  to: string;
}

export type Path = Hop[];

/** Every crossRef hop out of `type`, both directions, inside the pack's namespace. */
function hopsFrom(pack: NamespacePack, type: string): Hop[] {
  const out: Hop[] = [];
  for (const [owner, t] of Object.entries(pack.types)) {
    for (const [field, f] of Object.entries(t.fields)) {
      const target = f.kind === 'crossRef' ? f.target : undefined;
      if (target === undefined || target.namespace !== pack.namespace) continue;
      if (own(pack.types, target.type) === undefined) continue;
      if (owner === type) out.push({ dir: 'out', from: type, owner, field, to: target.type });
      if (target.type === type) out.push({ dir: 'in', from: type, owner, field, to: owner });
    }
  }
  return out;
}

/** All shortest crossRef paths from `from` to `to` (BFS, both directions, no type revisited). */
export function findPaths(pack: NamespacePack, from: string, to: string, maxHops = 3): Path[] {
  if (from === to) return [[]];
  let frontier: Path[] = [[]];
  for (let depth = 1; depth <= maxHops; depth++) {
    const next: Path[] = [];
    for (const p of frontier) {
      const at = p[p.length - 1]?.to ?? from;
      for (const h of hopsFrom(pack, at)) {
        if (h.to === from || p.some((x) => x.to === h.to)) continue;
        next.push([...p, h]);
      }
    }
    const done = next.filter((p) => p[p.length - 1]?.to === to);
    if (done.length > 0) return done;
    frontier = next;
  }
  return [];
}

export function pathLabel(ns: string, p: Path): string {
  return p
    .map((h) => (h.dir === 'in' ? `in ${ns}/${h.owner}.${h.field}` : `out ${h.field}`))
    .join(' > ');
}

// ---------------------------------------------------------------------------
// Claims: which words of the question are walk material.
// ---------------------------------------------------------------------------

export interface WalkToken {
  text: string;
  used: boolean;
}

type Span = [start: number, end: number];

export interface PhraseClaim {
  span: string;
  at: Span;
  entry: NlFieldPhrase;
  /** From `entry.field` ('Type.field'). */
  type?: string;
  field?: string;
}

export interface CompareClaim {
  span: string;
  at: Span;
  cmp: Comparison;
  subject?: PhraseClaim;
  object?: PhraseClaim;
}

export interface PickClaim {
  span: string;
  at: Span;
  phrase: PhraseClaim;
  kind: 'latest' | 'max' | 'min';
}

export interface WalkClaims {
  phrases: PhraseClaim[];
  compares: CompareClaim[];
  picks: PickClaim[];
  derives: PhraseClaim[];
  dropped: Dropped[];
}

const PICK_WORDS: Record<string, PickClaim['kind']> = {
  latest: 'latest',
  current: 'latest',
  'most recent': 'latest',
  highest: 'max',
  best: 'max',
  lowest: 'min',
  cheapest: 'min'
};
const DERIVE_WORDS = new Set(['margin', 'spread', 'gap']);
/** A comparative the lexicon does not cover. */
const COMPARATIVE = /%$|^\d+(?:\.\d+)?(?:x|×)$|^(?:than|twice|double|half|triple)$/;

const text = (tokens: WalkToken[], [s, e]: Span) =>
  tokens
    .slice(s, e + 1)
    .map((t) => t.text)
    .join(' ');
const range = ([s, e]: Span) => Array.from({ length: e - s + 1 }, (_, k) => s + k);
const take = (tokens: WalkToken[], [s, e]: Span) => {
  for (let i = s; i <= e; i++) (tokens[i] as WalkToken).used = true;
};

/**
 * Claims field phrases, pick words, "by <derive>" and comparisons. Only a
 * namespace that declares `fieldPhrases` composes walks, so nothing changes
 * for one that does not.
 */
export function claimWalkParts(
  tokens: WalkToken[],
  rulings: NamespaceRulings,
  glue: Set<string>
): WalkClaims {
  const claims: WalkClaims = { phrases: [], compares: [], picks: [], derives: [], dropped: [] };
  const table = rulings.fieldPhrases;
  if (table === undefined || Object.keys(table).length === 0) return claims;

  // Field phrases, longest first.
  for (let n = 6; n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const at: Span = [i, i + n - 1];
      if (tokens.slice(i, i + n).some((t) => t.used)) continue;
      const entry = own(table, text(tokens, at));
      if (entry === undefined) continue;
      take(tokens, at);
      const dot = entry.field?.indexOf('.') ?? -1;
      claims.phrases.push({
        span: text(tokens, at),
        at,
        entry,
        ...(entry.field !== undefined && dot > 0
          ? { type: entry.field.slice(0, dot), field: entry.field.slice(dot + 1) }
          : {})
      });
    }
  }
  claims.phrases.sort((x, y) => x.at[0] - y.at[0]);

  // "the latest offer": a pick word directly before a field phrase.
  for (const p of claims.phrases) {
    const s = p.at[0];
    for (const [word, kind] of Object.entries(PICK_WORDS)) {
      const n = word.split(' ').length;
      const at: Span = [s - n, s - 1];
      if (at[0] < 0 || tokens.slice(at[0], s).some((t) => t.used)) continue;
      if (text(tokens, at) !== word) continue;
      take(tokens, at);
      claims.picks.push({ span: word, at, phrase: p, kind });
      break;
    }
  }

  // "by margin": a declared derive orders; an undeclared one is dropped.
  for (const p of claims.phrases) {
    if (p.entry.derive === undefined) continue;
    const by = tokens[p.at[0] - 1];
    if (by?.text === 'by' && !by.used) {
      by.used = true;
      claims.derives.push(p);
    } else {
      claims.dropped.push({
        span: p.span,
        reason: `"${p.span}" is a derived value; it orders a list only as "by ${p.span}"`
      });
    }
  }
  tokens.forEach((t, i) => {
    const next = tokens[i + 1];
    if (t.text !== 'by' || t.used || next === undefined || next.used) return;
    if (!DERIVE_WORDS.has(next.text)) return;
    t.used = true;
    next.used = true;
    claims.dropped.push({
      span: `by ${next.text}`,
      reason: `no derived value "${next.text}" is declared for this namespace`
    });
  });

  // Comparisons, with the phrase before them as subject and the one after as object.
  const phraseAt = (i: number) => claims.phrases.find((p) => p.at[0] === i);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]?.used === true) continue;
    const cmp = parseComparison(tokens.slice(i).map((t) => t.text));
    if (cmp === null) continue;
    const at: Span = [i, i + cmp.length - 1];
    // "25% slower": the comparison word may itself be the subject's phrase.
    const usedAt = range(at).filter((k) => tokens[k]?.used === true);
    const wordPhrase = usedAt.length === 1 ? phraseAt(usedAt[0] as number) : undefined;
    if (
      usedAt.length > 0 &&
      (wordPhrase === undefined ||
        wordPhrase.at[1] !== usedAt[0] ||
        !/^(?:slower|faster)$/.test(wordPhrase.span))
    )
      continue;
    let object: PhraseClaim | undefined;
    if (cmp.value === undefined) {
      // "over the lowest asking price": glue and pick words may sit between.
      const pickAt = new Set(claims.picks.flatMap((k) => range(k.at)));
      let j = at[1] + 1;
      while (j < tokens.length && phraseAt(j) === undefined) {
        const t = tokens[j] as WalkToken;
        if (!(glue.has(t.text) && !t.used) && !pickAt.has(j)) break;
        j++;
      }
      object = phraseAt(j);
      if (object === undefined) continue;
    }
    // The subject sits right before the comparison, with only glue between ("offer is over 50").
    const before = [...claims.phrases].reverse().find((p) => p.at[1] < i);
    const adjacent =
      before !== undefined &&
      tokens.slice(before.at[1] + 1, i).every((t) => !t.used && glue.has(t.text)) &&
      before.field !== undefined &&
      before.entry.value === undefined;
    const subject = wordPhrase ?? (adjacent ? before : undefined);
    for (let k = i; k <= at[1]; k++) (tokens[k] as WalkToken).used = true;
    const span = text(tokens, at);
    claims.compares.push({
      span,
      at,
      cmp,
      ...(subject !== undefined ? { subject } : {}),
      ...(object !== undefined ? { object } : {})
    });
    i = at[1];
  }
  return claims;
}

/** Comparatives the lexicon did not claim: dropped, never approximated. */
export function dropComparatives(tokens: WalkToken[], dropped: Dropped[]): void {
  tokens.forEach((t, i) => {
    if (t.used || !COMPARATIVE.test(t.text)) return;
    const prev = tokens[i - 1];
    const words = prev !== undefined && !prev.used && t.text === 'than' ? [prev, t] : [t];
    for (const w of words) w.used = true;
    dropped.push({
      span: words.map((w) => w.text).join(' '),
      reason: 'this comparison is not in the comparison lexicon'
    });
  });
}

// ---------------------------------------------------------------------------
// Composition: claims -> walk clauses for one seed type.
// ---------------------------------------------------------------------------

/** A where clause and its plan clauses, with plan paths relative to the clause. */
export interface Part {
  clause: Record<string, unknown>;
  plan: PlanClause[];
}

interface Walk {
  type: string;
  path: Path;
  alias?: string;
  pick?: { kind: 'latest' | 'max' | 'min'; by: string; source: string };
  filters: Part[];
  window: Part[];
  excludes: Part[];
  /** Phrases already applied, so a phrase said twice adds its ruling's clauses once. */
  applied: Set<string>;
}

export interface ComposeInput {
  pack: NamespacePack;
  rulings: NamespaceRulings;
  seed: string;
  claims: WalkClaims;
  /** Types the question names, with the first token index of each mention. */
  mentions: Array<{ type: string; span: string; at: Span }>;
  time: { span: string; range: DateRange; at: Span } | null;
}

export interface Composed {
  /** Clauses for the seed's where, after its own. */
  parts: Part[];
  params: Record<string, unknown>;
  /** Plan clauses outside `where` (derive, orderBy). */
  plan: PlanClause[];
  dropped: Dropped[];
  /** The time window was not bound to a walk: the seed takes it as before. */
  timeOnSeed: boolean;
  /** True when anything was composed, so the frame needs the walk grammar. */
  walked: boolean;
}

const filter = (clause: Record<string, unknown>, path: string[], label: string): Part => ({
  clause,
  plan: [{ path: [...path, label], kind: 'filter', served: false }]
});

/** Clauses as one where: the clause itself, or an AND with plan paths re-rooted. */
export function andOf(
  parts: Part[]
): { where: Record<string, unknown>; plan: PlanClause[] } | null {
  if (parts.length === 0) return null;
  if (parts.length === 1)
    return { where: (parts[0] as Part).clause, plan: (parts[0] as Part).plan };
  return {
    where: { AND: parts.map((p) => p.clause) },
    plan: parts.flatMap((p, i) =>
      p.plan.map((c) => ({ ...c, path: ['AND', String(i), ...c.path] }))
    )
  };
}

/** Binding names: the type name's capitals ("Listing" -> L, "CiRun" -> CR). */
function aliasFor(type: string, taken: Set<string>): string {
  const base = type.replace(/[^A-Z]/g, '') || type.slice(0, 1).toUpperCase();
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
  taken.add(name);
  return name;
}

export function compose(input: ComposeInput): Composed | { clarify: string } {
  const { pack, rulings, seed, claims } = input;
  const ns = pack.namespace;
  const dropped: Dropped[] = [...claims.dropped];
  const seedParts: Part[] = [];
  const walks = new Map<string, Walk>();
  const dead = new Set<string>();
  let clarify: string | null = null;
  const timeField = (type: string) => own(rulings.timeField, type) ?? 'createdAt';

  const walkTo = (type: string, span: string): Walk | null => {
    const known = walks.get(type);
    if (known !== undefined) return known;
    if (dead.has(type)) return null;
    const paths = findPaths(pack, seed, type);
    if (paths.length === 0) {
      dead.add(type);
      dropped.push({ span, reason: `no crossRef path from ${seed} to ${type} within 3 hops` });
      return null;
    }
    if (paths.length > 1) {
      clarify ??= `several equally short paths from ${seed} to ${type}: ${paths
        .map((p) => pathLabel(ns, p))
        .join('; ')}`;
      dead.add(type);
      return null;
    }
    const w: Walk = {
      type,
      path: paths[0] as Path,
      filters: [],
      window: [],
      excludes: [],
      applied: new Set()
    };
    walks.set(type, w);
    return w;
  };

  /** Where a phrase's own clauses go: the seed, a walk, or nowhere (dropped). */
  const home = (p: PhraseClaim): { seed: true } | Walk | null => {
    if (p.type === undefined) return null;
    if (p.type === seed) return { seed: true };
    return walkTo(p.type, p.span);
  };
  const isWalk = (h: { seed: true } | Walk): h is Walk => !('seed' in h);

  // Phrases: equality bindings and implicit filters.
  for (const p of claims.phrases) {
    if (p.field === undefined || p.type === undefined) continue;
    const h = home(p);
    if (h === null) continue;
    if (isWalk(h) && h.applied.has(p.span)) continue;
    const parts: Part[] = [];
    if (p.entry.value !== undefined)
      parts.push(filter({ [p.field]: { eq: p.entry.value } }, [p.field], `ruling:${p.span}`));
    const excl = p.entry.exclude;
    if (excl !== undefined) {
      const part = filter({ NOT: excl }, ['NOT'], `ruling:${p.span}`);
      if (isWalk(h)) h.excludes.push(part);
      else seedParts.push(part);
    }
    if (isWalk(h)) {
      h.filters.push(...parts);
      h.applied.add(p.span);
    } else seedParts.push(...parts);
  }

  // Picks: a word, else the phrase's ruling default, else any.
  const picked = new Map<PhraseClaim, PickClaim['kind'] | undefined>();
  for (const k of claims.picks) picked.set(k.phrase, k.kind);
  for (const p of claims.phrases) {
    if (p.type === undefined || p.type === seed || p.field === undefined) continue;
    const w = walks.get(p.type);
    if (w === undefined) continue;
    const kind = picked.get(p) ?? p.entry.pick;
    if (kind === undefined) continue;
    const source = picked.has(p) ? `"${claims.picks.find((k) => k.phrase === p)?.span}"` : 'ruling';
    const pick = { kind, by: kind === 'latest' ? timeField(p.type) : p.field, source };
    if (w.pick !== undefined && (w.pick.kind !== pick.kind || w.pick.by !== pick.by)) {
      clarify ??= `${w.pick.source} and ${pick.source} pick different ${p.type} rows`;
      continue;
    }
    w.pick = pick;
  }
  for (const k of claims.picks) {
    if (k.phrase.type === seed)
      dropped.push({
        span: `${k.span} ${k.phrase.span}`,
        reason: `"${k.span}" picks one neighbour, and ${seed} is the type being asked about`
      });
  }

  // Comparisons. Two mentions of one walked type each compared are two existentials,
  // never merged into one walk: which reading was meant is asked.
  const mentionOf = new Map<Walk, { at: number; text: string }>();
  const mention = (w: Walk, p: PhraseClaim, text: string) => {
    const known = mentionOf.get(w);
    if (known === undefined) mentionOf.set(w, { at: p.at[0], text });
    else if (known.at !== p.at[0])
      clarify ??= `"${known.text}" and "${text}": one ${w.type} meeting both, or two different ${w.type} rows?`;
  };
  for (const c of claims.compares) {
    if (c.cmp.invalid !== undefined) {
      dropped.push({ span: c.span, reason: c.cmp.invalid });
      continue;
    }
    const s = c.subject;
    if (s?.type === undefined || s.field === undefined) {
      dropped.push({
        span: c.span,
        reason: 'no field phrase directly before it to compare'
      });
      continue;
    }
    const sh = home(s);
    if (sh === null) {
      dropped.push({ span: c.span, reason: `its field "${s.span}" was dropped` });
      continue;
    }
    let operand: unknown;
    let kind: PlanClause['kind'] = 'filter';
    if (c.cmp.value !== undefined) operand = c.cmp.value;
    else {
      const o = c.object;
      if (o?.type === undefined || o.field === undefined) {
        dropped.push({ span: c.span, reason: 'nothing to compare against' });
        continue;
      }
      let ref: string;
      if (o.type === seed) ref = `$.${o.field}`;
      else {
        if (o.type === s.type) {
          dropped.push({
            span: `${c.span} ${o.span}`,
            reason: `comparing two fields of one ${o.type} is not expressible`
          });
          continue;
        }
        const ow = walkTo(o.type, o.span);
        if (ow === null) {
          dropped.push({ span: c.span, reason: `its operand "${o.span}" was dropped` });
          continue;
        }
        mention(ow, o, `${c.span} ${o.span}`);
        if (ow.path.length > 1 || ow.pick !== undefined) {
          dropped.push({
            span: `${c.span} ${o.span}`,
            reason:
              ow.pick !== undefined
                ? `a picked ${o.type} cannot be referenced`
                : `a comparison against a ${ow.path.length}-hop walk is not expressible`
          });
          continue;
        }
        ref = `${o.type}\u0000${o.field}`;
      }
      operand = {
        $ref: ref,
        ...(c.cmp.times !== undefined ? { times: c.cmp.times } : {}),
        ...(c.cmp.plus !== undefined ? { plus: c.cmp.plus } : {})
      };
      kind = 'ref';
    }
    const part: Part = {
      clause: { [s.field]: { [c.cmp.op]: operand } },
      plan: [
        {
          path: [s.field, c.cmp.op, ...(kind === 'ref' ? [] : [`compare:${c.span}`])],
          kind,
          served: kind === 'ref'
        }
      ]
    };
    if (isWalk(sh)) {
      mention(sh, s, `${s.span} ${c.span}`);
      sh.filters.push(part);
    } else seedParts.push(part);
  }

  // The time window binds to the type mentioned nearest it; a tie between two types asks.
  let timeOnSeed = input.time !== null;
  if (input.time !== null) {
    const t = input.time.at;
    const dist = ([s, e]: Span) => (s > t[1] ? s - t[1] : e < t[0] ? t[0] - e : 0);
    const near = new Map<string, number>();
    const note = (type: string | undefined, at: Span) => {
      if (type === undefined) return;
      near.set(type, Math.min(near.get(type) ?? Number.POSITIVE_INFINITY, dist(at)));
    };
    for (const p of claims.phrases) note(p.type, p.at);
    for (const m of input.mentions) note(m.type, m.at);
    const best = Math.min(...near.values());
    const nearest = [...near].filter(([, d]) => d === best).map(([type]) => type);
    if (nearest.length > 1) {
      clarify ??= `"${input.time.span}" could window ${nearest.sort().join(' or ')}`;
    } else if (nearest.length === 1 && nearest[0] !== seed) {
      const type = nearest[0] as string;
      const w = walkTo(type, input.time.span);
      timeOnSeed = false;
      if (w !== null) {
        const field = timeField(type);
        const ruled = own(rulings.timeField, type) !== undefined;
        w.window.push(
          filter(
            { [field]: { gte: input.time.range.gte, lt: input.time.range.lt } },
            [field],
            `window:${input.time.span}${ruled ? '' : ` on ${field} (default)`}`
          )
        );
      }
    }
  }

  // Derived orderings over the seed row.
  const params: Record<string, unknown> = {};
  const plan: PlanClause[] = [];
  for (const d of claims.derives) {
    const spec = d.entry.derive;
    if (spec === undefined) continue;
    const [op, operands] = Object.entries(spec)[0] as ['diff' | 'ratio', [string, string]];
    const onSeed = operands.every((o) => o.startsWith(`${seed}.`));
    if (!onSeed) {
      dropped.push({
        span: `by ${d.span}`,
        reason: `"${d.span}" derives from fields of another type than ${seed}`
      });
      continue;
    }
    const name = d.span.replace(/[^a-z0-9]+(.)?/g, (_, ch: string | undefined) =>
      (ch ?? '').toUpperCase()
    );
    params.derive = {
      ...((params.derive as object | undefined) ?? {}),
      [name]: { [op]: operands.map((o) => `$.${o.slice(seed.length + 1)}`) }
    };
    params.orderBy = [{ [`$${name}`]: 'desc' }];
    plan.push(
      { path: ['derive', name, `ruling:${d.span}`], kind: 'derive', served: false },
      { path: ['orderBy', '0', `$${name}`, 'desc (default)'], kind: 'order', served: false }
    );
  }

  if (clarify !== null) return { clarify };

  // Bindings: every unpicked one-hop walk, so comparisons can name it.
  const taken = new Set<string>();
  const ordered = [...walks.values()].sort((x, y) =>
    hopKey(ns, x.path[0] as Hop).localeCompare(hopKey(ns, y.path[0] as Hop))
  );
  for (const w of ordered)
    if (w.path.length === 1 && w.pick === undefined) w.alias = aliasFor(w.type, taken);
  const aliasOf = new Map(ordered.map((w) => [w.type, w.alias]));
  const resolveRefs = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(resolveRefs);
    if (typeof v !== 'object' || v === null) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === '$ref' && typeof x === 'string' && x.includes('\u0000')) {
        const [type, field] = x.split('\u0000') as [string, string];
        out[k] = `${aliasOf.get(type)}.${field}`;
      } else out[k] = resolveRefs(x);
    }
    return out;
  };

  const parts: Part[] = [...seedParts];
  for (const w of ordered) parts.push(walkPart(ns, w));
  const composed = parts.map((p) => ({ ...p, clause: resolveRefs(p.clause) as Part['clause'] }));
  return {
    parts: composed,
    params,
    plan,
    dropped,
    timeOnSeed,
    walked:
      walks.size > 0 ||
      seedParts.some((p) => p.plan.some((c) => c.kind === 'ref')) ||
      plan.length > 0
  };
}

function hopKey(ns: string, h: Hop): string {
  return h.dir === 'in' ? `${ns}/${h.owner}.${h.field}` : h.field;
}

/** One walk as a (possibly nested) `_walk` clause. */
function walkPart(ns: string, w: Walk): Part {
  const inner = andOf([...w.filters, ...w.window, ...w.excludes]);
  const label =
    w.pick === undefined ? 'any' : `pick:${w.pick.kind}(${w.pick.by}) from ${w.pick.source}`;
  let node: Record<string, unknown> = {
    ...(w.alias !== undefined ? { as: w.alias } : {}),
    ...edge(ns, w.path[w.path.length - 1] as Hop),
    ...(inner !== null ? { where: inner.where } : {}),
    ...(w.pick !== undefined ? { pick: { [w.pick.kind]: w.pick.by } } : {})
  };
  let plan: PlanClause[] = [
    {
      path: ['_walk', hopKey(ns, w.path[w.path.length - 1] as Hop), label],
      kind: 'hop',
      served: true
    },
    ...(inner?.plan ?? []).map((c) => ({ ...c, path: ['_walk', 'where', ...c.path] }))
  ];
  for (let i = w.path.length - 2; i >= 0; i--) {
    const h = w.path[i] as Hop;
    node = { ...edge(ns, h), where: { _walk: node } };
    plan = [
      { path: ['_walk', hopKey(ns, h), 'any'], kind: 'hop', served: true },
      ...plan.map((c) => ({ ...c, path: ['_walk', 'where', ...c.path] }))
    ];
  }
  return { clause: { _walk: node }, plan };
}

function edge(ns: string, h: Hop): Record<string, string> {
  return h.dir === 'in' ? { in: `${ns}/${h.owner}.${h.field}` } : { out: h.field };
}
