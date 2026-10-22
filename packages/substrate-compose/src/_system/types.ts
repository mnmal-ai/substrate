/**
 * `_system` namespace type shapes. Spec §5.12.
 *
 * Core admin-gated types:
 *   - `Key`     — public-key record. `kid` is the principal identity an
 *                      agent signs with (JWT `kid` claim); distinct from the
 *                      row `id` (a UUID). The registry resolves on `kid`.
 *                      HS256 is rejected at the resolver layer so symmetric
 *                      secrets never land in the dataset.
 *   - `Invite`  — invite record, consumed by `/register`.
 *
 * Field shapes:
 *   - `namespaces` / `capabilities` are comma-separated strings — the field
 *     DSL lacks an array scalar. Parse via `@mnmal-ai/substrate-policy`'s
 *     `encoding.ts` at use sites.
 *   - `publicKey` is a plain string (indexed: false) — PEMs are multi-line
 *     and we never filter on them.
 *   - `revokedAt` / `consumedAt` / `consumedBy` are nullable scalars.
 */

import { field } from '@mnmal-ai/substrate-sdk';
import type { FieldDef } from '@mnmal-ai/substrate-types';

export const KEY_FIELDS: Record<string, FieldDef> = {
  // The principal identity an agent signs with (JWT `kid`). Indexed so the
  // registry can resolve it via `where`. Distinct from the row `id`, which is a
  // UUID.
  kid: field.string(),
  // `name` is human-readable; not the lookup key.
  name: field.string(),
  // Only asymmetric algs in the dataset. 'EdDSA' | 'RS256' | 'ES256'.
  algorithm: field.string(),
  // PEM blob — multi-line, never filtered. indexed:false avoids pg btree bloat.
  publicKey: field.string({ indexed: false }),
  // Comma-separated namespace list (wildcard '*' allowed). See @mnmal-ai/substrate-policy encoding.ts.
  namespaces: field.string({ indexed: false }),
  // Comma-separated capability list. See @mnmal-ai/substrate-policy encoding.ts.
  capabilities: field.string({ indexed: false }),
  // No body-level `createdAt`: the row-metadata column shadows that name in
  // orderBy/where resolution. Use _metadata.createdAt.
  // Nullable — only set when the key is revoked.
  revokedAt: field.date({ nullable: true })
};

export const INVITE_FIELDS: Record<string, FieldDef> = {
  // `id` is the 32-byte base64url invite code — that IS the PK in autoCRUD.
  namespaces: field.string({ indexed: false }),
  capabilities: field.string({ indexed: false }),
  expiresAt: field.date(),
  // No body-level `createdAt`: the row-metadata column shadows that name in
  // orderBy/where resolution. Use _metadata.createdAt.
  // Nullable — stays null until the invite is consumed.
  consumedAt: field.date({ nullable: true }),
  // kid of the resulting Key.
  consumedBy: field.string({ nullable: true })
};

/**
 * `AuditEvent` — append-only audit trail for admin and auth operations.
 * Spec §5.12 audit trail. Rows accumulate forever — no retention policy is
 * installed. Low-rate by construction (admin mutations + register flow only).
 *
 * `kind` is a convention-typed string — validation-by-review, not schema-
 * enforced enum. Canonical values:
 *   - `bootstrap`              : the first-boot event emitted once per dataset
 *   - `key_created`            : `createKey` committed
 *   - `key_revoked`            : `updateKey` transitioned `revokedAt` null → !null
 *   - `key_rotated`            : reserved for a future rotate flow
 *   - `key_registered`         : `substrate-admin register` inserted a non-admin agent Key
 *   - `key_authority_updated`  : `substrate-admin update` changed a live key's namespaces /
 *                                capabilities / name in place. `details` carries the full
 *                                before AND after, plus the entries the change newly
 *                                granted, so a narrowing and a widening are tellable
 *                                apart from the trail alone.
 *   - `invite_created`         : `createInvite` committed
 *   - `invite_consumed`        : `/register` completed a successful invite consumption
 *   - `namespace_dropped`      : `dropNamespaceRoute` dropped every row in a namespace
 *   - `vocab_normalised`       : `normaliseVocabRoute` rewrote stored values to their canonical form
 *   - `field_backfilled`       : `backfillFieldRoute` wrote per-row values of one field, metadata preserved
 *   - `type_dropped`           : `dropTypeRoute` dropped every row in a single type
 *   - `destructive_op_refused` : kill switch refused a hard-destructive operation
 *
 * `details` is an opaque JSON body — `field.json()` round-trips the value
 * unchanged through encoder/decoder, no JSON.stringify boundary needed.
 * Filtering and ordering on `details` are rejected at the validator layer.
 */
export const AUDIT_EVENT_FIELDS: Record<string, FieldDef> = {
  // ISO-8601 string for cheap lexicographic ordering / range scans on pg.
  ts: field.string(),
  // The actor's `kid`. For the bootstrap event, the literal string
  // `'bootstrap'` — first-boot has no prior key to attribute the action to.
  actorKid: field.string(),
  // Convention-typed string — see the kind list above.
  kind: field.string(),
  // Optional kid/id of the affected entity. Absent for `bootstrap`.
  targetKid: field.string({ nullable: true }),
  // Optional post-trust-gated client IP (see `extractClientIp`). Populated on
  // every emission path — route handlers, interceptor wrappers, bootstrap
  // backfill — and null only when the transport exposed no peer IP and no
  // trusted XFF (e.g. direct-engine test paths or WS upgrades without a
  // trusted proxy).
  clientIp: field.string({ nullable: true }),
  // Opaque freeform body. Round-trips as `unknown`; consumers cast on read.
  details: field.json()
};

/**
 * Where the operator's agent DIRECTORY lives, so `POST /substrate/v1/_system/keys` can
 * write the credential and the directory row in ONE transaction.
 *
 * A usable identity is two rows: the `_system/Key` credential (what
 * verifies a JWT) and a directory row (what is listed and what mail routes
 * against). The directory type belongs to a plugin (e.g.
 * `acme/AgentIdentity`), so the operator names it here and core stays
 * generic.
 *
 * Unset is supported: the route writes the credential alone and says so in
 * its response (`directory.created: false`, `reason: 'not_configured'`).
 */
export interface IdentityDirectoryConfig {
  /**
   * Qualified TYPE key of the directory, e.g. `'acme/AgentIdentity'`. The
   * autoCRUD create mutation is derived as `create<Type>`. Split rather than
   * taking the mutation name directly because the policy pre-flight
   * (`engine.evaluateWritePolicy`) is asked about a TYPE.
   */
  readonly frame: string;
  /** Directory field carrying the kid. Always forced to the registered kid. Default `'kid'`. */
  readonly kidField?: string;
  /**
   * Directory field carrying the host — everything after the last `@` in the
   * kid. `null` disables the derivation. Default `'host'`, which is
   * non-nullable on `acme/AgentIdentity` and is why deriving it beats
   * making every caller repeat it.
   */
  readonly hostField?: string | null;
  /** Directory field carrying the human-readable name. Default `'displayName'`. */
  readonly displayNameField?: string | null;
  /** Static params merged beneath the derived + caller-supplied ones. */
  readonly defaults?: Readonly<Record<string, unknown>>;
}

/** Qualifying namespace for every type in this module. */
export { SYSTEM_NAMESPACE } from '@mnmal-ai/substrate-policy';

/** Canonical type names — used by install/registry/tests. */
export const KEY_TYPE = 'Key';
export const INVITE_TYPE = 'Invite';
export const ENUM_VERDICT_TYPE = 'EnumCheckVerdict';

/**
 * `EnumCheckVerdict` — one `substrate check-enums --record` run against one
 * enum-declared field.
 *
 * Verdicts are DATA, not schema annotations: a static flag on FieldDef would
 * be an unmaintained claim. A verdict row is recomputed by each run, and its
 * staleness is answerable from `checkedAt` + `vocabHash`.
 *
 * Idempotency key is (namespace, type, field): a re-run upserts the row
 * (autoCRUD update by id — the writer sets id deterministically), so the
 * table holds one live verdict per field, not a history. History is what
 * `AuditEvent` is for.
 *
 * All admin-gated like the rest of this namespace: recording a verdict is a
 * claim about the deployment, and anonymous callers must not be able to mint
 * "verified" rows.
 */
export const ENUM_VERDICT_FIELDS: Record<string, FieldDef> = {
  namespace: field.string(),
  type: field.string(),
  field: field.string(),
  /** sha256 of the vocabulary JSON the run checked, so a vocab edit invalidates the verdict structurally. */
  vocabHash: field.string({ indexed: false }),
  /** ISO-8601 of the run. Consumers judge staleness; the server does not expire. */
  checkedAt: field.string(),
  /** Rows scanned. A truncated run still records (with truncated: true) — a floor, not a verdict of clean. */
  rowsScanned: field.number(),
  /** Distinct stored values outside the vocabulary. 0 with truncated:false is the clean verdict. */
  outlierCount: field.number(),
  /** True when the scan stopped at maxRows — counts are a floor. */
  truncated: field.boolean(),
  /** `namespace/type/field` — the upsert key the writer derives. Indexed for the lookup. */
  verdictKey: field.string()
};
export const AUDIT_EVENT_TYPE = 'AuditEvent';
/**
 * Canonical `kind` values for `AuditEvent`. Not enforced at the schema
 * layer (the field is `field.string()`); reviewers / tests use this set as the
 * convention. Writers SHOULD use one of these values; unknown strings aren't
 * rejected but won't surface in dashboards keyed on the canonical set.
 */
export type AuditEventKind =
  | 'bootstrap'
  | 'key_created'
  | 'key_revoked'
  | 'key_rotated'
  | 'key_registered'
  | 'key_authority_updated'
  | 'invite_created'
  | 'invite_consumed'
  | 'namespace_dropped'
  | 'type_dropped'
  | 'vocab_normalised'
  | 'field_backfilled'
  | 'destructive_op_refused';

export const AUDIT_EVENT_KINDS: ReadonlySet<AuditEventKind> = new Set<AuditEventKind>([
  'bootstrap',
  'key_created',
  'key_revoked',
  'key_rotated',
  'key_registered',
  'key_authority_updated',
  'invite_created',
  'invite_consumed',
  'namespace_dropped',
  'type_dropped',
  'vocab_normalised',
  'field_backfilled',
  'destructive_op_refused'
]);

/** Subset of `JwtAlg` the dataset accepts. HS256 is rejected at write-time. */
export type KeyAlgorithm = 'EdDSA' | 'RS256' | 'ES256';

export const KEY_ALGORITHMS: ReadonlySet<KeyAlgorithm> = new Set<KeyAlgorithm>([
  'EdDSA',
  'RS256',
  'ES256'
]);

export function isKeyAlgorithm(v: unknown): v is KeyAlgorithm {
  return typeof v === 'string' && KEY_ALGORITHMS.has(v as KeyAlgorithm);
}
