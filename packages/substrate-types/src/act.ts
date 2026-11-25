import type { EngineInput } from './plugin.js';
import type { Identity } from './policy.js';
import type { FieldDef } from './schema.js';

/** Actions every type has without declaring them. */
export const BUILT_IN_ACTIONS = ['create', 'update', 'find', 'count'] as const;
export type ActMode = 'write' | 'dry-run';

export type ActionParamDecl =
  | { type: FieldDef; default?: string | number | boolean | null; optional?: boolean }
  | { list: string; optional?: boolean }; // list: '<ns>/<Type>', elements are references
export type ActionSetValue = string | number | boolean | null | { param: string } | { now: true };
/** `action` is '<ns>/<Type>.<name>'. */
export interface ActionThenDecl {
  action: string;
  each: { param: string };
}
export interface ActionDecl {
  kind?: 'update' | 'create';
  /**
   * A mutation of the type's namespace to call in place of the generated
   * `<kind><Type>`: for a type whose writes are its plugin's own mutations.
   * `update` passes the reference as `id`, `create` takes none, and each
   * `field=value` is one of that mutation's params.
   */
  mutation?: string;
  past?: string;
  params?: Record<string, ActionParamDecl>;
  set?: Record<string, ActionSetValue>;
  then?: ActionThenDecl[];
}
/** Published form, in TypeSchema.actions; the compiler reads only this. */
export interface ActionSchema {
  kind: 'update' | 'create';
  mutation?: string;
  past?: string;
  params: Record<string, ActionParamDecl>;
  set: Record<string, ActionSetValue>;
  /** Object.keys(set) */
  fixed: string[];
  then: ActionThenDecl[];
  /** A word coined at runtime rather than declared in code. */
  coined?: true;
  /** Set on the proposer's own view of a word still earning promotion. */
  pending?: { uses: number; needed: number };
}
export interface PendingAction {
  decl: ActionDecl;
  uses: number;
  needed: number;
}
/** The plugin-side store of coined action words, installed with `EngineHandle.setActionLayer`. */
export interface ActionLayer {
  /** '<controlNs>/propose_action': the frame key `define` compiles to. */
  readonly proposeKey: string;
  /** Published coined words in `ns`: type name → action name → decl. */
  published(ns: string): Record<string, Record<string, ActionDecl>>;
  /** The caller's live (not lapsed) pending words: qualified type → name → pending. */
  pendingFor(identityId: string): Record<string, Record<string, PendingAction>>;
  /** After a committed write run; fire and forget. */
  used(identityId: string, actions: ReadonlyArray<{ type: string; name: string }>, at: Date): void;
}

/** The published form of a declaration, defaults filled in. */
export function toActionSchema(decl: ActionDecl): ActionSchema {
  const set = decl.set ?? {};
  return {
    kind: decl.kind ?? 'update',
    ...(decl.mutation !== undefined ? { mutation: decl.mutation } : {}),
    ...(decl.past !== undefined ? { past: decl.past } : {}),
    params: decl.params ?? {},
    set,
    fixed: Object.keys(set),
    // biome-ignore lint/suspicious/noThenProperty: `then` is the action declaration's key
    then: decl.then ?? []
  };
}

export type ActValue = string | number | boolean | null | ActValue[];
export interface ActStep {
  action: string;
  type?: string;
  refs?: string[];
  args?: Record<string, ActValue>;
  as?: string;
}
export interface ActRefusal {
  code: 'sketch_unresolved';
  step: number;
  token: string;
  problem: string;
  choices: string[];
  nearest: string | null;
}
/**
 * Filled at execution: a binding's id, `ctx.now`, or the id of the one `type`
 * record with `shortId`, or whose `field` holds `value`.
 */
export type ActLate =
  | { bind: string }
  | { now: true }
  | { ref: { type: string; shortId: number } | { type: string; field: string; value: unknown } };
export interface ActPlanStep {
  /** 1-based, after expansion. */
  step: number;
  /** 1-based sketch step it came from. */
  source: number;
  /** 'close', 'create', 'find', ... */
  action: string;
  /** Qualified, 'cortext/Todo'. */
  type: string;
  /** 'cortext/updateTodo', or 'cortext/Todo' for find/count. */
  key: string;
  operation: 'query' | 'mutate';
  /** Literal frame params. */
  params: Record<string, unknown>;
  /** Params filled at execution: a binding's id, or ctx.now. */
  late?: Record<string, ActLate>;
  fields: Record<string, true>;
  past?: string;
  bind?: string;
}
export interface ActPlan {
  steps: ActPlanStep[];
}
export interface ActHelp {
  /** `?`: ns -> Type -> action names. */
  types?: Record<string, Record<string, string[]>>;
  /** `? Todo`: qualified name. */
  type?: string;
  actions?: Record<
    string,
    {
      kind: 'update' | 'create';
      /** The namespace mutation the action calls, when it is not the generated one. */
      mutation?: string;
      params: Record<string, { type: string; required: boolean }>;
      /** A pending word's counted uses so far, and the uses it needs to publish. */
      pending?: { uses: number; needed: number };
    }
  >;
  fields?: Record<string, { type: string; required: boolean }>;
  /** `? define`: how a define step is written. */
  syntax?: string;
}
export interface ActStepOutcome {
  step: number;
  action: string;
  type: string;
  touched?: Array<{ id: string; shortId?: number }>;
  rows?: Record<string, unknown>[];
  truncated?: boolean;
  count?: number;
}
export interface ActResultRecord {
  id: string;
  /** The caller's id, for display. */
  owner: string;
  /**
   * Lowercase hex SHA-256 of the caller's dedup component (id, roles, scopes
   * and grant). Reads and idempotency match on this, so a credential with a
   * narrower grant under the same id sees none of a broader one's records.
   */
  ownerKey: string;
  createdAt: string;
  expiresAt: string;
  mode: ActMode;
  ok: boolean;
  ack?: string;
  idempotencyKey?: string;
  schemaVersion: string;
  sketch: string | ActStep[];
  plan: ActPlan;
  steps: ActStepOutcome[];
  error?: { code: string; message: string; step?: number };
}
export interface ActResultStore {
  put(record: ActResultRecord, ttlMs: number): Promise<void>;
  get(id: string, ownerKey: string): Promise<ActResultRecord | undefined>;
  findByIdempotencyKey(ownerKey: string, key: string): Promise<ActResultRecord | undefined>;
  reapExpired(): Promise<{ deleted: number }>;
}
export interface ActRequest {
  sketch: string | ActStep[];
  mode?: ActMode;
  namespace?: string;
  idempotencyKey?: string;
}
export interface ActInput extends ActRequest {
  ctx: EngineInput['ctx'];
  signal?: AbortSignal;
  /** Caps each `find` step's page at `maxLimit`, as for a query from the same transport. */
  pageLimits?: EngineInput['pageLimits'];
}
export type ActResponse =
  | {
      ok: true;
      ack: string;
      result: string | null;
      /** The `find` steps' rows, when there are any and at most 100 in all. */
      found?: ActStepOutcome[];
      /** A dry run's compiled steps, one sketch-like line each, with every value they send. */
      plan?: string[];
      /** The sketch's `?` steps, answered beside its other steps. */
      help?: ActHelp | ActHelp[];
    }
  | { ok: true; help: ActHelp | ActHelp[] }
  | { ok: false; refusal: ActRefusal }
  | { ok: false; error: { code: string; message: string; step?: number }; result: string | null };
export interface ActHandle {
  act(input: ActInput): Promise<ActResponse>;
  actResult(id: string, identity: Identity | null): Promise<ActResultRecord | undefined>;
}
