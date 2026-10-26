/**
 * Core substrate-neutral types. Spec: §4.5 Dataset, §4.6 Edge.
 */

export type Id = string | number;

export interface Row {
  id: Id;
  _deletedAt?: Date | null;
  /**
   * Server-managed row-lifecycle metadata, set by autoCRUD on create/update
   * and projected on every read alongside `id`. Each dataset stores it in
   * its own way.
   */
  _metadata?: RowMetadata;
  [field: string]: unknown;
}

/**
 * A row as passed to `Dataset.write`. `id` may be omitted: the dataset then
 * assigns a version-7 UUID and returns it in `WriteResult.ids`.
 */
export interface WriteRow {
  id?: Id;
  _deletedAt?: Date | null;
  _metadata?: RowMetadata;
  [field: string]: unknown;
}

export type IdentityKind = 'agent' | 'user' | 'system';

/**
 * Row-attribution actor — records who created or last updated a row.
 * Distinct from the auth `Identity` in `policy.ts` (JWT principal).
 */
export interface ActorIdentity {
  readonly kind: IdentityKind;
  readonly id: string;
}

export interface RowMetadata {
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly createdBy: ActorIdentity | null;
  readonly updatedBy: ActorIdentity | null;
}

export const CLIENT_SUPPLIED_SERVER_FIELD = 'client_supplied_server_field' as const;
export type ClientSuppliedServerFieldError = typeof CLIENT_SUPPLIED_SERVER_FIELD;

export const ROW_METADATA_FIELDS = ['createdAt', 'updatedAt', 'createdBy', 'updatedBy'] as const;
export type RowMetadataField = (typeof ROW_METADATA_FIELDS)[number];
