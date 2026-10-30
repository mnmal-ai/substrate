/**
 * Schema primitives. Spec: §6.1, §4.1, §4.2.
 *
 * FieldDef is the runtime representation of a `field.*` declaration
 * (e.g. `field.crossRef`). Variants may carry an optional `nullable` flag that is purely
 * metadata — the engine doesn't enforce nullability, but schema consumers
 * (publishSchema, substrate-pack, client decoders) use it to describe mutation
 * return shapes that legitimately surface `null` (e.g. `get<T>` / `update<T>`
 * on a missing id).
 */

import type { OnDelete, OnMissing } from './edge.js';
import type { IndexDecl } from './plugin.js';

/**
 * One clause of a walk-grammar read, marked index-served or not (typed edge
 * walks, goal 7). `path` is inside the frame entry, e.g. `['where', '_walk']`.
 * An unserved clause names the index that would serve it in `recommend`, when
 * one can be declared.
 */
export interface PlanClause {
  path: string[];
  kind: 'hop' | 'filter' | 'order' | 'ref' | 'derive' | 'bucket' | 'agg';
  served: boolean;
  recommend?: IndexDecl;
}

/** Words of a natural-language question the parse did not use, and why. */
export interface Dropped {
  span: string;
  reason: string;
}

export interface FieldDefScalar {
  kind: 'scalar';
  /**
   * `'json'` is an opaque body: msgpack-friendly nested object/array, value
   * round-trips unchanged, but no per-leaf filtering or ordering. Use it for
   * freeform payloads (audit details, debug bags). When you need filterable
   * inner keys, use `field.struct` instead.
   */
  type: 'string' | 'number' | 'boolean' | 'date' | 'json';
  /**
   * Tri-state. `true` builds an index (a btree; a GIN for json). Unset means
   * no index. `false` means no index AND not a search handle: long-form
   * prose that NL and similar consumers leave out. The field filters either
   * way. Physical consumers test `=== true`, so never normalise unset to
   * `false`.
   */
  indexed?: boolean;
  /** Metadata: when true, consumers SHOULD expect `null` as a legitimate value. */
  nullable?: boolean;
  /**
   * Metadata: when true, this field is populated by the engine (not the caller)
   * and write attempts that include it MUST be rejected. Used for the
   * auto-injected `shortId` field. Consumers (autoCRUD create, schema
   * publisher, client codegen) rely on this flag as a declarative contract —
   * do not imperatively guard readonly fields without also flipping this.
   */
  readonly?: boolean;
  /**
   * Server-managed date flag. Clients may not supply the field in the
   * indicated phase(s) — autoCRUD rejects it with `client_supplied_server_field`:
   *   - 'create' — on create only
   *   - 'update' — on update only
   *   - 'both'   — on create and update
   * Nothing stamps it automatically: server-side code (a custom resolver or a
   * system writer such as `applyUpdatePatch`) sets it. A non-nullable,
   * non-defaulted field gated on create is refused by autoCRUD at install,
   * since nothing could fill it. Only honoured on `type: 'date'`.
   */
  serverSet?: 'create' | 'update' | 'both';
  /**
   * Controlled vocabulary. When present, the value MUST be one of these
   * strings. Consumed by autoCRUD write-validation (covers memory + pg
   * uniformly) and surfaced verbatim in the published schema. `type` stays
   * 'string' — an enum is a constrained string, so pack / client decoder /
   * where-validation treat it identically with no new branch.
   */
  enum?: readonly string[];
  /**
   * Governed vocabulary: alias -> canonical value (each canonical value is in
   * `enum`). autoCRUD stores the canonical value when an alias is written, and
   * `where` filters on the field match it, so synonyms converge instead of
   * sprawling. Matching is case-insensitive. Published in the schema so every
   * client reads the same table.
   */
  aliases?: Readonly<Record<string, string>>;
  /**
   * `false` admits values outside `enum` (aliases are still normalised): a
   * transition mode for adopting a vocabulary over existing free-string data.
   * Absent means strict.
   */
  strict?: boolean;
  /**
   * Alias (or canonical value) -> sibling fields it implies, e.g.
   * `done -> { resolution: 'completed' }`. On write the siblings are filled
   * when the caller omits them and a contradicting value is refused; an
   * `eq` filter on the alias also matches the implied siblings. Keys match
   * case-insensitively.
   */
  implies?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * Default value applied by autoCRUD `create` when the caller omits this
   * field. Two effects: (1) the row is written with the default instead of
   * being absent; (2) it satisfies the non-nullable presence check, so a
   * non-nullable scalar WITHOUT a default that is omitted on create is
   * rejected (`missing_required_field`) — that is how "required" is expressed.
   * Only applied on create (update is a partial patch). The value should match
   * `type` (booleans for boolean, ISO string for date, etc.).
   */
  default?: string | number | boolean;
}

export interface FieldDefCrossRef {
  kind: 'crossRef';
  ns: string;
  type: string;
  onDelete: OnDelete; // default: 'set_null' — resolved at registration
  /**
   * Write-time existence policy. 'reject' refuses a create/update
   * whose crossRef value points at a non-existent or tombstoned target;
   * 'allow' is the default when absent. Consulted only at write time, never
   * stored on the edge. Enforced only for locally-resolvable
   * target namespaces (compose rejects 'reject' on bridged/unknown targets).
   */
  onMissing?: OnMissing;
  /**
   * Substrate-level indexing hint for the edge-source column, mirroring
   * `FieldDefScalar.indexed`, so the dataset need not infer it from the
   * presence of the crossRef itself.
   */
  indexed?: boolean;
  /** Metadata: when true, consumers SHOULD expect `null` as a legitimate value. */
  nullable?: boolean;
  /**
   * Activation-spreading opt-in. When `spread: true`,
   * recall hits on a row touching this crossRef propagate a damped salience
   * boost to the linked row (forward direction, X → row X references) AND to
   * rows whose same field points at the boosted row (backward direction,
   * X ← rows that reference X). Default off — operators opt in per-edge to
   * avoid polluting attention with low-signal edges (e.g. Decision.sessionId).
   *
   * Damping (typically 0.3) + depth bound (1) are configured on the recall
   * substrate, not per-field.
   */
  spread?: boolean;
  /**
   * Cross-TYPE opt-in for the recall expansion path.
   * Only meaningful when `spread: true` (the SDK `field.crossRef` builder
   * rejects `expandCrossType` without `spread` at registration). When both
   * are set, BACKWARD walks via this edge are allowed to surface neighbours
   * whose type differs from the request's `scope.type` (e.g. a Concept-typed
   * query surfaces Decisions via inbound `Decision.establishesConcept`).
   *
   * Cross-NAMESPACE expansion is always rejected regardless of this flag.
   * Forward walks always honour scope strictly: allowing them lets
   * neighbour-type rows displace the rows that establish them in the ranking.
   * Default false.
   */
  expandCrossType?: boolean;
}

export interface FieldDefStruct {
  kind: 'struct';
  fields: Record<string, FieldDef>;
  /** Metadata: when true, consumers SHOULD expect `null` as a legitimate value. */
  nullable?: boolean;
}

export interface FieldDefList {
  kind: 'list';
  of: FieldDef;
  /**
   * When true, the `has` (element membership) operator is backed by a GIN
   * index on `(body -> '<field>')`. List fields are stored as native JSONB
   * arrays. Default false — `has` on an unindexed list still works, by
   * scanning the type's rows. The substrate binary derives the matching GIN
   * as an idempotent migration at boot from this flag; no hand-authored
   * migration is needed per field.
   */
  indexed?: boolean;
  /** Metadata: when true, consumers SHOULD expect `null` as a legitimate value. */
  nullable?: boolean;
}

export type FieldDef = FieldDefScalar | FieldDefCrossRef | FieldDefStruct | FieldDefList;

/**
 * Per-type schema entry. Fields may be declared at registration time; MVP emits
 * `fields: {}` for types registered without a field map (e.g. mutations whose
 * shape is inferred from the resolver's return).
 */
export interface TypeSchema {
  fields: Record<string, FieldDef>;
  /** The type's natural order; absent means {@link DEFAULT_ORDERED_BY}. */
  orderedBy?: OrderedBy;
}

/**
 * A type's natural order: exactly one `{ field: direction }` key, the order a
 * read with no `orderBy` returns. The datasets still append `id` as the tie-break.
 */
export type OrderedBy = Record<string, 'asc' | 'desc'>;

/** Natural order of a type that declares none: newest first. */
export const DEFAULT_ORDERED_BY: OrderedBy = Object.freeze<OrderedBy>({ createdAt: 'desc' });

/** The declared natural order, or {@link DEFAULT_ORDERED_BY}. */
export function naturalOrderOf(schema: Pick<TypeSchema, 'orderedBy'>): OrderedBy {
  return schema.orderedBy ?? DEFAULT_ORDERED_BY;
}

/**
 * Per-mutation schema entry. `params` describes the input shape a client
 * sends; `returns` describes the shape a client decodes on success. Both are
 * required — an empty param bag surfaces as `{}`, never as an absent key.
 *
 * `returns` is typically a `FieldDefStruct` describing the row shape the
 * mutation produces (e.g. `create<T>` returns the inserted row; `delete<T>`
 * returns `{ id, deleted }`). `get<T>` and `update<T>` mark the struct
 * `nullable: true` because an id-miss legitimately produces `null`.
 *
 * Mutations registered without explicit `returns` metadata receive a sentinel
 * fallback (`{ kind: 'scalar', type: 'string', nullable: true }`) so substrate-pack
 * can still round-trip the response — clients treating it as "unknown shape"
 * should fall back to JSON passthrough.
 */
export interface MutationSchema {
  params: Record<string, FieldDef>;
  returns: FieldDef;
}

/**
 * The published schema shape surfaced at `GET /substrate/v1/schema`. Spec: §4.2, §6.1,
 * §7.1. `schemaVersion` is the 12-char SHA-256 prefix over the canonicalized
 * schema JSON and travels on every response envelope (§7.0) so the client can
 * detect drift.
 */
export interface Schema {
  schemaVersion: string;
  types: Record<string, TypeSchema>;
  mutations: Record<string, MutationSchema>;
  /** Present (true) on substrate-contributed virtual namespaces: no autoCRUD, no storage, query/mutate one-shot only. */
  virtual?: true;
  /**
   * The namespace's opaque per-consumer metadata (`defineNamespace` option).
   * Not part of `schemaVersion`: an annotations-only change does not move it.
   */
  annotations?: Readonly<Record<string, unknown>>;
}

/**
 * Per-key shape. A single frame resolves to `'single' | 'list'`, or for a
 * walk read to `'count'` (`data[key]` is `{ count }`) or `'groups'`
 * (`data[key]` is `{ groups, truncated? }`). A batched mutate op-key (array
 * of frames) resolves to `Array<'single' | 'list'>` — one shape per frame, in
 * frame-array order. The decoder keys off the discriminator: string → single
 * frame; array → batched.
 */
export type EnvelopeShape = 'single' | 'list' | 'count' | 'groups' | Array<'single' | 'list'>;

/**
 * The response envelope. Spec: §7.0.
 *
 * Query data values are positionally encoded using the client-sent `FieldInput`
 * selection; mutation data values are positionally encoded using the declared
 * `MutationSchema.returns` (§4.2) — mutations don't carry a FieldInput
 * since there's no field selection on a return row.
 */
export interface PackEnvelope {
  schemaVersion: string;
  data: Record<string, unknown>;
  shapes: Record<string, EnvelopeShape>;
  _meta?: Record<string, unknown>;
  _pagination?: Record<string, { nextCursor?: string; hasMore: boolean }>;
  /**
   * Per-top-level-key completeness. ABSENT MEANS COMPLETE — callers that
   * predate this field stay correct without change.
   *
   * Set when a bridged key could not be fully resolved (§6.5 "reads never
   * fail" means such a read still returns 200 with orphan markers). The
   * per-row `__orphan` marker says a row is missing; this says the RESULT SET
   * is partial, which a consumer cannot otherwise distinguish from an
   * genuinely empty result.
   */
  _completeness?: Record<string, { complete: boolean; unreachable?: string[] }>;
  /**
   * Non-fatal read diagnostics, keyed by top-level frame key. ABSENT MEANS
   * NOTHING TO REPORT — callers that predate this field stay correct without
   * change, same contract as `_completeness`.
   *
   * Deliberately NOT `errors`: a consumer doing `if (env.errors) throw` would
   * start failing on reads that succeeded.
   *
   * A client that maps rows into declared interfaces MUST surface this (log,
   * attach to the result, or throw in development): an unknown projection key
   * arrives as `null`, satisfies the interface, and the read looks correct.
   */
  _diagnostics?: Record<
    string,
    {
      /**
       * Projection keys the type does not declare. The read still returned
       * every row; each unknown key materialises as `null` on all of them,
       * indistinguishable from a declared field that is null everywhere.
       */
      unknownProjectionFields?: string[];
      /**
       * The where-clause reached the substrate without being schema-validated,
       * because the type is registered but absent from its namespace's
       * published schema (e.g. runtime-created types). The result is still
       * correct — substrates refuse a predicate they cannot honour — but the
       * engine's operator and operand check did not run.
       */
      filterValidationSkipped?: string;
      /**
       * A walk-grammar read's clauses, each marked index-served or not
       * (typed edge walks, goal 7). Annotation only: nothing is refused on
       * it. Absent on ordinary reads, and when the store has no index plan.
       */
      plan?: PlanClause[];
    }
  >;
  errors?: Array<{
    message: string;
    path?: string[];
    code?: string;
    /**
     * Optional structured payload — populated when the underlying error class
     * carries one (e.g. `ResolverFrameError({ field: '...' })`).
     */
    details?: Record<string, unknown>;
  }>;
}

/**
 * Client-sent field selection tree. Defined here rather than in
 * `@mnmal-ai/substrate-pack` so subscription and streaming machinery (§5.4, §5.5)
 * can reference the same shape without adding substrate-pack to their dependency
 * set — substrate-pack already imports from types, so moving the type upward
 * avoids the would-be cycle.
 */
export type FieldInput = { [field: string]: true | FieldInput };
