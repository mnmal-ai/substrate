/**
 * Deterministic NL -> frame parser. Recognisers claim spans of the question
 * against a namespace pack and the namespace's rulings; assembly turns the
 * claims into candidate frames. The same question, pack, rulings and context
 * always give the same result, and every clause in a produced frame is tied
 * to the words that caused it.
 *
 * `resolved` means one candidate and nothing left over that could change it.
 * Anything else is for the next tier to judge: this parser never guesses.
 */

import type { Dropped, NlEvidence, NlParseStatus, PlanClause } from '@mnmal-ai/substrate/sdk';
import { own } from '../own.js';
import type { NamespaceRulings, ValueAlias } from '../pack/rulings.js';
import type { NamespacePack, PackField } from '../pack/types.js';
import { pluralize, splitWords } from '../pack/words.js';
import { type DateRange, rangeFor } from './time.js';
import {
  andOf,
  type Composed,
  claimWalkParts,
  compose,
  dropComparatives,
  type Part
} from './walks.js';

export interface ParseContext {
  /** The asking project: the default scope is this project or none. */
  project?: string;
  /** "now" for relative dates, ISO-8601 with offset. */
  asOf: string;
  /** Type a bare `#N` refers to. */
  defaultIdType?: string;
  rulings?: NamespaceRulings;
  /** Read the question as this type only: a judge's choice, applied deterministically. */
  forceType?: string;
}

export type Evidence = NlEvidence;

export interface Candidate {
  type: string;
  frame: Record<string, { params: Record<string, unknown> }>;
  answer: string;
  evidence: Evidence[];
  /** Content words this reading leaves unexplained. */
  residual: string[];
  /** What the frame does, clause by clause: walks, comparisons, windows, rulings' implicit filters. */
  plan: PlanClause[];
  /** Parts of the question this reading could not express. Dropped, never approximated. */
  dropped: Dropped[];
  /**
   * A count, an aggregate, a pick-one (of the seed or a walk) or a `$ref`
   * comparison: a dropped filter would change its answer, so it is `unknown`.
   */
  strict: boolean;
}

export type ParseStatus = NlParseStatus;

export interface ParseResult {
  status: ParseStatus;
  candidates: Candidate[];
  /** What an unparsed question was understood to say, for the judge. */
  evidence?: Evidence[];
  /** Content words the best reading leaves unexplained. */
  residual: string[];
  reason?: string;
}

/** Words that carry no query meaning on their own. */
const GLUE = new Set(
  (
    'a about again all am an and any anything are as at be been by can could current did do does for from get give ' +
    "go got have hey i i'm in is it it's let let's lets list me more my need needs next now of ok on or our " +
    'please raised see show so some still talk tell that the their them there these this those to us want was ' +
    "we we've we'd what what's whats when where which who whose why will with would you your yo up " +
    "thought handled judgement judgment make nice there's anymore stuff things few runs run ran lives " +
    // Authoring verbs without "by X" do not change the query.
    'wrote write written created made filed logged'
  ).split(/\s+/)
);

/** First word of an imperative edit, which substrate-nl refuses: it only reads. */
const MUTATIONS = new Set(
  'close delete remove archive merge approve approved create add update set mark rename reopen assign ack deploy cut land'.split(
    ' '
  )
);
const LEADING_FILLER = new Set(
  "please can could would you go ahead let let's lets hey ok yo so and then".split(' ')
);
const STATE_CUES = new Set(
  "what what's whats show talk tell status is describe about see which who".split(' ')
);
const CLOSE_VERBS = new Set(
  'close closed closing done finished completed resolved ship shipped drop dropped cancel cancelled abandoned'.split(
    ' '
  )
);
const UPDATE_VERBS = new Set('updated changed edited touched'.split(' '));
/** Terminal status values: matching one is a question about the past. */
const TERMINAL = ['closed', 'complete', 'completed', 'done', 'resolved', 'superseded'];
/** Terminal statuses a closing verb selects: finished, not merely replaced. */
const CLOSED = ['closed', 'complete', 'completed', 'done', 'resolved'];
const HISTORY_WORDS = new Set(
  'archived archive history historical ever previously past trend trends over-time all-time total'.split(
    ' '
  )
);
/** Connectives a composed reading cannot honour; dropped while composing walks. */
const CONNECTIVES = new Set(['or', 'not', 'no', 'every']);
const LATEST = new Set('latest newest recent last'.split(' '));
const OLDEST = new Set('oldest earliest first'.split(' '));
const AUTHOR_VERBS = new Set(
  'raised created written filed authored opened made sent logged'.split(' ')
);
const BUILTIN_FIELD_ALIASES: Record<string, string> = { author: 'createdById' };

interface Token {
  text: string;
  used: boolean;
}

interface TypeEntry {
  phrase: string;
  types: string[];
  plural: boolean;
}

interface ValueClaim {
  span: string;
  /** Pack value key, or null when a ruling alias supplied the predicate. */
  key: string | null;
  alias?: ValueAlias[];
  /** Token indices, so a field word next to it can be credited. */
  at: number[];
}

/** An inline `field:value` clause, taken literally and validated per reading. */
interface FieldClause {
  span: string;
  field: string;
  op: string;
  /** Raw values, before coercion to the field's type. */
  values: string[];
}

/** `field:value`, `field:[a,b]`, `field:"two words"`; optionally wrapped in quotes. A clock time starts with a digit. */
const CLAUSE = /(['"]?)\b([A-Za-z][A-Za-z0-9]*):(\[[^\]]*\]|"[^"]*"|[^\s,'"]+)\1/g;

function parseClause(span: string, field: string, raw: string): FieldClause {
  const unquote = (v: string) => v.trim().replace(/^["']|["']$/g, '');
  if (raw.startsWith('[')) {
    return {
      span,
      field,
      op: 'in',
      values: raw
        .slice(1, -1)
        .split(',')
        .map(unquote)
        .filter((v) => v.length > 0)
    };
  }
  if (raw.startsWith('"')) return { span, field, op: 'eq', values: [unquote(raw)] };
  const cmp = /^(>=|<=|>|<)(.+)$/.exec(raw);
  if (cmp !== null) {
    const op = { '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' }[
      cmp[1] as '>' | '>=' | '<' | '<='
    ];
    return { span, field, op, values: [cmp[2] as string] };
  }
  const range = /^(.+)\.\.(.+)$/.exec(raw);
  if (range !== null)
    return { span, field, op: 'between', values: [range[1] as string, range[2] as string] };
  if (raw.startsWith('!')) return { span, field, op: 'neq', values: [raw.slice(1)] };
  if (raw.startsWith('~')) return { span, field, op: 'contains', values: [raw.slice(1)] };
  return { span, field, op: 'eq', values: [raw] };
}

export function parseQuestion(
  question: string,
  pack: NamespacePack,
  ctx: ParseContext
): ParseResult {
  const rulings = ctx.rulings ?? {};
  const clauses: FieldClause[] = [];
  const prose = question.replace(CLAUSE, (span, _q: string, field: string, raw: string) => {
    clauses.push(parseClause(span, field, raw));
    return ' ';
  });
  const tokens: Token[] = (
    prose
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .match(/\$\d+(?:\.\d+)?|\d+(?:\.\d+)?[%×]|#\d+|[a-z0-9@[][a-z0-9@._'\]-]*/g) ?? []
  )
    .map((t) => t.replace(/[.'-]+$/, '').replace(/'s$/, ''))
    .filter((t) => t.length > 0)
    .map((text) => ({ text, used: false }));
  const words = tokens.map((t) => t.text);
  const evidence: Evidence[] = [];

  // --- refusal: an imperative edit ---
  const lead = words.find((w) => !LEADING_FILLER.has(w));
  if (lead !== undefined && MUTATIONS.has(lead)) {
    return {
      status: 'refuse',
      candidates: [],
      residual: [],
      reason: `"${lead}" is an edit; substrate-nl answers questions and does not change data`
    };
  }
  // --- value aliases from the rulings (multi-word, so before type phrases) ---
  const values: ValueClaim[] = [];
  claimNgrams(tokens, 4, (key, at) => {
    const alias = own(rulings.valueAliases, key);
    if (alias === undefined) return false;
    values.push({ span: key, key: null, alias, at });
    return true;
  });

  // --- walk material: field phrases, pick words, "by <derive>", comparisons ---
  const walkClaims = claimWalkParts(tokens, rulings, GLUE);

  // --- type phrases: rulings first, then the pack's, longest first ---
  const mentioned = new Map<string, { span: string; plural: boolean; at: [number, number] }>();
  for (const entry of buildTypeIndex(pack, rulings)) {
    const n = entry.phrase.split(' ').length;
    for (let i = 0; i + n <= tokens.length; i++) {
      const slice = tokens.slice(i, i + n);
      if (slice.some((t) => t.used) || slice.map((t) => t.text).join(' ') !== entry.phrase)
        continue;
      for (const t of slice) t.used = true;
      for (const type of entry.types)
        mentioned.set(type, {
          span: entry.phrase,
          plural: entry.plural,
          at: mentioned.get(type)?.at ?? [i, i + n - 1]
        });
    }
  }
  for (const [type, m] of mentioned) evidence.push({ span: m.span, role: 'type', detail: type });

  // --- time, before ids, so the N in "last N days" is not read as a number ---
  const time = claimTime(tokens, ctx.asOf);
  if (time !== null) {
    evidence.push({
      span: time.span,
      role: 'time',
      detail: `${time.range.gte} .. ${time.range.lt}`
    });
  }

  // --- ids: #N anywhere, or a number right after a type word ---
  const ids: number[] = [];
  let bareNumber = false;
  tokens.forEach((t, i) => {
    if (t.used) return;
    if (/^#\d+$/.test(t.text)) {
      ids.push(Number(t.text.slice(1)));
      t.used = true;
      evidence.push({ span: t.text, role: 'id', detail: 'shortId' });
    } else if (/^\d+$/.test(t.text)) {
      if (tokens[i - 1]?.used === true && mentioned.size > 0) {
        ids.push(Number(t.text));
        t.used = true;
        evidence.push({ span: t.text, role: 'id', detail: 'shortId' });
      } else bareNumber = true;
    }
  });

  // --- superlatives, "current <singular>", counts, scope, history ---
  let order: 'desc' | 'asc' | null = null;
  let count = false;
  let allProjects = false;
  let historyWord = false;
  const singularMention = [...mentioned.values()].some((m) => !m.plural);
  tokens.forEach((t, i) => {
    if (t.used) return;
    const next = tokens[i + 1];
    if (
      LATEST.has(t.text) ||
      (t.text === 'most' && /^recent(ly)?$/.test(next?.text ?? '')) ||
      (t.text === 'current' && singularMention)
    ) {
      order = 'desc';
      t.used = true;
      if (t.text === 'most' && next !== undefined) next.used = true;
      evidence.push({ span: t.text, role: 'order', detail: 'createdAt desc, limit 1' });
    } else if (OLDEST.has(t.text)) {
      order = 'asc';
      t.used = true;
      evidence.push({ span: t.text, role: 'order', detail: 'createdAt asc, limit 1' });
    } else if (t.text === 'how' && next?.text === 'many') {
      count = true;
      t.used = true;
      next.used = true;
      evidence.push({ span: 'how many', role: 'count', detail: 'answer = count' });
    } else if ((t.text === 'every' || t.text === 'all') && /^projects?$/.test(next?.text ?? '')) {
      allProjects = true;
      t.used = true;
      (next as Token).used = true;
      evidence.push({ span: `${t.text} ${next?.text}`, role: 'scope', detail: 'no project scope' });
    } else if (t.text === 'across') {
      allProjects = true;
      t.used = true;
    } else if (HISTORY_WORDS.has(t.text)) {
      historyWord = true;
      t.used = true;
      evidence.push({ span: t.text, role: 'history', detail: 'search the whole record' });
    }
  });

  // --- author: "<verb> by X" or "X sent" ---
  let author: string | null = null;
  tokens.forEach((t, i) => {
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if (
      t.text === 'by' &&
      prev !== undefined &&
      AUTHOR_VERBS.has(prev.text) &&
      next !== undefined
    ) {
      author = next.text;
      for (const x of [prev, t, next]) x.used = true;
    } else if (t.text === 'sent' && prev !== undefined && !GLUE.has(prev.text) && !prev.used) {
      author = prev.text;
      prev.used = true;
      t.used = true;
    }
  });
  if (author !== null)
    evidence.push({ span: author, role: 'author', detail: `createdById startsWith ${author}` });
  // Only claimed walk material composes: a stray comparative alone does not.
  const composing =
    walkClaims.phrases.length + walkClaims.compares.length + walkClaims.dropped.length > 0;
  if (composing) {
    dropComparatives(tokens, walkClaims.dropped);
    // Walks are read as one AND: a connective that would change that is dropped, never glue.
    for (const t of tokens) {
      if (t.used || !CONNECTIVES.has(t.text)) continue;
      t.used = true;
      walkClaims.dropped.push({
        span: t.text,
        reason: `"${t.text}" is not composed: walk clauses are read as all applying together`,
        kind: 'filter'
      });
    }
  }

  // --- "which <field>" (singular = field answer, plural = group) ---
  const fieldAliases = { ...BUILTIN_FIELD_ALIASES, ...(rulings.fieldAliases ?? {}) };
  let askField: { field: string; group: boolean } | null = null;
  tokens.forEach((t, i) => {
    if (t.used || tokens[i - 1]?.text !== 'which') return;
    for (const form of [t.text, t.text.replace(/s$/, '')]) {
      const field = own(fieldAliases, form) ?? (fieldNamed(pack, form) ? form : null);
      if (field === null) continue;
      askField = { field, group: form !== t.text };
      t.used = true;
      evidence.push({
        span: t.text,
        role: 'field',
        detail: askField.group ? `group by ${field}` : `answer = ${field}`
      });
      return;
    }
  });

  // --- yes/no fields of a named type ("active agents") before generic values ---
  const flagClaims = new Map<string, Evidence[]>();
  for (const type of mentioned.keys()) {
    for (const [name, f] of Object.entries(own(pack.types, type)?.fields ?? {})) {
      if (f.valueType !== 'boolean' || name === 'archived') continue;
      const t = tokens.find((x) => !x.used && f.phrases.includes(x.text));
      if (t === undefined) continue;
      t.used = true;
      flagClaims.set(type, [
        ...(flagClaims.get(type) ?? []),
        { span: t.text, role: 'value', detail: name }
      ]);
    }
  }

  // --- pack values, longest first ---
  claimNgrams(tokens, 4, (key, at) => {
    if (at.length === 1 && GLUE.has(key)) return false;
    // "closed", "done": the closing verb (any terminal status) wins over the literal value.
    if (at.length === 1 && CLOSE_VERBS.has(key)) return false;
    // A plural word names its singular stored value ("protocols" -> protocol).
    const found =
      own(pack.values, key) !== undefined
        ? key
        : at.length === 1 && /[^s]s$/.test(key) && own(pack.values, key.slice(0, -1)) !== undefined
          ? key.slice(0, -1)
          : null;
    if (found === null) return false;
    values.push({ span: key, key: found, at });
    return true;
  });

  const closeVerb = words.some((w) => CLOSE_VERBS.has(w));
  const updateVerb = words.some((w) => UPDATE_VERBS.has(w));
  for (const t of tokens) if (CLOSE_VERBS.has(t.text) || UPDATE_VERBS.has(t.text)) t.used = true;

  // --- which types? ---
  let types = [...mentioned.keys()].sort();
  if (ctx.forceType !== undefined && own(pack.types, ctx.forceType) !== undefined) {
    types = [ctx.forceType];
    if (!mentioned.has(ctx.forceType))
      evidence.push({ span: '', role: 'type', detail: ctx.forceType });
  }
  // Walks: a type a field phrase reaches is walked to, not read as a seed. Types
  // named with nothing reaching them stay separate readings.
  if (composing && ctx.forceType === undefined && mentioned.size > 0) {
    const reached = new Set(walkClaims.phrases.map((p) => p.type));
    const byPosition = [...mentioned].sort(([, x], [, y]) => x.at[0] - y.at[0]).map(([t]) => t);
    const seeds = byPosition.filter((t) => !reached.has(t));
    types = (seeds.length > 0 ? seeds : byPosition.slice(0, 1)).sort();
  }
  if (types.length === 0 && ids.length > 0 && ctx.defaultIdType !== undefined)
    types = [ctx.defaultIdType];
  if (types.length === 0 && values.length > 0) {
    types = typesCovering(pack, values);
    // "what's open": a bare live word names the types it is the live state of.
    const live = types.filter((t) =>
      values.some((v) => v.key !== null && v.key === own(rulings.liveStatus, t))
    );
    if (types.length > 1 && live.length > 0) types = live;
  }
  if (types.length === 0 && clauses.length > 0) types = typesWithFields(pack, clauses, rulings);
  if (types.length === 0 && closeVerb) types = closableTypes(pack);
  const named = mentioned.size > 0 || ctx.forceType !== undefined;
  if (bareNumber && ids.length === 0 && !named) {
    return {
      status: 'clarify',
      candidates: [],
      residual: [],
      reason: 'a bare number with no type'
    };
  }
  if (ids.length > 0 && !named && !words.some((w) => STATE_CUES.has(w))) {
    return {
      status: 'clarify',
      candidates: [],
      residual: [],
      reason: '#N with no question about it: a Todo or a PR?'
    };
  }
  if (types.length === 0) {
    return {
      status: 'unparsed',
      candidates: [],
      evidence,
      residual: contentWords(tokens),
      reason: 'no type, id or known value'
    };
  }

  const candidates: Candidate[] = [];
  const ruledOut: string[] = [];
  for (const type of types) {
    let composed: Composed | undefined;
    if (composing) {
      const r = compose({
        pack,
        rulings,
        seed: type,
        claims: walkClaims,
        mentions: [...mentioned].map(([t, m]) => ({ type: t, span: m.span, at: m.at })),
        time
      });
      if ('clarify' in r)
        return { status: 'clarify', candidates: [], residual: [], reason: r.clarify };
      composed = r;
    }
    const c = assemble(type, {
      composed,
      pack,
      ctx,
      tokens: tokens.map((t) => ({ ...t })),
      evidence: evidence.filter((e) => e.role !== 'type' || e.detail === type),
      ids,
      values,
      clauses,
      time: composed === undefined || composed.timeOnSeed ? time : null,
      order,
      count,
      allProjects,
      historyWord,
      flags: flagClaims.get(type) ?? [],
      author,
      askField,
      closeVerb,
      updateVerb
    });
    if ('reason' in c) ruledOut.push(`${type}: ${c.reason}`);
    else candidates.push(c);
  }

  if (candidates.length === 0) {
    const reason = ruledOut.length > 0 ? ruledOut.join('; ') : 'no type fits every value';
    return { status: 'unparsed', candidates, evidence, residual: contentWords(tokens), reason };
  }
  if (candidates.length > 1) {
    return {
      status: 'ambiguous',
      candidates,
      residual: [],
      reason: `${candidates.length} readings`
    };
  }
  const only = candidates[0] as Candidate;
  if (only.dropped.length > 0) {
    return {
      status: 'partial',
      candidates,
      residual: only.residual,
      reason: `dropped: ${only.dropped.map((d) => `"${d.span}" (${d.reason})`).join('; ')}`
    };
  }
  // An id lookup is fixed by the id: leftover words are commentary, not filters.
  if (only.residual.length > 0 && ids.length === 0) {
    return {
      status: 'partial',
      candidates,
      residual: only.residual,
      reason: `unexplained: ${only.residual.join(', ')}`
    };
  }
  return { status: 'resolved', candidates, residual: only.residual };
}

interface AssemblyInput {
  /** Walks, comparisons and windows composed for this seed type. */
  composed: Composed | undefined;
  pack: NamespacePack;
  ctx: ParseContext;
  tokens: Token[];
  evidence: Evidence[];
  ids: number[];
  values: ValueClaim[];
  clauses: FieldClause[];
  time: { span: string; range: DateRange; at: [number, number] } | null;
  order: 'desc' | 'asc' | null;
  count: boolean;
  allProjects: boolean;
  historyWord: boolean;
  /** Yes/no fields of this type the question named, claimed before generic values. */
  flags: Evidence[];
  author: string | null;
  askField: { field: string; group: boolean } | null;
  closeVerb: boolean;
  updateVerb: boolean;
}

/** One reading of the question as `type`, or why there is none. */
function assemble(type: string, a: AssemblyInput): Candidate | { reason: string } {
  const { pack, ctx, tokens } = a;
  const rulings = ctx.rulings ?? {};
  const fields = own(pack.types, type)?.fields ?? {};
  const words = tokens.map((t) => t.text);
  // A declared derive is the explicit ordering; a recency word beside it conflicts and is dropped.
  const seedLatest = a.composed?.seedLatest;
  const evidence =
    a.order === null && seedLatest !== undefined
      ? [...a.evidence, { span: seedLatest, role: 'order' as const, detail: 'desc, limit 1' }]
      : a.evidence;
  const recency = a.order ?? (seedLatest !== undefined ? 'desc' : null);
  const conflict = a.composed?.params.orderBy !== undefined && recency !== null;
  const order = conflict ? null : recency;
  const orderSpan = evidence.find((e) => e.role === 'order')?.span ?? '';
  const ev = conflict ? evidence.filter((e) => e.role !== 'order') : [...evidence];
  const dropped = [
    ...(a.composed?.dropped ?? []),
    ...(conflict
      ? [
          {
            span: orderSpan,
            reason: 'it conflicts with the derived ordering, which is kept',
            kind: 'order' as const
          }
        ]
      : [])
  ];
  const where: Record<string, unknown>[] = [];
  const wherePlan = new Map<Record<string, unknown>, PlanClause[]>();

  if (a.ids.length > 0)
    where.push({ shortId: a.ids.length === 1 ? { eq: a.ids[0] } : { in: a.ids } });

  // Values, grouped by the field they read as on this type.
  const byField = new Map<string, string[]>();
  const usedFields = new Set<string>();
  let terminal = false;
  // An id fixes the row, so values beside it are commentary ("#10, is that
  // Muse?"), not filters that could rule the reading out.
  for (const v of a.ids.length > 0 ? [] : a.values) {
    if (v.alias !== undefined) {
      const hit = v.alias.find((x) => x.type === type);
      if (hit === undefined) return { reason: `"${v.span}" does not apply to ${type}` };
      const op =
        hit.in !== undefined
          ? { in: hit.in }
          : hit.eq !== undefined
            ? { eq: hit.eq }
            : hit.startsWith !== undefined
              ? { startsWith: hit.startsWith }
              : { contains: hit.contains };
      where.push({ [hit.field]: op });
      usedFields.add(hit.field);
      ev.push({ span: v.span, role: 'value', detail: `${hit.field} ${JSON.stringify(op)}` });
      continue;
    }
    const refs = (own(a.pack.values, v.key as string) ?? []).filter((r) => r.type === type);
    if (refs.length === 0) return { reason: `"${v.span}" is not a ${type} value` };
    const field = pickField(
      refs.map((r) => r.field),
      fields,
      words
    );
    const stored = refs.find((r) => r.field === field)?.value ?? (v.key as string);
    if (TERMINAL.includes(stored)) terminal = true;
    byField.set(field, [...(byField.get(field) ?? []), stored]);
    usedFields.add(field);
    ev.push({ span: v.span, role: 'value', detail: `${field} = ${stored}` });
  }
  for (const [field, vals] of [...byField].sort(([x], [y]) => x.localeCompare(y))) {
    if (fields[field]?.kind === 'list') for (const v of vals) where.push({ [field]: { has: v } });
    else where.push({ [field]: vals.length === 1 ? { eq: vals[0] } : { in: vals } });
  }

  // Inline clauses: literal, but checked against the field's type and operators.
  for (const c of a.clauses) {
    const name = resolveField(c.field, fields, rulings);
    const f = name === null ? undefined : fields[name];
    if (name === null || f === undefined) return { reason: `${type} has no field "${c.field}"` };
    if (!f.operators.includes(c.op)) return { reason: `${name} does not accept ${c.op}` };
    const coerced = c.values.map((v) => coerce(v, f));
    if (coerced.some((v) => v === undefined))
      return { reason: `"${c.span}" is not a ${f.valueType} value` };
    const operand = c.op === 'in' || c.op === 'between' ? coerced : coerced[0];
    where.push({ [name]: { [c.op]: operand } });
    usedFields.add(name);
    ev.push({
      span: c.span,
      role: 'value',
      detail: `${name} ${c.op} ${JSON.stringify(operand)} (inline)`
    });
  }

  // A field word next to its value ("high priority", "tagged recall") is explained by it.
  for (const field of usedFields) creditFieldWords(tokens, fields[field]);

  if (a.author !== null) where.push({ createdById: { startsWith: a.author } });

  // Yes/no fields named on their own: "pinned rules", "active agents".
  for (const flag of a.flags) {
    usedFields.add(flag.detail);
    where.push({ [flag.detail]: { eq: true } });
    ev.push({ ...flag, detail: `${flag.detail} = true` });
  }
  for (const [name, f] of Object.entries(fields)) {
    if (f.valueType !== 'boolean' || name === 'archived' || usedFields.has(name)) continue;
    const t = tokens.find((x) => !x.used && f.phrases.includes(x.text));
    if (t === undefined) continue;
    t.used = true;
    usedFields.add(name);
    where.push({ [name]: { eq: true } });
    ev.push({ span: t.text, role: 'value', detail: `${name} = true` });
  }

  const historical = a.historyWord || a.time !== null || a.closeVerb || terminal;
  if (a.time !== null) {
    // A date field named in the question ("target date this month") takes the range.
    const named = Object.entries(fields).find(
      ([, f]) => f.valueType === 'date' && f.kind !== 'metadata' && creditFieldWords(tokens, f)
    );
    const dateField =
      named?.[0] ??
      (a.closeVerb || a.updateVerb ? 'updatedAt' : (own(rulings.timeField, type) ?? 'createdAt'));
    const clause = { [dateField]: { gte: a.time.range.gte, lt: a.time.range.lt } };
    where.push(clause);
    // In a composed reading the seed's window is a plan clause like a walk's, default named.
    if (a.composed !== undefined) {
      const ruled =
        named !== undefined ||
        a.closeVerb ||
        a.updateVerb ||
        own(rulings.timeField, type) !== undefined;
      wherePlan.set(clause, [
        {
          path: [dateField, `window:${a.time.span}${ruled ? '' : ` on ${dateField} (default)`}`],
          kind: 'filter',
          served: false
        }
      ]);
    }
  }
  if (a.ids.length === 0) {
    const statusField = fields.status;
    const live = own(rulings.liveStatus, type);
    if (a.closeVerb && statusField?.enum !== undefined && !byField.has('status')) {
      const closed = statusField.enum.filter((s) => CLOSED.includes(s));
      if (closed.length > 0) where.push({ status: { in: closed } });
    } else if (
      !historical &&
      live !== undefined &&
      statusField?.enum?.includes(live) === true &&
      !usedFields.has('status') &&
      order === null
    ) {
      where.push({ status: { eq: live } });
    }
    // Live rows by default; a question about the past searches the whole record.
    if (!historical && fields.archived !== undefined) where.push({ archived: { eq: false } });
    else if (historical)
      ev.push({ span: '(history)', role: 'history', detail: 'archived rows included' });
    if (
      fields.active?.valueType === 'boolean' &&
      !usedFields.has('active') &&
      !words.includes('inactive')
    ) {
      where.push({ active: { eq: true } });
    }
    const scoped = fields.project !== undefined && !(rulings.unscopedTypes ?? []).includes(type);
    // Grouping by project is a question across projects.
    const groupedByProject = a.askField?.group === true && a.askField.field === 'project';
    if (
      scoped &&
      !usedFields.has('project') &&
      !a.allProjects &&
      !groupedByProject &&
      ctx.project !== undefined
    ) {
      where.push({ OR: [{ project: { eq: ctx.project } }, { project: { eq: null } }] });
      ev.push({ span: '(context)', role: 'scope', detail: `project = ${ctx.project} or none` });
    }
  }

  const params: Record<string, unknown> = {};
  const parts: Part[] = [
    ...where.map((clause) => ({ clause, plan: wherePlan.get(clause) ?? [] })),
    ...(a.composed?.parts ?? [])
  ];
  const all = andOf(parts);
  if (all !== null) params.where = all.where;
  const plan = [
    ...(all?.plan ?? []).map((c) => ({ ...c, path: ['where', ...c.path] })),
    ...(a.composed?.plan ?? [])
  ];
  if (order !== null) {
    // "latest" is by the type's ruled date, as a window and a walk's pick are.
    params.orderBy = [{ [own(rulings.timeField, type) ?? 'createdAt']: order }];
    params.limit = 1;
  }
  Object.assign(params, a.composed?.params ?? {});
  // A composed reading needs the walk grammar anyway, so its count is the server's.
  if (a.count && a.composed?.walked === true) params.count = true;
  const answer =
    a.askField !== null
      ? a.askField.group
        ? `group:${a.askField.field}`
        : `field:${a.askField.field}`
      : a.count
        ? 'count'
        : order !== null || a.ids.length === 1
          ? 'single'
          : 'rows';
  return {
    type,
    frame: { [`${pack.namespace}/${type}`]: { params } },
    answer,
    evidence: ev,
    residual: contentWords(tokens),
    plan,
    dropped,
    // From the pick-one itself, not the answer label: "which grade" over "latest" still picks one.
    strict: a.count || order !== null || a.ids.length === 1 || a.composed?.strict === true
  };
}

/** A clause's field name: the field itself, case-insensitively, then the rulings' and built-in aliases. */
function resolveField(
  raw: string,
  fields: Record<string, PackField>,
  rulings: NamespaceRulings
): string | null {
  const lower = raw.toLowerCase();
  const direct = Object.keys(fields).find((f) => f.toLowerCase() === lower);
  if (direct !== undefined) return direct;
  const aliased = own(rulings.fieldAliases, lower) ?? own(BUILTIN_FIELD_ALIASES, lower);
  return aliased !== undefined && Object.hasOwn(fields, aliased) ? aliased : null;
}

/** A clause value as the field's type, or undefined when it is not one. */
function coerce(raw: string, f: PackField): unknown {
  if (f.valueType === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (f.valueType === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : undefined;
  return raw;
}

/** Types that have every field the clauses name, sorted. */
function typesWithFields(
  pack: NamespacePack,
  clauses: FieldClause[],
  rulings: NamespaceRulings
): string[] {
  return Object.entries(pack.types)
    .filter(([, t]) => clauses.every((c) => resolveField(c.field, t.fields, rulings) !== null))
    .map(([name]) => name)
    .sort();
}

/** Marks unused tokens naming `field` as explained; true when any did. */
function creditFieldWords(tokens: Token[], field: PackField | undefined): boolean {
  if (field === undefined) return false;
  let hit = false;
  for (const phrase of field.phrases) {
    const parts = phrase.split(' ');
    const stem = (parts[parts.length - 1] ?? '').replace(/s$/, '');
    for (let i = 0; i + parts.length <= tokens.length; i++) {
      const slice = tokens.slice(i, i + parts.length);
      if (slice.some((t) => t.used)) continue;
      const text = slice.map((t) => t.text).join(' ');
      const last = slice[slice.length - 1]?.text ?? '';
      const head = slice
        .slice(0, -1)
        .map((t) => t.text)
        .join(' ');
      const headWant = parts.slice(0, -1).join(' ');
      // "priority", "target date", and inflections like "tagged" for "tags".
      if (text === phrase || (head === headWant && stem.length >= 3 && last.startsWith(stem))) {
        for (const t of slice) t.used = true;
        hit = true;
      }
    }
  }
  return hit;
}

function contentWords(tokens: Token[]): string[] {
  return tokens
    .filter((t) => !t.used && !GLUE.has(t.text) && !/^\d+$/.test(t.text))
    .map((t) => t.text);
}

/** Claims the longest n-grams (up to `max` words) for which `accept` returns true. */
function claimNgrams(
  tokens: Token[],
  max: number,
  accept: (key: string, at: number[]) => boolean
): void {
  for (let n = max; n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const slice = tokens.slice(i, i + n);
      if (slice.some((t) => t.used)) continue;
      const at = slice.map((_, j) => i + j);
      if (!accept(slice.map((t) => t.text).join(' '), at)) continue;
      for (const t of slice) t.used = true;
    }
  }
}

/** Type phrases: rulings aliases, then the pack's, plus each multi-word type's first word. Longest first. */
function buildTypeIndex(pack: NamespacePack, rulings: NamespaceRulings): TypeEntry[] {
  const map = new Map<string, { types: Set<string>; plural: boolean }>();
  const add = (phrase: string, type: string, plural: boolean) => {
    const e = map.get(phrase) ?? { types: new Set<string>(), plural };
    e.types.add(type);
    map.set(phrase, e);
  };
  const aliased = new Set(Object.keys(rulings.typeAliases ?? {}));
  for (const [phrase, type] of Object.entries(rulings.typeAliases ?? {}))
    add(phrase, type, phrase.endsWith('s'));
  for (const [name, t] of Object.entries(pack.types)) {
    const words = splitWords(name);
    const singulars = new Set([words.join(' '), words[words.length - 1] ?? '']);
    for (const p of [...t.phrases, name.toLowerCase()]) {
      if (!aliased.has(p)) add(p, name, !singulars.has(p) && p !== name.toLowerCase());
    }
    if (words.length > 1) {
      const first = words[0] as string;
      if (!aliased.has(first)) add(first, name, false);
      if (!aliased.has(pluralize(first))) add(pluralize(first), name, true);
    }
  }
  return [...map]
    .map(([phrase, e]) => ({ phrase, types: [...e.types].sort(), plural: e.plural }))
    .sort(
      (x, y) =>
        y.phrase.split(' ').length - x.phrase.split(' ').length || x.phrase.localeCompare(y.phrase)
    );
}

function fieldNamed(pack: NamespacePack, word: string): boolean {
  return Object.values(pack.types).some((t) =>
    Object.values(t.fields).some((f) => f.phrases.includes(word))
  );
}

/** Types every value can be read as, sorted. */
function typesCovering(pack: NamespacePack, values: ValueClaim[]): string[] {
  let acc: string[] | null = null;
  for (const v of values) {
    const types = new Set(
      v.alias !== undefined
        ? v.alias.map((x) => x.type)
        : (own(pack.values, v.key as string) ?? []).map((r) => r.type)
    );
    acc = acc === null ? [...types] : acc.filter((t) => types.has(t));
  }
  return [...(acc ?? [])].sort();
}

/** Types whose `status` enum has a terminal value. */
function closableTypes(pack: NamespacePack): string[] {
  return Object.entries(pack.types)
    .filter(([, t]) => t.fields.status?.enum?.some((v) => CLOSED.includes(v)) === true)
    .map(([name]) => name)
    .sort();
}

/**
 * The field a value reads as when it fits several on one type: a field named
 * in the question first, then the most categorical (fewest distinct values,
 * enum size for enums), then name order.
 */
function pickField(
  candidates: string[],
  fields: Record<string, PackField>,
  words: string[]
): string {
  const unique = [...new Set(candidates)];
  const text = ` ${words.join(' ')} `;
  // Named outright ("priority"), or by inflection ("tagged" for tags).
  const stem = (p: string) => p.replace(/s$/, '');
  const named = unique.filter((f) =>
    fields[f]?.phrases.some(
      (p) =>
        text.includes(` ${p} `) ||
        (stem(p).length >= 3 && words.some((w) => w !== p && w.startsWith(stem(p))))
    )
  );
  const pool = named.length > 0 ? named : unique;
  const size = (f: string) =>
    fields[f]?.enum?.length ?? fields[f]?.distinct ?? Number.MAX_SAFE_INTEGER;
  return [...pool].sort((x, y) => size(x) - size(y) || x.localeCompare(y))[0] as string;
}

function claimTime(
  tokens: Token[],
  asOf: string
): { span: string; range: DateRange; at: [number, number] } | null {
  let found: { span: string; range: DateRange; at: [number, number] } | null = null;
  claimNgrams(tokens, 3, (key, at) => {
    if (found !== null) return false;
    const range = rangeFor(key, asOf);
    if (range === null) return false;
    found = { span: key, range, at: [at[0] as number, at[at.length - 1] as number] };
    return true;
  });
  return found;
}
