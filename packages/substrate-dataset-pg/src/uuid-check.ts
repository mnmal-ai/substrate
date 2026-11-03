/**
 * The opt-in UUID-format CHECKs (`SUBSTRATE_ENFORCE_UUID_CHECK=true`), applied
 * by `0002t_uuid_format_check`. The old layouts recorded theirs under the same
 * ledger version, so `migrate-store` reads both to inspect an old source.
 */

/** The id shape the CHECKs enforce; migrate-store's preflight scans sources against it. */
export const UUID_REGEX = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/** The ledger version of the opt-in UUID-format CHECKs, on every layout. */
export const UUID_CHECK_MIGRATION = '0002_uuid_format_check';
