/**
 * An unlock that throws leaves the session possibly holding the lock, so the
 * reserved connection is terminated rather than returned to the pool.
 * Runs without pg: the reserved connection is a fake.
 */

import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { tryWithPgAdvisoryLock } from '../src/index.js';
import { withTableIndexLock } from '../src/migrate.js';

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
  it('unlocks again when a late cancel lands on the first unlock', async () => {
    const sent: string[] = [];
    let unlocks = 0;
    const conn = {
      unsafe: (text: string) => {
        sent.push(text.includes('pg_try_advisory_lock') ? 'lock' : 'unlock');
        if (text.includes('pg_try_advisory_lock')) return Promise.resolve([{ acquired: true }]);
        unlocks += 1;
        return unlocks === 1
          ? Promise.reject(new Error('canceling statement due to user request'))
          : Promise.resolve([{ pg_advisory_unlock: true }]);
      }
    } as unknown as Sql;
    expect(await withTableIndexLock(conn, 'rows', undefined, async () => 1)).toBe(1);
    expect(sent).toEqual(['lock', 'unlock', 'unlock']);
  });
});
