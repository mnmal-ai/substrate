/**
 * Session advisory lock on one reserved connection, for
 * `PgDataset.withAdvisoryLock`.
 */

import { createKeyedMutex, type KeyedMutex } from '@mnmal-ai/substrate-types';
import type { ReservedSql, Sql } from 'postgres';

const LOCAL_LOCKS = new WeakMap<Sql, KeyedMutex>();

/** The locking session, identified by `pid` and `started` (its `backend_start` as text). */
export interface Session {
  pid: number;
  started: string;
}

/** Selects the current session as `pid` and `started`, for {@link retireSession}. */
export const SESSION_COLUMNS = `pg_backend_pid() AS pid,
  (SELECT backend_start::text FROM pg_stat_activity WHERE pid = pg_backend_pid()) AS started`;

/**
 * Retires a session that may still hold an advisory lock after its unlock
 * threw. True when its connection may go back to the pool. The session is
 * terminated from another pooled connection, which drops every lock it holds
 * and retires the connection; a reserved handle has no `end()`, and a backend
 * terminating itself mid-query leaves postgres.js a stale error that surfaces
 * uncaught on the connection's next use. It is matched on `backend_start` as
 * well as `pid`, because once it has ended its pid can name another session.
 */
export async function retireSession(sql: Sql, session: Session): Promise<boolean> {
  // A pool of one has no other connection to terminate from, so waiting for
  // one would hang; release and risk the lock instead.
  if (sql.options.max <= 1) return true;
  try {
    const killed = await sql`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE pid = ${session.pid} AND backend_start = ${session.started}::timestamptz`;
    // No match: the session has already ended, and its locks with it.
    return killed.length === 0;
  } catch {
    // Cannot retire it either; release rather than leak the pool slot.
    return true;
  }
}

/** Unlock `key` on `conn`. True when `conn` may go back to the pool. */
async function unlock(
  sql: Sql,
  conn: ReservedSql,
  key: string,
  session: Session
): Promise<boolean> {
  try {
    await conn`SELECT pg_advisory_unlock(hashtext(${key}))`;
    return true;
  } catch {
    return retireSession(sql, session);
  }
}

/**
 * Run `fn` while holding `pg_advisory_lock(hashtext(key))`, waiting until it
 * is free. Lock and unlock share one reserved connection, because an unlock
 * through the pool can land on another session and leave the lock held.
 *
 * Callers in this process queue on a local mutex first, so waiters for one key
 * occupy at most one pooled connection per process; otherwise enough blocked
 * waiters could take every connection and starve the holder's own `fn`.
 *
 * @returns whatever `fn` resolves to
 * @throws whatever `fn` throws, after the lock is released
 */
export function withPgAdvisoryLock<T>(sql: Sql, key: string, fn: () => Promise<T>): Promise<T> {
  let local = LOCAL_LOCKS.get(sql);
  if (local === undefined) {
    local = createKeyedMutex();
    LOCAL_LOCKS.set(sql, local);
  }
  return local(key, async () => {
    const conn = await sql.reserve();
    let reusable = true;
    try {
      const [row] = await conn<Session[]>`
        SELECT pg_advisory_lock(hashtext(${key})), pg_backend_pid() AS pid,
          (SELECT backend_start::text FROM pg_stat_activity WHERE pid = pg_backend_pid()) AS started`;
      try {
        return await fn();
      } finally {
        reusable = await unlock(sql, conn, key, row ?? { pid: 0, started: '-infinity' });
      }
    } finally {
      if (reusable) conn.release();
    }
  });
}

/**
 * Run `fn` only if `pg_try_advisory_lock(hashtext(key))` is free right now,
 * on one reserved connection like `withPgAdvisoryLock`. A held lock resolves
 * `{ acquired: false }` without running `fn` and without waiting.
 *
 * @throws whatever `fn` throws, after the lock is released
 */
export async function tryWithPgAdvisoryLock<T>(
  sql: Sql,
  key: string,
  fn: () => Promise<T>
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const conn = await sql.reserve();
  let reusable = true;
  try {
    const [row] = await conn<(Session & { ok: boolean })[]>`
      SELECT pg_try_advisory_lock(hashtext(${key})) AS ok, pg_backend_pid() AS pid,
        (SELECT backend_start::text FROM pg_stat_activity WHERE pid = pg_backend_pid()) AS started`;
    if (row?.ok !== true) return { acquired: false };
    try {
      return { acquired: true, value: await fn() };
    } finally {
      reusable = await unlock(sql, conn, key, row);
    }
  } finally {
    if (reusable) conn.release();
  }
}
