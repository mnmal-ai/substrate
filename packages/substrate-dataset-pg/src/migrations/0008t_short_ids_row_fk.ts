/**
 * 0008t_short_ids_row_fk — restores `short_ids_row_id_fkey` when it is missing.
 *
 * The baseline creates the FK only together with `short_ids`, so a
 * `DROP TABLE row_ids CASCADE` drops it and no re-run of the baseline brings it
 * back: `short_ids` already exists. Without it, deleting a row leaves its short
 * id behind (#1845).
 *
 * Orphans are kept, not deleted. The likely way to lose the FK is `row_ids`
 * dropped and recreated empty, where every short id is an "orphan" of a row
 * that still lives in its type table, and deleting them would destroy the
 * short ids users quote. So the FK is added NOT VALID, which still guards every
 * new write and still cascades, and validation runs in its own statement
 * (taking only SHARE UPDATE EXCLUSIVE, so writes continue). If orphans block
 * it, the constraint stays NOT VALID and a WARNING says so; validate it by
 * hand once they are repaired.
 *
 * On a store that has the FK (every store not hand-repaired) both steps are
 * no-ops: the add is skipped and VALIDATE on a valid constraint returns at once.
 */

export const TX_STATEMENTS: ReadonlyArray<string> = [
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = 'short_ids'::regclass AND conname = 'short_ids_row_id_fkey'
    ) THEN
      ALTER TABLE short_ids ADD CONSTRAINT short_ids_row_id_fkey
        FOREIGN KEY (namespace, type, row_id)
        REFERENCES row_ids (namespace, type, id) ON DELETE CASCADE NOT VALID;
    END IF;
  END $$`
];

/** Run outside the add's transaction, so the add's stronger lock is not held through the scan. */
export const CONCURRENT_STATEMENTS: ReadonlyArray<string> = [
  `DO $$ BEGIN
    ALTER TABLE short_ids VALIDATE CONSTRAINT short_ids_row_id_fkey;
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE WARNING 'short_ids_row_id_fkey left NOT VALID: short_ids holds ids with no row_ids entry. New writes are still checked. Re-register the missing ids in row_ids (or delete the orphaned short_ids), then run ALTER TABLE short_ids VALIDATE CONSTRAINT short_ids_row_id_fkey.';
  END $$`
];
