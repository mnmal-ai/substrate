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
import { whereFields } from '../rulings/schema.js';
import { type DateRange, rangeFor } from './time.js';
import {
  andOf,
  type Composed,
  claimWalkParts,
  compose,
  defaultYield,
  dropComparatives,
  findPaths,
  type Hop,
  type Part,
  type Path,
  type PhraseClaim,
  PICK_WORDS,
  type PickClaim,
  pathLabel,
  type WalkClaims
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
  /** `fields` carries only what the reading adds to the projection: a hop ordering's `_agg`. */
  frame: Record<string, { params: Record<string, unknown>; fields?: Record<string, unknown> }>;
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
  /**
   * An aggregate answer: `fn` of `field`. `group` is a field grouping the
   * engine cannot express, run as one aggregate per value.
   */
  aggregate?: {
    fn: AggregateFn;
    field: string;
    group?: { field: string; values: (string | boolean)[] };
  };
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
      .match(
        /\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:\d{2})?|\$\d+(?:\.\d+)?|\d+(?:\.\d+)?[%×]|#\d+|[a-z0-9@[][a-z0-9@._'\]-]*/g
      ) ?? []
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

  // --- walk material: field phrases, pick words, "by <computed>", comparisons ---
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
      detail: `${time.range.gte ?? ''} .. ${time.range.lt ?? ''}`.trim()
    });
  }

  // --- an aggregate, before field orderings, which take "highest <field>" otherwise ---
  const aggregate = claimAggregate(
    tokens,
    walkClaims,
    pack,
    rulings,
    [...mentioned.values()].map((m) => m.at[0])
  );

  // --- ordering by a field, before ids, so the N in "top N" is not read as an id ---
  const fieldOrder = claimFieldOrder(tokens, walkClaims, pack, rulings, mentioned);
  // "<type> <field>": that type names the field, not a reading, unless it is the only type
  // named or a time range could window it (then both readings stay, as without the pair).
  const fieldType = fieldOrder?.type;
  if (fieldType !== undefined && time === null && mentioned.size > 1) {
    mentioned.delete(fieldType);
    const e = evidence.findIndex((x) => x.role === 'type' && x.detail === fieldType);
    if (e >= 0) evidence.splice(e, 1);
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
      fieldOrder: fieldOrder ?? composed?.seedOrder ?? null,
      plural: mentioned.get(type)?.plural ?? false,
      count,
      aggregate,
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
  /** An ordering by a field, resolved against this type. */
  fieldOrder: FieldOrder | null;
  /** The type was named in the plural: an ordering's default limit is 10, else 1. */
  plural: boolean;
  count: boolean;
  aggregate: AggregateClaim | null;
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
  // A declared computed value is the explicit ordering; a recency word beside it conflicts and is dropped.
  const seedLatest = a.composed?.seedLatest;
  const evidence =
    a.order === null && seedLatest !== undefined
      ? [...a.evidence, { span: seedLatest, role: 'order' as const, detail: 'desc, limit 1' }]
      : a.evidence;
  const recency = a.order ?? (seedLatest !== undefined ? 'desc' : null);
  const derived = a.composed?.params.orderBy !== undefined;
  // "how many … max price": the count is what was asked; the aggregate is dropped below.
  const aggClaim = a.count ? null : a.aggregate;
  // A field ordering is ignored in a count, and gives way to a derived ordering.
  const fieldOrder: Dropped[] = [];
  let sortBy: { field: string; hop?: HopOrder; dir: 'desc' | 'asc'; limit: number } | null = null;
  // A count over "the top 5" or "the highest" would count every row: the ordering is a
  // dropped filter, so a strict count is unknown rather than a wrong number.
  if (a.fieldOrder !== null && (a.count || aggClaim !== null))
    fieldOrder.push({
      span: a.fieldOrder.span,
      reason: `ordering does not apply to ${a.count ? 'a count' : 'an aggregate'}`,
      kind: 'filter'
    });
  if (a.fieldOrder !== null && !a.count && aggClaim === null) {
    const r = orderField(a.fieldOrder, type, pack, rulings);
    const reason =
      'reason' in r
        ? r.reason
        : derived
          ? 'it conflicts with the derived ordering, which is kept'
          : null;
    const limit = a.fieldOrder.limit ?? (a.plural ? 10 : 1);
    if (reason !== null) fieldOrder.push({ span: a.fieldOrder.span, reason, kind: 'order' });
    else if ('field' in r) sortBy = { field: r.field, dir: a.fieldOrder.dir, limit };
    else if ('hop' in r && Object.hasOwn(fields, r.hop.name))
      fieldOrder.push({
        span: a.fieldOrder.span,
        reason: `its name "${r.hop.name}" is also a field of ${type}`,
        kind: 'order'
      });
    else if ('hop' in r) sortBy = { field: r.hop.name, hop: r.hop, dir: a.fieldOrder.dir, limit };
  }
  // "the last sale", "the first 3 items": a count or aggregate over them would cover every row.
  const pickOver = (a.count || aggClaim !== null) && recency !== null;
  const conflict = !pickOver && (derived || sortBy !== null) && recency !== null;
  const order = conflict || pickOver ? null : recency;
  const orderSpan = evidence.find((e) => e.role === 'order')?.span ?? '';
  const ev = conflict || pickOver ? evidence.filter((e) => e.role !== 'order') : [...evidence];
  if (sortBy !== null)
    ev.push({
      span: a.fieldOrder?.span ?? '',
      role: 'order',
      detail: `${sortBy.hop?.label ?? sortBy.field} ${sortBy.dir}, limit ${sortBy.limit}`
    });
  const dropped = [
    ...(a.composed?.dropped ?? []),
    ...fieldOrder,
    ...(conflict
      ? [
          {
            span: orderSpan,
            reason: `it conflicts with the ${derived ? 'derived' : 'field'} ordering, which is kept`,
            kind: 'order' as const
          }
        ]
      : []),
    ...(pickOver
      ? [
          {
            span: orderSpan,
            reason: `${a.count ? 'counting' : 'aggregating'} over the latest N rows is not supported`,
            kind: 'filter' as const
          }
        ]
      : []),
    ...(a.count && a.aggregate !== null
      ? [
          {
            span: a.aggregate.span,
            reason: 'an aggregate does not apply to a count',
            kind: 'filter' as const
          }
        ]
      : []),
    ...(aggClaim !== null && derived
      ? [
          {
            span: `by ${Object.keys(a.composed?.params.select ?? {}).join(', ')}`,
            reason: 'grouping by a derived value is not supported',
            kind: 'order' as const
          }
        ]
      : [])
  ];
  const where: Record<string, unknown>[] = [];
  const wherePlan = new Map<Record<string, unknown>, PlanClause[]>();
  const yields: PlanClause[] = [];

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
  // An ordering phrase's ruled exclusion still holds ("asking price" without placeholders).
  const orderExclude = a.fieldOrder?.phrase?.entry.exclude;
  if (sortBy !== null && sortBy.hop === undefined && orderExclude !== undefined)
    where.push({ NOT: orderExclude });

  const agg = aggClaim === null ? null : aggregateOn(aggClaim, type, pack, rulings);
  if (agg !== null) {
    dropped.push(...agg.dropped);
    ev.push(...agg.evidence);
    if (agg.exclude !== undefined) where.push({ NOT: agg.exclude });
    if (agg.group !== undefined) usedFields.add(agg.group.field);
  }

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
    const clause = { [dateField]: { ...a.time.range } };
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
    // The type's default exclusion, unless the question filters a field it tests
    // ("skipped runs"): then it yields, and the plan says so.
    const excluded = own(rulings.typeExcludes, type);
    if (excluded !== undefined) {
      const tested: string[] = [];
      whereFields(excluded, tested);
      const named = [...usedFields];
      for (const p of a.composed?.parts ?? []) whereFields(p.clause, named);
      const yieldTo = tested.find((f) => named.includes(f));
      if (yieldTo === undefined) {
        const clause = { NOT: excluded };
        where.push(clause);
        wherePlan.set(clause, [
          { path: ['NOT', `ruling:${type} default exclude`], kind: 'filter', served: false }
        ]);
      } else yields.push(defaultYield(type, yieldTo));
    }
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
    if (!historical && fields.archived !== undefined && !usedFields.has('archived'))
      where.push({ archived: { eq: false } });
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
    ...yields,
    // A computed ordering beside an aggregate was dropped, so its clauses do not run.
    ...(a.composed?.plan ?? []).filter((c) => aggClaim === null || c.kind !== 'select'),
    ...(sortBy?.hop !== undefined
      ? [
          {
            path: ['fields', '_agg', sortBy.hop.name, sortBy.hop.label],
            kind: 'hop' as const,
            served: true
          },
          {
            path: ['orderBy', '0', sortBy.field, sortBy.dir],
            kind: 'order' as const,
            served: false
          }
        ]
      : []),
    ...(agg?.group !== undefined
      ? [
          {
            path: [
              'aggregate',
              `group:${agg.group.field} (one frame per value, and one for no value)`
            ],
            kind: 'agg' as const,
            served: false
          }
        ]
      : [])
  ];
  if (order !== null) {
    // "latest" is by the type's ruled date, as a window and a walk's pick are.
    params.orderBy = [{ [own(rulings.timeField, type) ?? 'createdAt']: order }];
    params.limit = 1;
  }
  if (sortBy !== null) {
    if (sortBy.hop !== undefined) params.select = { [sortBy.hop.name]: `_agg.${sortBy.hop.name}` };
    params.orderBy = [{ [sortBy.field]: sortBy.dir }];
    params.limit = sortBy.limit;
  }
  Object.assign(params, a.composed?.params ?? {});
  // A composed reading needs the walk grammar anyway, so its count is the server's.
  if (a.count && a.composed?.walked === true) params.count = true;
  if (aggClaim !== null) {
    delete params.select;
    delete params.orderBy;
  }
  if (agg?.fn !== undefined && agg.field !== undefined) {
    params.aggregate = { value: { [agg.fn]: agg.field } };
    if (agg.dateGroup !== undefined)
      params.groupBy = {
        bucket: { dateTrunc: [{ lit: agg.dateGroup.by }, agg.dateGroup.field] }
      };
  }
  const answer =
    aggClaim !== null
      ? 'aggregate'
      : a.askField !== null
        ? a.askField.group
          ? `group:${a.askField.field}`
          : `field:${a.askField.field}`
        : a.count
          ? 'count'
          : order !== null || a.ids.length === 1 || sortBy?.limit === 1
            ? 'single'
            : 'rows';
  return {
    type,
    frame: {
      [`${pack.namespace}/${type}`]: {
        params,
        // The hop ordering's value comes back on each row as `_agg.<name>`.
        ...(sortBy?.hop !== undefined
          ? { fields: { _agg: { [sortBy.hop.name]: sortBy.hop.agg } } }
          : {})
      }
    },
    answer,
    evidence: ev,
    residual: contentWords(tokens),
    plan,
    dropped,
    // From the pick-one itself, not the answer label: "which grade" over "latest" still picks one.
    ...(agg?.fn !== undefined && agg.field !== undefined
      ? {
          aggregate: {
            fn: agg.fn,
            field: agg.field,
            ...(agg.group !== undefined ? { group: agg.group } : {})
          }
        }
      : {}),
    strict:
      a.count ||
      aggClaim !== null ||
      order !== null ||
      sortBy !== null ||
      a.ids.length === 1 ||
      a.composed?.strict === true
  };
}

/** An ordering by a field: "top N <type> by <field>", "highest|lowest <field>", "most <field>". */
interface FieldOrder {
  span: string;
  dir: 'desc' | 'asc';
  /** "top N": the N. */
  limit?: number;
  /** Words naming the field, resolved per reading. */
  words?: string;
  /** Or a `fieldPhrases` claim naming it. */
  phrase?: PhraseClaim;
  /** "most <field>": a number field only. */
  numeric?: boolean;
  /** "<type> <field>": the type the words name a field of. */
  type?: string;
  /** "by latest <field>": how a hop to many rows picks one value. A direction word sets `dir` instead. */
  pick?: { span: string; kind: PickClaim['kind'] };
}

/** A field named by words on one type: one of its field phrases, else its name or an alias. */
function fieldByWords(
  words: string,
  fields: Record<string, PackField>,
  rulings: NamespaceRulings
): string | null {
  const phrased = Object.entries(fields).find(([, f]) => f.phrases.includes(words))?.[0];
  return phrased ?? (words.includes(' ') ? null : resolveField(words, fields, rulings));
}

/** Words naming a field, claimed at one position. */
interface FieldWords {
  words?: string;
  phrase?: PhraseClaim;
  /** The type a "<type> <field>" mention named. */
  type?: string;
  span: string;
  end: number;
}

/**
 * The field named at `i`: a field phrase claim, else the longest run of up to
 * three free words naming a field on some type, else (unless `numeric`) one
 * free unknown word, so the reading can drop it with a reason.
 */
function fieldAt(
  tokens: Token[],
  walkClaims: WalkClaims,
  pack: NamespacePack,
  rulings: NamespaceRulings,
  i: number,
  numeric: boolean
): FieldWords | null {
  const p = walkClaims.phrases.find(
    (x) => x.at[0] === i && x.field !== undefined && x.entry.value === undefined
  );
  if (p !== undefined) return { phrase: p, span: p.span, end: p.at[1] };
  for (let n = 3; n >= 1; n--) {
    const slice = tokens.slice(i, i + n);
    if (slice.length < n || slice.some((t) => t.used)) continue;
    const w = slice.map((t) => t.text).join(' ');
    const somewhere = Object.values(pack.types).some((t) => {
      const name = fieldByWords(w, t.fields, rulings);
      return name !== null && (!numeric || t.fields[name]?.valueType === 'number');
    });
    if (somewhere) return { words: w, span: w, end: i + n - 1 };
  }
  const t = tokens[i];
  return !numeric && t !== undefined && !t.used && !GLUE.has(t.text) && !/^\d/.test(t.text)
    ? { words: t.text, span: t.text, end: i }
    : null;
}

/** Marks tokens `from`..`f.end` used; a field phrase named here is not walked to. */
function takeField(tokens: Token[], walkClaims: WalkClaims, from: number, f: FieldWords): void {
  for (let k = from; k <= f.end; k++) (tokens[k] as Token).used = true;
  if (f.phrase !== undefined) walkClaims.phrases.splice(walkClaims.phrases.indexOf(f.phrase), 1);
}

const fieldRef = (f: FieldWords) =>
  f.phrase !== undefined
    ? { phrase: f.phrase }
    : { words: f.words as string, ...(f.type !== undefined ? { type: f.type } : {}) };

/**
 * Claims one field ordering: "top|bottom [N] … by [pick] <field>",
 * "highest|lowest <field>", "most <number field>". The field may be a
 * "<type> <field>" pair, whose type mention is then part of the field, not a
 * seed; or a field phrase on another type that a walk pick claimed.
 */
function claimFieldOrder(
  tokens: Token[],
  walkClaims: WalkClaims,
  pack: NamespacePack,
  rulings: NamespaceRulings,
  mentioned: Map<string, { span: string; at: [number, number] }>
): FieldOrder | null {
  const index = buildTypeIndex(pack, rulings);
  /** "<type> <field>": a named type's phrase at `i`, then a field of that type or one free word. */
  const typed = (i: number): FieldWords | null => {
    for (const e of index) {
      const n = e.phrase.split(' ').length;
      const words = tokens.slice(i, i + n);
      const type = e.types[0] as string;
      if (e.types.length !== 1 || !mentioned.has(type) || words.length < n) continue;
      if (words.map((t) => t.text).join(' ') !== e.phrase || words.some((t) => !t.used)) continue;
      const fields = own(pack.types, type)?.fields ?? {};
      const end = i + n - 1;
      for (let m = 3; m >= 1; m--) {
        const slice = tokens.slice(end + 1, end + 1 + m);
        if (slice.length < m || slice.some((t) => t.used)) continue;
        const w = slice.map((t) => t.text).join(' ');
        const known = fieldByWords(w, fields, rulings) !== null;
        if (known || (m === 1 && !GLUE.has(w) && !/^\d/.test(w)))
          return { words: w, type, span: `${e.phrase} ${w}`, end: end + m };
      }
      return null;
    }
    return null;
  };
  const at = (i: number, numeric: boolean) =>
    typed(i) ?? fieldAt(tokens, walkClaims, pack, rulings, i, numeric);
  const take = (from: number, f: FieldWords) => takeField(tokens, walkClaims, from, f);
  /** A pick word at `i` ("latest", "lowest" …), free or claimed by a walk pick; a direction word sets `dir`. */
  const pickAt = (i: number) => {
    const claimed = walkClaims.picks.find((k) => k.at[0] === i);
    if (claimed !== undefined)
      return {
        span: claimed.span,
        kind: claimed.kind,
        dir: own(DIRECTION_WORDS, claimed.span),
        next: claimed.at[1] + 1,
        claimed
      };
    const words = [
      ...Object.keys(PICK_WORDS).filter((w) => w.includes(' ')),
      ...Object.keys(DIRECTION_WORDS),
      ...Object.keys(PICK_WORDS)
    ];
    for (const word of words) {
      const n = word.split(' ').length;
      const slice = tokens.slice(i, i + n);
      if (
        slice.length === n &&
        slice.every((t) => !t.used) &&
        slice.map((t) => t.text).join(' ') === word
      )
        return {
          span: word,
          kind: own(PICK_WORDS, word) ?? ('max' as const),
          dir: own(DIRECTION_WORDS, word),
          next: i + n
        };
    }
    return null;
  };
  const field = fieldRef;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.used) {
      // "the item with the highest vendor score": a walk pick on a phrase that nothing compares.
      const k = walkClaims.picks.find(
        (x) => x.at[0] === i && x.at[1] === i && (x.span === 'highest' || x.span === 'lowest')
      );
      const p = k?.phrase;
      if (
        k === undefined ||
        p === undefined ||
        p.field === undefined ||
        p.entry.value !== undefined ||
        walkClaims.compares.some((c) => c.subject === p || c.object === p)
      )
        continue;
      walkClaims.picks.splice(walkClaims.picks.indexOf(k), 1);
      take(i, { phrase: p, span: p.span, end: p.at[1] });
      return { span: `${k.span} ${p.span}`, dir: k.kind === 'max' ? 'desc' : 'asc', phrase: p };
    }
    if (t.text === 'top' || t.text === 'bottom') {
      const n = tokens[i + 1];
      const limit = n !== undefined && !n.used && /^[1-9]\d*$/.test(n.text) ? n : undefined;
      const by = tokens.findIndex(
        (x, j) =>
          j > i && x.text === 'by' && !x.used && !AUTHOR_VERBS.has(tokens[j - 1]?.text ?? '')
      );
      if (by < 0) continue;
      const pick = pickAt(by + 1);
      const picked = pick === null ? null : at(pick.next, false);
      const f = picked ?? at(by + 1, false);
      if (f === null) continue;
      t.used = true;
      if (limit !== undefined) limit.used = true;
      const withPick = picked !== null && pick !== null;
      if (withPick && pick.claimed !== undefined)
        walkClaims.picks.splice(walkClaims.picks.indexOf(pick.claimed), 1);
      // Marks "by", the pick word and the field used.
      take(by, f);
      return {
        span: [t.text, limit?.text, 'by', withPick ? pick.span : undefined, f.span]
          .filter((x) => x !== undefined)
          .join(' '),
        dir: withPick && pick.dir !== undefined ? pick.dir : t.text === 'top' ? 'desc' : 'asc',
        ...(limit !== undefined ? { limit: Number(limit.text) } : {}),
        ...(withPick && pick.dir === undefined
          ? { pick: { span: pick.span, kind: pick.kind } }
          : {}),
        ...field(f)
      };
    }
    if (t.text === 'highest' || t.text === 'lowest' || t.text === 'most') {
      const numeric = t.text === 'most';
      const f = at(i + 1, numeric);
      if (f === null) continue;
      take(i, f);
      return {
        span: `${t.text} ${f.span}`,
        dir: t.text === 'lowest' ? 'asc' : 'desc',
        ...(numeric ? { numeric } : {}),
        ...field(f)
      };
    }
  }
  return null;
}

/** An aggregate over the seed: "average|total|min|max <field> of <type>", optionally grouped. */
interface AggregateClaim {
  span: string;
  /** The word as asked ("mean"), for reasons. */
  word: string;
  fn: AggregateFn;
  field: { words?: string; phrase?: PhraseClaim };
  /** "by|per <field>", or "per day|hour|…" (`unit`). */
  group?: { span: string; unit?: string; field?: { words?: string; phrase?: PhraseClaim } };
}

type AggregateFn = 'avg' | 'sum' | 'min' | 'max';
const AGGREGATE_WORDS: Record<string, AggregateFn> = {
  average: 'avg',
  avg: 'avg',
  mean: 'avg',
  total: 'sum',
  sum: 'sum',
  min: 'min',
  minimum: 'min',
  lowest: 'min',
  max: 'max',
  maximum: 'max',
  highest: 'max'
};
/** Superlatives that are an ordering (#1903) unless the field is followed by one of these. */
const VALUE_SUPERLATIVES = new Set(['highest', 'lowest']);
const VALUE_OF = new Set(['of', 'for']);
/** A word right after "by" that sets an ordering's direction ("top 10 items by lowest price"). */
const DIRECTION_WORDS: Record<string, 'asc' | 'desc'> = {
  lowest: 'asc',
  smallest: 'asc',
  least: 'asc',
  highest: 'desc',
  largest: 'desc',
  most: 'desc'
};
/** A field grouping runs one frame per value: more than this is dropped. */
const MAX_GROUPS = 20;
const BUCKET_WORDS = new Set(['hour', 'day', 'week', 'month', 'year']);

/**
 * Claims one aggregate. "highest|lowest <field>" is a value only when "of" or
 * "for" follows the field and a type is named after it, none before the
 * superlative ("the highest price of items"); otherwise it stays an ordering
 * ("items with the highest price", "… highest price for last week").
 */
function claimAggregate(
  tokens: Token[],
  walkClaims: WalkClaims,
  pack: NamespacePack,
  rulings: NamespaceRulings,
  /** First token index of each type mention. */
  mentions: number[]
): AggregateClaim | null {
  const ofFollows = (end: number) => VALUE_OF.has(tokens[end + 1]?.text ?? '');
  const valueAt = (start: number, end: number) =>
    ofFollows(end) && mentions.some((m) => m > end) && !mentions.some((m) => m < start);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    const fn = own(AGGREGATE_WORDS, t.text);
    if (fn === undefined) continue;
    let f: FieldWords | null = null;
    if (t.used) {
      // "highest <field phrase>" was claimed as a walk pick: a value question takes it back.
      const pick = walkClaims.picks.find((k) => k.at[0] === i && k.at[1] === i);
      if (pick === undefined || pick.phrase.field === undefined || !valueAt(i, pick.phrase.at[1]))
        continue;
      walkClaims.picks.splice(walkClaims.picks.indexOf(pick), 1);
      f = { phrase: pick.phrase, span: pick.phrase.span, end: pick.phrase.at[1] };
    } else {
      let j = i + 1;
      while (!(tokens[j]?.used ?? true) && (tokens[j]?.text === 'of' || tokens[j]?.text === 'the'))
        j++;
      f = fieldAt(tokens, walkClaims, pack, rulings, j, false);
      if (f === null || (VALUE_SUPERLATIVES.has(t.text) && !valueAt(i, f.end))) continue;
    }
    takeField(tokens, walkClaims, i, f);
    const claim: AggregateClaim = {
      span: tokens
        .slice(i, f.end + 1)
        .map((x) => x.text)
        .join(' '),
      word: t.text,
      fn,
      field: fieldRef(f)
    };
    for (let k = 0; k < tokens.length; k++) {
      const by = tokens[k] as Token;
      if (by.used || (by.text !== 'by' && by.text !== 'per')) continue;
      if (AUTHOR_VERBS.has(tokens[k - 1]?.text ?? '')) continue;
      const next = tokens[k + 1];
      if (next !== undefined && !next.used && BUCKET_WORDS.has(next.text)) {
        by.used = next.used = true;
        claim.group = { span: `${by.text} ${next.text}`, unit: next.text };
        break;
      }
      const g = fieldAt(tokens, walkClaims, pack, rulings, k + 1, false);
      if (g === null) continue;
      takeField(tokens, walkClaims, k, g);
      claim.group = { span: `${by.text} ${g.span}`, field: fieldRef(g) };
      break;
    }
    return claim;
  }
  return null;
}

/**
 * The seed field words or a field phrase name on `type`, or why there is none:
 * `doing` names the act when the field is on another type ("ordering").
 */
function seedField(
  o: { span: string; words?: string; phrase?: PhraseClaim },
  type: string,
  pack: NamespacePack,
  rulings: NamespaceRulings,
  doing: string
): { name: string; f: PackField } | { reason: string } {
  const fields = own(pack.types, type)?.fields ?? {};
  const walked = { reason: `${doing} across a walk is not supported` };
  let name: string | null;
  if (o.phrase !== undefined) {
    if (o.phrase.type !== type) return walked;
    name = o.phrase.field ?? null;
  } else {
    const words = o.words ?? '';
    name = fieldByWords(words, fields, rulings);
    if (name === null)
      return Object.values(pack.types).some((t) => fieldByWords(words, t.fields, rulings) !== null)
        ? walked
        : { reason: `${type} has no field "${words}"` };
  }
  const f = name === null ? undefined : fields[name];
  if (name === null || f === undefined) return { reason: `${type} has no field "${o.span}"` };
  return { name, f };
}

/** An aggregate claim read on `type`: its function and field, or drops saying why not. */
function aggregateOn(
  c: AggregateClaim,
  type: string,
  pack: NamespacePack,
  rulings: NamespaceRulings
): {
  fn?: AggregateFn;
  field?: string;
  exclude?: Record<string, unknown>;
  group?: { field: string; values: (string | boolean)[] };
  dateGroup?: { field: string; by: 'day' | 'hour' };
  dropped: Dropped[];
  evidence: Evidence[];
} {
  const r = seedField({ span: c.span, ...c.field }, type, pack, rulings, 'aggregating');
  const wants = c.fn === 'min' || c.fn === 'max' ? ['number', 'date'] : ['number'];
  const reason =
    'reason' in r
      ? r.reason
      : (r.f.kind === 'scalar' || r.f.kind === 'metadata') && wants.includes(r.f.valueType ?? '')
        ? null
        : `${c.word} needs a ${wants.join(' or ')} field; ${r.name} is a ${r.f.valueType ?? r.f.kind} field`;
  // Without a field there is no value to give: a dropped filter, so the strict reading is unknown.
  if (reason !== null || 'reason' in r)
    return { dropped: [{ span: c.span, reason: reason ?? '', kind: 'filter' }], evidence: [] };
  const out: ReturnType<typeof aggregateOn> = {
    fn: c.fn,
    field: r.name,
    dropped: [],
    evidence: [{ span: c.span, role: 'aggregate', detail: `${c.fn} ${r.name}` }]
  };
  const exclude = c.field.phrase?.entry.exclude;
  if (exclude !== undefined) out.exclude = exclude;
  const g = c.group;
  if (g === undefined) return out;
  // A grouping that cannot be expressed leaves the same rows: the whole value still answers.
  const drop = (why: string) => {
    out.dropped.push({ span: g.span, reason: why, kind: 'order' });
    return out;
  };
  if (g.unit !== undefined) {
    if (g.unit !== 'day' && g.unit !== 'hour')
      return drop('only day and hour groupings are supported');
    const field = own(rulings.timeField, type) ?? 'createdAt';
    out.dateGroup = { field, by: g.unit };
    out.evidence.push({ span: g.span, role: 'field', detail: `bucket ${field} by ${g.unit}` });
    return out;
  }
  const gr = seedField({ span: g.span, ...g.field }, type, pack, rulings, 'grouping');
  if ('reason' in gr) return drop(gr.reason);
  const values =
    gr.f.valueType === 'boolean' ? [true, false] : gr.f.kind === 'scalar' ? gr.f.enum : undefined;
  if (values === undefined)
    return drop(
      `only enum and yes/no fields group; ${gr.name} is a ${gr.f.valueType ?? gr.f.kind} field`
    );
  if (values.length > MAX_GROUPS)
    return drop(
      `${gr.name} has ${values.length} values; grouping runs one frame per value, at most ${MAX_GROUPS}`
    );
  out.group = { field: gr.name, values };
  out.evidence.push({ span: g.span, role: 'field', detail: `group by ${gr.name}` });
  return out;
}

/** An ordering by one value a crossRef hop away: the frame `_agg` it sorts by. */
interface HopOrder {
  /** The `_agg` and select name. */
  name: string;
  agg: Record<string, unknown>;
  /** "max(Item.price) per supplier", "Supplier.rating via supplier". */
  label: string;
}

/** The seed field an ordering sorts by on `type`, the value one hop away, or why neither. */
function orderField(
  o: FieldOrder,
  type: string,
  pack: NamespacePack,
  rulings: NamespaceRulings
): { field: string } | { hop: HopOrder } | { reason: string } {
  const away = fieldAway(o, type, pack, rulings);
  if (away !== null) return 'reason' in away ? away : hopOrder(o, type, away, pack, rulings);
  const r = seedField(o, type, pack, rulings, 'ordering');
  if ('reason' in r) return r;
  const { name, f } = r;
  if (o.pick !== undefined) return { reason: pickReason(o.pick, `${type}.${name}`, type) };
  const sortable =
    (f.kind === 'scalar' || f.kind === 'metadata') &&
    (f.valueType === 'number' || (f.valueType === 'date' && o.numeric !== true));
  if (!sortable)
    return {
      reason:
        o.numeric === true
          ? `"most" needs a number field; ${name} is a ${f.valueType ?? f.kind} field`
          : `${name} is a ${f.valueType ?? f.kind} field; only number and date fields order`
    };
  return { field: name };
}

/** Why a pick word cannot order: it is not a direction, or there is one value per seed row. */
function pickReason(pick: { span: string; kind: string }, field: string, seed: string): string {
  return pick.kind === 'latest'
    ? `"${pick.span}" picks one of many rows; ${field} is one value per ${seed.toLowerCase()}`
    : `"${pick.span}" is not an ordering direction; say lowest or highest`;
}

/** The field an ordering names on a type other than `seed`, null when it is the seed's (or none). */
function fieldAway(
  o: FieldOrder,
  seed: string,
  pack: NamespacePack,
  rulings: NamespaceRulings
): { type: string; field: string } | { reason: string } | null {
  if (o.phrase !== undefined) {
    const { type, field } = o.phrase;
    return type === undefined || field === undefined || type === seed ? null : { type, field };
  }
  const words = o.words ?? '';
  if (o.type !== undefined) {
    if (o.type === seed) return null;
    const field = fieldByWords(words, own(pack.types, o.type)?.fields ?? {}, rulings);
    return field === null
      ? { reason: `${o.type} has no field "${words}"` }
      : { type: o.type, field };
  }
  if (fieldByWords(words, own(pack.types, seed)?.fields ?? {}, rulings) !== null) return null;
  const on = Object.entries(pack.types)
    .filter(([t, def]) => t !== seed && fieldByWords(words, def.fields, rulings) !== null)
    .map(([t]) => t)
    .sort();
  if (on.length === 0) return null;
  if (on.length > 1)
    return { reason: `"${words}" names a field on several types: ${on.join(', ')}` };
  const type = on[0] as string;
  return {
    type,
    field: fieldByWords(words, own(pack.types, type)?.fields ?? {}, rulings) as string
  };
}

/**
 * The `_agg` an ordering by `<type>.<field>` sorts the seed by, over the one
 * crossRef hop between them. Out to one row, its value; in from many, a pick:
 * the asked one ("latest", "lowest" …), else max for a descending order and
 * min for an ascending one.
 */
function hopOrder(
  o: FieldOrder,
  seed: string,
  to: { type: string; field: string },
  pack: NamespacePack,
  rulings: NamespaceRulings
): { hop: HopOrder } | { reason: string } {
  const paths = findPaths(pack, seed, to.type);
  if (paths.length === 0)
    return { reason: `no crossRef path from ${seed} to ${to.type} within 3 hops` };
  if (paths.length > 1)
    return {
      reason: `several equally short paths from ${seed} to ${to.type}: ${paths
        .map((p) => pathLabel(pack.namespace, p))
        .join('; ')}`
    };
  const path = paths[0] as Path;
  if (path.length > 1)
    return { reason: `ordering across ${path.length} hops is not supported; one hop only` };
  const f = own(pack.types, to.type)?.fields[to.field];
  const qualified = `${to.type}.${to.field}`;
  if (f === undefined || (f.kind !== 'scalar' && f.kind !== 'metadata') || f.valueType !== 'number')
    return {
      reason: `ordering across a hop needs a number field; ${qualified} is a ${f?.valueType ?? f?.kind} field`
    };
  const h = path[0] as Hop;
  if (o.pick !== undefined && (h.dir === 'out' || o.pick.kind !== 'latest'))
    return { reason: pickReason(o.pick, qualified, seed) };
  const cap = to.field.charAt(0).toUpperCase() + to.field.slice(1);
  const exclude = o.phrase?.entry.exclude;
  const where = exclude !== undefined ? { where: { NOT: exclude } } : {};
  if (h.dir === 'out') {
    const name = `${to.type.charAt(0).toLowerCase()}${to.type.slice(1)}${cap}`;
    return {
      hop: {
        name,
        agg: { out: h.field, ...where, max: to.field },
        label: `${qualified} via ${h.field}`
      }
    };
  }
  const kind = o.pick?.kind ?? o.phrase?.entry.pick ?? (o.dir === 'desc' ? 'max' : 'min');
  const by = own(rulings.timeField, to.type) ?? 'createdAt';
  return {
    hop: {
      name: `${kind}${to.type}${cap}`,
      agg: {
        in: `${pack.namespace}/${h.owner}.${h.field}`,
        ...where,
        ...(kind === 'latest' ? { latest: { by, value: to.field } } : { [kind]: to.field })
      },
      label: `${kind}(${qualified}) per ${seed.toLowerCase()}`
    }
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
  const free = (t: Token | undefined): t is Token =>
    t !== undefined && !t.used && !GLUE.has(t.text);
  const num = (t: Token | undefined) => free(t) && /^\d+$/.test(t.text);
  const out: string[] = [];
  tokens.forEach((t, i) => {
    if (!free(t) || num(t)) return;
    // A number beside an unexplained word is lost with it: "8 cores", never just "cores".
    const before = num(tokens[i - 1]) ? `${tokens[i - 1]?.text} ` : '';
    const after =
      num(tokens[i + 1]) && !(free(tokens[i + 2]) && !num(tokens[i + 2]))
        ? ` ${tokens[i + 1]?.text}`
        : '';
    out.push(`${before}${t.text}${after}`);
  });
  return out;
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
  // "between 1st sep 2026 and 15th sep 2026" is the longest phrase: eight words.
  claimNgrams(tokens, 8, (key, at) => {
    if (found !== null) return false;
    const range = rangeFor(key, asOf);
    if (range === null) return false;
    found = { span: key, range, at: [at[0] as number, at[at.length - 1] as number] };
    return true;
  });
  return found;
}
