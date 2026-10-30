/**
 * The natural-language surface on the wire: `POST /substrate/v1/nl` (JSON or SSE) and
 * `GET /substrate/v1/nl/pack/:ns`. One definition, shared by the `substrate-nl` plugin
 * that serves it and the `substrate-client` that consumes it, so a drift between
 * them fails the type-check rather than a user.
 *
 * `./nl.ts` holds the translation primitives (`Query`, `NLResult`); this file is
 * the route's request and response.
 *
 * Absence on the wire: `JSON.stringify` drops `undefined`, so a rejected `rows`
 * outcome arrives with NO `data` key and a rejected `recall` outcome with NO
 * `hits` key. Test for presence (`Array.isArray`, `'data' in o`); do not rely on
 * `=== undefined` of a field the type marks required.
 */
import type { Query } from './nl.js';

export interface NlAskRequest {
  namespace: string;
  question: string;
  project?: string;
  /** Force the reading to this type; resubmit a clarify option's `type`. Must name a type of the namespace. */
  type?: string;
}

export type NlParseStatus =
  | 'resolved'
  | 'ambiguous'
  | 'partial'
  | 'clarify'
  | 'refuse'
  | 'unparsed';

export interface NlEvidence {
  span: string;
  role:
    | 'id'
    | 'type'
    | 'value'
    | 'time'
    | 'order'
    | 'count'
    | 'scope'
    | 'field'
    | 'author'
    | 'history';
  detail: string;
}

export type NlJudgeAction = 'pick' | 'type' | 'bind' | 'recall' | 'clarify' | 'refuse' | 'escalate';

export interface NlJudgeChoice {
  action: NlJudgeAction;
  candidate?: number;
  type?: string;
  word?: string;
  /** `Type.field`. */
  field?: string;
  op?: 'eq' | 'startsWith' | 'contains';
}

export interface NlJudgeStep {
  parse: { status: NlParseStatus; reason?: string };
  choice?: NlJudgeChoice;
  /** Why the reply was not applied. */
  rejected?: string;
}

/** What an ask answered. The four kinds are exhaustive. */
export type NlOutcome =
  | {
      kind: 'rows';
      frame: Query;
      answer: string;
      /** Absent on the wire when the engine rejected the frame; `errors` then says why. */
      data: unknown;
      /** On a `count` answer: every row the frame matches, across pages; `data` holds only the first page. Absent when counting stopped short, with `errors` saying why. */
      count?: number;
      errors?: unknown[];
      source: 'parser' | 'judge' | 'handoff';
      handoff?: string;
    }
  | {
      kind: 'recall';
      query: string;
      /** Absent on the wire when the engine rejected the frame. */
      hits: unknown[] | undefined;
      errors?: unknown[];
    }
  | {
      kind: 'clarify';
      question: string;
      reason: string;
      options: { label: string; question: string; type: string }[];
    }
  | { kind: 'refuse'; reason: string };

export interface NlParsedData {
  status: NlParseStatus;
  frame?: Query;
  evidence: NlEvidence[];
  residual: string[];
  reason?: string;
}

export type NlJudgedStatus = 'resolved' | 'recall' | 'clarify' | 'refuse' | 'escalated';

/**
 * One SSE event, discriminated by the SSE event name. The terminal answer is
 * named by its outcome kind (`rows` | `recall` | `clarify` | `refuse`) and
 * carries the whole outcome; `done` always follows. An in-band `error` event
 * is not in this union: the client throws on it.
 */
export type NlWireEvent =
  | { event: 'parsed'; data: NlParsedData }
  | { event: 'judging'; data: { reason: string } }
  | { event: 'judged'; data: { status: NlJudgedStatus; trail: NlJudgeStep[] } }
  | { event: 'rows'; data: Extract<NlOutcome, { kind: 'rows' }> }
  | { event: 'recall'; data: Extract<NlOutcome, { kind: 'recall' }> }
  | { event: 'clarify'; data: Extract<NlOutcome, { kind: 'clarify' }> }
  | { event: 'refuse'; data: Extract<NlOutcome, { kind: 'refuse' }> }
  | { event: 'done'; data: Record<string, never> };

/**
 * The JSON encoding's trail spells the terminal event `outcome`, where SSE
 * names it by the outcome kind.
 */
export type NlTrailEvent =
  | ({ event: 'parsed' } & NlParsedData)
  | { event: 'judging'; reason: string }
  | { event: 'judged'; status: NlJudgedStatus; trail: NlJudgeStep[] }
  | { event: 'outcome'; outcome: NlOutcome }
  | { event: 'done' };

/** The JSON encoding of `POST /substrate/v1/nl`. `outcome` is null only when the run was aborted. */
export interface NlAskResult {
  outcome: NlOutcome | null;
  trail: NlTrailEvent[];
}

export interface NlPackField {
  name: string;
  /** `metadata` marks a server-managed virtual (createdAt, createdById, ...). */
  kind: 'scalar' | 'crossRef' | 'list' | 'struct' | 'metadata';
  valueType?: string;
  /** crossRef target. */
  target?: { namespace: string; type: string };
  indexed: boolean;
  operators: string[];
  phrases: string[];
  enum?: string[];
  /** Vocabulary aliases from the schema (alias -> canonical). The server applies them. */
  aliases?: Record<string, string>;
  /** Distinct values in the profile when the field is vocabulary. */
  distinct?: number;
}

export interface NlPackType {
  name: string;
  /** Lower-case phrases that name the type: singular, plural, head noun. */
  phrases: string[];
  fields: Record<string, NlPackField>;
}

export interface NlPackValueRef {
  type: string;
  field: string;
  /** The value as stored, original casing. */
  value: string;
}

export interface NlNamespacePack {
  namespace: string;
  schemaVersion: string;
  types: Record<string, NlPackType>;
  /** Lower-cased value -> every (type, field) it occurs in, sorted. */
  values: Record<string, NlPackValueRef[]>;
}

export interface NlValueAlias {
  type: string;
  field: string;
  /** Exactly one of these. */
  in?: string[];
  eq?: string;
  startsWith?: string;
  contains?: string;
}

export interface NlNamespaceRulings {
  /** Types never scoped to the asking project (their `project` means "belongs to", not "applies to"). */
  unscopedTypes?: string[];
  /** Extra phrases naming a type, e.g. `backlog` -> Task. Win over the generated phrases. */
  typeAliases?: Record<string, string>;
  /** Extra phrases naming a field, e.g. `repo` -> project. */
  fieldAliases?: Record<string, string>;
  /**
   * The status value that means "live" for a type, e.g. `Task` -> `open`
   * ("the tasks" are the open ones). A list question about
   * the type defaults to it, and a bare live word ("what's open") picks the
   * types it is the live state of. Types not named here get no default.
   */
  liveStatus?: Record<string, string>;
  /**
   * The date a type is "when" by, where it is not `createdAt`: a Meeting
   * happened at `startedAt`, whenever its row was written. A field named in
   * the question, or a closing/updating verb, still wins.
   */
  timeField?: Record<string, string>;
  /** What a type records, in a phrase. Shown to the judge only; the parser never reads it. */
  typeNotes?: Record<string, string>;
  /** A phrase that means a predicate, e.g. `accepted` -> Decision.status in [active, accepted]. */
  valueAliases?: Record<string, NlValueAlias[]>;
}

/** The body of `GET /substrate/v1/nl/pack/:ns`. */
export interface NlServedPack extends NlNamespacePack {
  rulings: NlNamespaceRulings;
  warnings: string[];
}
