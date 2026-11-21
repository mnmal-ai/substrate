/**
 * 0009t_act_results: short-lived result records of executed `act` sketches.
 *
 * `record` holds the whole record; `id`, `owner`, `idempotency_key` and
 * `expires_at` are the indexed copies. The partial unique index makes the first
 * live write per (owner, idempotency key) win.
 */

export const TX_STATEMENTS: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS act_results (
    id text PRIMARY KEY,
    owner text NOT NULL,
    idempotency_key text,
    record jsonb NOT NULL,
    expires_at timestamptz NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS act_results_owner_idem ON act_results (owner, idempotency_key) WHERE idempotency_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS act_results_expires_at ON act_results (expires_at)`
];
