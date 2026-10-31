/**
 * Tier 1b: a constrained judge for what the parser escalates. The model never
 * writes a frame. It picks ONE choice from options generated for this
 * question (a candidate, a type, a word-to-field binding, recall, clarify,
 * refuse), its output constrained to those options by a JSON schema. The
 * choice is then applied deterministically and the parser runs again, so
 * every frame that comes out is still the parser's, tied to the words.
 */

import type { NlJudgeAction, NlJudgeChoice, NlJudgeStep } from '@mnmal-ai/substrate/sdk';
import { own } from '../own.js';
import type { NamespaceRulings, ValueAlias } from '../pack/rulings.js';
import type { NamespacePack } from '../pack/types.js';
import {
  type Candidate,
  type ParseContext,
  type ParseResult,
  parseQuestion
} from '../parse/parse.js';

export type JudgeAction = NlJudgeAction;

export type JudgeChoice = NlJudgeChoice;

export interface JudgePrompt {
  system: string;
  user: string;
  /** JSON schema the reply must satisfy; every enum is drawn from this question. */
  schema: Record<string, unknown>;
}

/** Transport for one constrained decision. Returns the parsed JSON reply. */
export interface Judge {
  decide(prompt: JudgePrompt, signal?: AbortSignal): Promise<unknown>;
}

export type JudgeStep = NlJudgeStep;

export type JudgedResult =
  | { status: 'resolved'; candidate: Candidate; trail: JudgeStep[] }
  | { status: 'recall'; query: string; type: string; trail: JudgeStep[] }
  | { status: 'clarify' | 'refuse'; reason: string; trail: JudgeStep[] }
  | { status: 'escalated'; result: ParseResult; trail: JudgeStep[] };

/** String scalar fields a binding may target, as `Type.field`. */
function bindableFields(pack: NamespacePack, types: string[]): string[] {
  const out: string[] = [];
  for (const type of types) {
    for (const [name, f] of Object.entries(pack.types[type]?.fields ?? {})) {
      if (f.kind === 'scalar' && f.valueType === 'string' && f.indexed) out.push(`${type}.${name}`);
    }
  }
  return out.sort();
}

/** Build the options, the prompt and the schema for one escalated parse. */
export function buildJudgePrompt(
  question: string,
  result: ParseResult,
  pack: NamespacePack,
  rulings: NamespaceRulings = {},
  rejected: string[] = []
): JudgePrompt {
  const allTypes = Object.keys(pack.types).sort();
  const words = [...new Set(result.residual)];
  const bindTypes =
    result.candidates.length > 0 ? [...new Set(result.candidates.map((c) => c.type))] : allTypes;
  const fields = bindableFields(pack, bindTypes);
  const branch = (action: JudgeAction, args: Record<string, unknown> = {}) => ({
    type: 'object',
    properties: { action: { const: action }, ...args },
    required: ['action', ...Object.keys(args)]
  });
  // One branch per action, each requiring its own arguments, so decoding
  // cannot produce an action without what it needs.
  const branches = [
    ...(result.candidates.length > 0
      ? [
          branch('pick', {
            candidate: { type: 'integer', enum: result.candidates.map((_, i) => i) }
          })
        ]
      : []),
    branch('type', { type: { type: 'string', enum: allTypes } }),
    ...(words.length > 0 && fields.length > 0
      ? [
          branch('bind', {
            word: { type: 'string', enum: words },
            field: { type: 'string', enum: fields },
            op: { type: 'string', enum: ['eq', 'startsWith', 'contains'] }
          })
        ]
      : []),
    // recall/Hit refuses a frame without `type`, so the judge names the type to search.
    branch('recall', { type: { type: 'string', enum: allTypes } }),
    branch('clarify'),
    branch('refuse'),
    branch('escalate')
  ];
  const schema = { anyOf: branches };

  const ruled = (t: string) =>
    Object.entries(rulings.typeAliases ?? {})
      .filter(([, type]) => type === t)
      .map(([phrase]) => phrase);
  const typeLines = allTypes.map((t) => {
    const note = rulings.typeNotes?.[t];
    const names = [...ruled(t), ...(pack.types[t]?.phrases ?? []).slice(0, 4)].join(', ');
    return `- ${t}${note !== undefined ? ` (${note})` : ''}: ${names}`;
  });
  const candidateLines = result.candidates.map(
    (c, i) =>
      `${i}. ${c.type} where ${JSON.stringify(Object.values(c.frame)[0]?.params.where ?? {})}` +
      ` (from: ${c.evidence.map((e) => `"${e.span}"=${e.detail}`).join('; ')})`
  );
  const system = [
    'You choose how a question about a data store should be answered. You do not write queries.',
    'A deterministic parser read the question first and could not settle it. Choose ONE action:',
    '- pick: one reading answers the WHOLE question as asked; leftover words are noise. If the',
    '  question needs rows of one type found through another, no single reading answers it.',
    '- type: the question lists or counts rows of one type; the parser then builds the query from the',
    '  question\'s own words (dates, "latest", known values). Prefer this when a type clearly fits.',
    '- bind: a leftover word is a value stored in a field: eq = the whole value, startsWith = a prefix',
    '  of a name or id, contains = a word inside a title or subject. Never bind a word that only',
    '  describes the question (e.g. "status", "called").',
    '- recall: the question asks what is known ABOUT a topic (free-text subject words, not field values);',
    '  semantic search over the text answers it. Name the type whose rows hold that knowledge.',
    '- clarify: RARE. Only when the question has two specific readings and nothing in it chooses one.',
    '  Missing detail is not ambiguity: if a type or a topic fits, choose type or recall.',
    '- refuse: the question is not about this store at all, or asks to change data.',
    '- escalate: none of these answers the question as asked (e.g. it needs two queries chained).',
    '',
    `Types in the "${pack.namespace}" store:`,
    ...typeLines
  ].join('\n');
  const user = [
    `Question: ${question}`,
    `Parser: ${result.status}${result.reason !== undefined ? ` (${result.reason})` : ''}`,
    ...(result.evidence !== undefined && result.evidence.length > 0
      ? [
          `Understood so far: ${result.evidence.map((e) => `"${e.span}" = ${e.role} ${e.detail}`).join('; ')}`
        ]
      : []),
    ...(candidateLines.length > 0 ? ['Readings:', ...candidateLines] : []),
    ...(words.length > 0 ? [`Leftover words: ${words.join(', ')}`] : []),
    ...rejected.map((r) => `Already tried and rejected: ${r}`)
  ].join('\n');
  return { system, user, schema };
}

/** Check a reply against the options it was offered. */
export function checkChoice(reply: unknown, prompt: JudgePrompt): JudgeChoice | string {
  if (typeof reply !== 'object' || reply === null) return 'reply is not an object';
  const r = reply as Record<string, unknown>;
  const branches = (prompt.schema.anyOf ?? []) as Array<{
    properties: Record<string, { const?: unknown; enum?: unknown[] }>;
    required: string[];
  }>;
  const branch = branches.find((b) => b.properties.action?.const === r.action);
  if (branch === undefined) return `action ${JSON.stringify(r.action)} was not offered`;
  const choice: Record<string, unknown> = { action: r.action };
  for (const key of branch.required) {
    if (key === 'action') continue;
    if (branch.properties[key]?.enum?.includes(r[key]) !== true) {
      return `${String(r.action)} needs an offered ${key}`;
    }
    choice[key] = r[key];
  }
  return choice as unknown as JudgeChoice;
}

/** A binding becomes a one-question ruling, so the parser applies it like any other. */
function withBinding(rulings: NamespaceRulings | undefined, choice: JudgeChoice): NamespaceRulings {
  const [type, field] = (choice.field as string).split('.') as [string, string];
  const word = choice.word as string;
  const alias: ValueAlias =
    choice.op === 'startsWith'
      ? { type, field, startsWith: word }
      : choice.op === 'contains'
        ? { type, field, contains: word }
        : { type, field, eq: word };
  return {
    ...(rulings ?? {}),
    valueAliases: { ...(rulings?.valueAliases ?? {}), [word]: [alias] }
  };
}

export interface JudgeOptions {
  /** Judge rounds before giving up. Default 3. */
  rounds?: number;
  /**
   * Does any row of `type` match `where`? A binding is applied only when its
   * value occurs in the data: a bound value that matches nothing is the
   * judge reading a word as data that is not data. Omitted, bindings are
   * checked against the schema only.
   */
  exists?: (type: string, where: Record<string, unknown>) => Promise<boolean>;
  /** Aborts the in-flight judge call. */
  signal?: AbortSignal;
}

/** Why a binding cannot be applied, or null when it grounds. */
async function verifyBinding(
  choice: JudgeChoice,
  earlier: JudgeChoice[],
  pack: NamespacePack,
  opts: JudgeOptions
): Promise<string | null> {
  const [type, field] = (choice.field as string).split('.') as [string, string];
  const word = choice.word as string;
  const def = own(own(pack.types, type)?.fields, field);
  if (def === undefined) return `${type}.${field} is not a field`;
  if (!def.operators.includes(choice.op as string))
    return `${type}.${field} does not accept ${choice.op}`;
  if (def.enum !== undefined && choice.op === 'eq') {
    const known = [...def.enum, ...Object.keys(def.aliases ?? {})].map((v) => v.toLowerCase());
    if (!known.includes(word.toLowerCase())) return `"${word}" is not a ${type}.${field} value`;
  }
  if (opts.exists === undefined) return null;
  // Bindings must ground TOGETHER: three words that each occur somewhere can
  // still describe no row at all.
  const predicate = (c: JudgeChoice) => ({
    [(c.field as string).split('.')[1] as string]: { [c.op as string]: c.word }
  });
  const same = earlier.filter((c) => (c.field as string).startsWith(`${type}.`));
  const where = same.length === 0 ? predicate(choice) : { AND: [...same, choice].map(predicate) };
  if (!(await opts.exists(type, where))) {
    return same.length === 0
      ? `no ${type} has ${field} ${choice.op} "${word}"`
      : `no ${type} matches it together with ${same.map((c) => `"${c.word}"`).join(', ')}`;
  }
  return null;
}

/**
 * Parse; while the parse is not resolved, ask the judge and apply its choice.
 * A refused, clarified or resolved parse never reaches the model.
 */
export async function parseWithJudge(
  question: string,
  pack: NamespacePack,
  ctx: ParseContext,
  judge: Judge,
  opts: JudgeOptions = {}
): Promise<JudgedResult> {
  const trail: JudgeStep[] = [];
  let context = ctx;
  let result = parseQuestion(question, pack, context);
  const rejected: string[] = [];
  const bound: JudgeChoice[] = [];
  for (let round = 0; round < (opts.rounds ?? 3); round++) {
    if (result.status === 'resolved') {
      return { status: 'resolved', candidate: result.candidates[0] as Candidate, trail };
    }
    if (result.status === 'refuse' || result.status === 'clarify') {
      return { status: result.status, reason: result.reason ?? '', trail };
    }
    const step: JudgeStep = {
      parse: {
        status: result.status,
        ...(result.reason !== undefined ? { reason: result.reason } : {})
      }
    };
    trail.push(step);
    const prompt = buildJudgePrompt(question, result, pack, context.rulings, rejected);
    const reply = await judge.decide(prompt, opts.signal);
    const checked = checkChoice(reply, prompt);
    if (typeof checked === 'string') {
      step.rejected = checked;
      break;
    }
    step.choice = checked;
    // The judge chooses; it never authors. Anything it adds (a walk, a comparison) is dropped here, on the record.
    const extra = Object.keys(reply as object).filter((k) => !Object.hasOwn(checked, k));
    if (extra.length > 0) step.ignored = extra.sort();
    switch (checked.action) {
      case 'pick': {
        const chosen = result.candidates[checked.candidate as number] as Candidate;
        // A reading that dropped part of the question is never resolved, by anyone.
        if (chosen.dropped.length > 0) {
          const reason = `dropped: ${chosen.dropped.map((d) => `"${d.span}" (${d.reason})`).join('; ')}`;
          return {
            status: 'escalated',
            result: { status: 'partial', candidates: [chosen], residual: chosen.residual, reason },
            trail
          };
        }
        return { status: 'resolved', candidate: chosen, trail };
      }
      case 'recall':
        return { status: 'recall', query: question, type: checked.type as string, trail };
      case 'clarify':
      case 'refuse':
        return { status: checked.action, reason: 'judge', trail };
      case 'type':
        context = { ...context, forceType: checked.type as string };
        break;
      case 'escalate':
        return { status: 'escalated', result, trail };
      case 'bind': {
        const why = await verifyBinding(checked, bound, pack, opts);
        if (why !== null) {
          // Tell the judge and ask again: the binding was a guess the data refuted.
          step.rejected = why;
          rejected.push(`bind ${checked.word} to ${checked.field} (${why})`);
          continue;
        }
        bound.push(checked);
        context = { ...context, rulings: withBinding(context.rulings, checked) };
        break;
      }
    }
    result = parseQuestion(question, pack, context);
  }
  if (result.status === 'resolved') {
    return { status: 'resolved', candidate: result.candidates[0] as Candidate, trail };
  }
  return { status: 'escalated', result, trail };
}
