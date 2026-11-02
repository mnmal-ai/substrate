/**
 * The opt-in UUID-format CHECKs (`SUBSTRATE_ENFORCE_UUID_CHECK=true`). These
 * outlive `0002_uuid_format_check`, which applies them on the old layouts:
 * `migrate-store` reads them to inspect an old source.
 */

/** The id shape the CHECKs enforce; migrate-store's preflight scans sources against it. */
export const UUID_REGEX = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/** The ledger version of the opt-in UUID-format CHECKs on the old layouts. */
export const UUID_CHECK_MIGRATION = '0002_uuid_format_check';
