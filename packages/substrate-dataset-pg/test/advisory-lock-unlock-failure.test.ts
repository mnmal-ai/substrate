/**
 * An unlock that throws leaves the session possibly holding the lock, so the
 * reserved connection is terminated rather than returned to the pool.
 * Runs without pg: the reserved connection is a fake.
 */

import type { ReservedSql, Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { tryWithPgAdvisoryLock } from '../src/index.js';
import { withMigrationLock, withTableIndexLock } from '../src/migrate.js';

function fakeSql(failUnlock: boolean, max = 10) {
  const poolQueries: string[] = [];
  let released = false;
  const conn = Object.assign(
    (strings: TemplateStringsArray) => {
      const text = strings.join('?');
      if (text.includes('pg_try_advisory_lock')) {
        return Promise.resolve([{ ok: true, pid: 42, started: 't0' }]);
      }
      if (failUnlock && text.includes('pg_advisory_unlock')) {
        return Promise.reject(new Error('statement timeout'));
      }
      return Promise.resolve([]);
    },
    {
      release: () => {
        released = true;
      }
    }
  );
  const pool = (strings: TemplateStringsArray, ...values: unknown[]) => {
    poolQueries.push(`${strings.join(' ').replace(/\s+/g, ' ').trim()} ${values.join(',')}`);
    // A pool of one is busy with the reserved connection, so it never answers.
    return max <= 1 ? new Promise(() => {}) : Promise.resolve([{ pg_terminate_backend: true }]);
  };
  const sql = Object.assign(pool, {
    reserve: () => Promise.resolve(conn),
    options: { max }
  }) as unknown as Sql;
  return { sql, poolQueries, released: () => released };
}

describe('tryWithPgAdvisoryLock unlock failure', () => {
  it('releases the connection after a clean unlock', async () => {
    const f = fakeSql(false);
    const r = await tryWithPgAdvisoryLock(f.sql, 'k', async () => 1);
    expect(r).toEqual({ acquired: true, value: 1 });
    expect(f.released()).toBe(true);
  });

  it('terminates the backend instead of pooling a connection that may hold the lock', async () => {
    const f = fakeSql(true);
    expect(await tryWithPgAdvisoryLock(f.sql, 'k', async () => 1)).toEqual({
      acquired: true,
      value: 1
    });
    expect(f.released()).toBe(false);
    expect(f.poolQueries).toEqual([
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = AND backend_start = ::timestamptz 42,t0'
    ]);
  });

  it('does not wait on a pool of one, whose only connection is the reserved one', async () => {
    const f = fakeSql(true, 1);
    expect(await tryWithPgAdvisoryLock(f.sql, 'k', async () => 1)).toEqual({
      acquired: true,
      value: 1
    });
    expect(f.released()).toBe(true);
  });
});

describe('withTableIndexLock unlock failure', () => {
  /** A reserved connection whose unlocks fail `failures` times, and the pool it came from. */
  function fakes(failures: number) {
    const sent: string[] = [];
    const pool: string[] = [];
    let released = false;
    let unlocks = 0;
    const conn = {
      unsafe: (text: string) => {
        if (text.includes('pg_try_advisory_lock')) {
          sent.push('lock');
          return Promise.resolve([{ acquired: true, pid: 42, started: 't0' }]);
        }
        sent.push('unlock');
        unlocks += 1;
        return unlocks <= failures
          ? Promise.reject(new Error('canceling statement due to user request'))
          : Promise.resolve([{ pg_advisory_unlock: true }]);
      },
      release: () => {
        released = true;
      }
    } as unknown as ReservedSql;
    const sql = Object.assign(
      (_s: TemplateStringsArray, ...values: unknown[]) => {
        pool.push(`terminate ${values.join(',')}`);
        return Promise.resolve([{ pg_terminate_backend: true }]);
      },
      { options: { max: 10 } }
    ) as unknown as Sql;
    return { sql, conn, sent, pool, released: () => released };
  }

  it('unlocks again when a late cancel lands on the first unlock', async () => {
    const f = fakes(1);
    expect(await withTableIndexLock(f.sql, f.conn, 'rows', undefined, async () => 1)).toBe(1);
    expect(f.sent).toEqual(['lock', 'unlock', 'unlock']);
    expect(f.pool).toEqual([]);
  });

  it('names the lock, not its SQL, when the unlock reports it was not held', async () => {
    const f = fakes(0);
    f.conn.unsafe = ((text: string) =>
      Promise.resolve(
        text.includes('pg_try_advisory_lock')
          ? [{ acquired: true, pid: 42, started: 't0' }]
          : [{ released: false }]
      )) as unknown as ReservedSql['unsafe'];
    const lines: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      await withTableIndexLock(f.sql, f.conn, 'rows', undefined, async () => 1);
    } finally {
      write.mockRestore();
    }
    expect(lines).toEqual([
      'substrate: advisory unlock of the index-build rows lock reported it was not held by this session\n'
    ]);
  });

  it('retires the session, and never pools it, when the second unlock fails too', async () => {
    const f = fakes(2);
    await expect(
      withTableIndexLock(f.sql, f.conn, 'rows', undefined, async () => 1)
    ).rejects.toThrow(/canceling statement/);
    expect(f.pool).toEqual(['terminate 42,t0']);
    f.conn.release();
    expect(f.released()).toBe(false);
  });
});

describe('withMigrationLock unlock failure', () => {
  /** A reserved connection whose migration unlocks fail, and whose table unlocks fail too when `tableFails`. */
  function fakes(tableFails: boolean) {
    const sent: string[] = [];
    const pool: string[] = [];
    let tableUnlocks = 0;
    const conn = {
      unsafe: (text: string) => {
        if (text.includes('pg_try_advisory_lock')) {
          return Promise.resolve([{ acquired: true, pid: 42, started: 't0' }]);
        }
        if (text.includes('substrate-migrations')) {
          sent.push('migration unlock');
          return Promise.reject(new Error('write CONNECTION_ENDED'));
        }
        tableUnlocks += 1;
        return tableFails
          ? Promise.reject(new Error(`canceling statement due to user request ${tableUnlocks}`))
          : Promise.resolve([{ released: true }]);
      },
      release: () => {
        sent.push('release');
      }
    } as unknown as ReservedSql;
    const sql = Object.assign(
      (s: TemplateStringsArray, ...values: unknown[]) => {
        if (s.join('').includes('current_schema()')) return Promise.resolve([{ schema: 'public' }]);
        pool.push(`terminate ${values.join(',')}`);
        return Promise.resolve([{ pg_terminate_backend: true }]);
      },
      { options: { max: 10 }, reserve: () => Promise.resolve(conn) }
    ) as unknown as Sql;
    return { sql, sent, pool };
  }

  it('retires the session, and never pools it, when its own unlock fails', async () => {
    const f = fakes(false);
    await expect(withMigrationLock(f.sql, async () => 1)).rejects.toThrow('CONNECTION_ENDED');
    expect(f.pool).toEqual(['terminate 42,t0']);
    expect(f.sent).toEqual(['migration unlock', 'migration unlock']);
  });

  it('rethrows the original unlock error over a nested table lock, not its own', async () => {
    const f = fakes(true);
    await expect(
      withMigrationLock(f.sql, (c) =>
        withTableIndexLock(f.sql, c, 'rows', undefined, async () => 1)
      )
    ).rejects.toThrow('canceling statement due to user request 2');
    expect(f.sent).not.toContain('release');
  });
});
