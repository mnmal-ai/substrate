/**
 * 0004t_field_error_version — the type's catalog version when a field's
 * promotion (`promoting`) or straggler pass (`column`) failed on a unique
 * conflict. The promotion sweep
 * skips that field until the type's catalog version moves past it, rather
 * than rescanning the whole table every sweep for a conflict that has not
 * changed (promote.ts). Nullable, no default: no table rewrite.
 */

export const TX_STATEMENTS: ReadonlyArray<string> = [
  'ALTER TABLE substrate_type_fields ADD COLUMN IF NOT EXISTS error_version bigint NULL'
];
