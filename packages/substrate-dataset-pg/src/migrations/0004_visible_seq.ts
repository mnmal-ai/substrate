/**
 * 0004_visible_seq — commit-ordered sequence for visible-order types.
 *
 * `rows.seq` holds a row's place in its type's commit order; it stays NULL on
 * every type not declared `ordering: 'visible'`. On the partitioned layout the
 * column propagates from the parent to every partition. Adding a nullable
 * column with no default rewrites nothing.
 *
 * `visible_seqs` holds each visible-order type's last assigned seq. It only
 * ever increases, so purging the newest rows never lets a later insert reuse
 * their seq. Writers read and advance it under the type's advisory lock.
 */

export const TX_STATEMENTS: ReadonlyArray<string> = [
  'ALTER TABLE rows ADD COLUMN IF NOT EXISTS seq bigint NULL',

  `CREATE TABLE IF NOT EXISTS visible_seqs (
    namespace  text   NOT NULL,
    type       text   NOT NULL,
    last_seq   bigint NOT NULL,
    PRIMARY KEY (namespace, type)
  )`
];

export const CONCURRENT_STATEMENTS: ReadonlyArray<string> = [];
