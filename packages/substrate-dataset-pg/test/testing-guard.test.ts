/**
 * Tests for the shared pg test-database guard, used by every pg-gated package.
 */

import { describe, expect, it } from 'vitest';
import {
  announcePgGating,
  assertCannotWriteOutsideTestDatabases,
  assertNotSuperuser,
  assertTestDatabase,
  interpretSuperuserProbe,
  pgTestSchemaName,
  pgTestSchemaUrl,
  preparePgTestSchema,
  publicLeftoverWarning,
  reachFailureMessage
} from '../src/testing.js';

const OPTS = { packageName: 'substrate-dataset-pg' };

describe('assertTestDatabase', () => {
  it('allows databases ending in _test or _dev, case-insensitively', () => {
    expect(() => assertTestDatabase('postgres://u:p@h:5432/substrate_test', OPTS)).not.toThrow();
    expect(() => assertTestDatabase('postgres://u:p@h:5432/substrate_v2_dev', OPTS)).not.toThrow();
    expect(() => assertTestDatabase('postgres://u:p@h:5432/substrate_dev', OPTS)).not.toThrow();
    expect(() => assertTestDatabase('postgresql://u:p@host/my_app_TEST', OPTS)).not.toThrow();
  });

  it('refuses a production-looking database and names the package', () => {
    expect(() => assertTestDatabase('postgres://u:p@h:5432/substrate_prod', OPTS)).toThrow(
      /substrate_prod/
    );
    expect(() => assertTestDatabase('postgres://u:p@h:5432/substrate_prod', OPTS)).toThrow(
      /substrate-dataset-pg/
    );
    expect(() => assertTestDatabase('postgres://u:p@h:5432/substrate_v2', OPTS)).toThrow(
      /substrate_v2/
    );
    expect(() => assertTestDatabase('postgres://u:p@h:5432/substrate', OPTS)).toThrow(
      /"substrate"/
    );
    expect(() => assertTestDatabase('postgres://u:p@h:5432/production', OPTS)).toThrow(
      /production/
    );
  });

  it('is a no-op when POSTGRES_URL is unset — pg suites skip, they do not fail', () => {
    expect(() => assertTestDatabase(undefined, OPTS)).not.toThrow();
    expect(() => assertTestDatabase('', OPTS)).not.toThrow();
  });

  it('refuses a malformed URL or a missing database name', () => {
    expect(() => assertTestDatabase('not-a-url', OPTS)).toThrow(/not a valid URL/);
    expect(() => assertTestDatabase('postgres://u:p@h:5432/', OPTS)).toThrow(/database name/);
  });
});

/**
 * `assertTestDatabase` guards the database NAME and says nothing about the
 * CREDENTIAL. A superuser is exempt from the grants that would otherwise
 * contain it, so a test URL carrying one can reach every database.
 */
describe('assertNotSuperuser', () => {
  it('accepts a non-superuser credential', async () => {
    await expect(
      assertNotSuperuser('postgres://substrate_test:p@h:5432/substrate_test', {
        ...OPTS,
        probe: async () => false
      })
    ).resolves.toBeUndefined();
  });

  it('refuses a superuser credential and says how to fix it', async () => {
    await expect(
      assertNotSuperuser('postgres://substrate:p@h:5432/substrate_test', {
        ...OPTS,
        probe: async () => true
      })
    ).rejects.toThrow(/superuser/i);
    await expect(
      assertNotSuperuser('postgres://substrate:p@h:5432/substrate_test', {
        ...OPTS,
        probe: async () => true
      })
    ).rejects.toThrow(/substrate_test/);
  });

  it('is a no-op when POSTGRES_URL is unset', async () => {
    await expect(
      assertNotSuperuser(undefined, { ...OPTS, probe: async () => true })
    ).resolves.toBeUndefined();
  });

  it('surfaces a probe failure rather than passing silently', async () => {
    await expect(
      assertNotSuperuser('postgres://u:p@h:5432/substrate_test', {
        ...OPTS,
        probe: async () => {
          throw new Error('ECONNREFUSED');
        }
      })
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

/**
 * The superuser check stands in for "this credential cannot reach
 * production" only while production runs as a superuser. These cases pin the
 * direct check: what the credential can damage, not what it is called.
 */
describe('assertCannotWriteOutsideTestDatabases', () => {
  const URL_ = 'postgres://app:p@h:5432/substrate_test';

  it('accepts a credential that can damage nothing outside the test set', async () => {
    await expect(
      assertCannotWriteOutsideTestDatabases(URL_, { ...OPTS, probe: async () => [] })
    ).resolves.toBeUndefined();
  });

  it('refuses a NON-superuser production credential, naming what it reaches', async () => {
    // The case the superuser check misses: a demoted prod role that owns its tables.
    const probe = async () => [
      {
        database: 'substrate_prod',
        via: 'writable-relation' as const,
        relations: ['public.rows']
      }
    ];
    await expect(assertCannotWriteOutsideTestDatabases(URL_, { ...OPTS, probe })).rejects.toThrow(
      /substrate_prod: the role can write public\.rows/
    );
  });

  it('refuses a credential that owns a non-test database', async () => {
    const probe = async () => [{ database: 'substrate_prod', via: 'owns-database' as const }];
    await expect(assertCannotWriteOutsideTestDatabases(URL_, { ...OPTS, probe })).rejects.toThrow(
      /substrate_prod: the role OWNS this database/
    );
  });

  it('is a no-op when POSTGRES_URL is unset', async () => {
    await expect(
      assertCannotWriteOutsideTestDatabases(undefined, {
        ...OPTS,
        probe: async () => [{ database: 'x', via: 'owns-database' as const }]
      })
    ).resolves.toBeUndefined();
  });

  it('surfaces a probe failure rather than passing silently', async () => {
    await expect(
      assertCannotWriteOutsideTestDatabases(URL_, {
        ...OPTS,
        probe: async () => {
          throw new Error('ECONNREFUSED');
        }
      })
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('formats nothing for no findings', () => {
    expect(reachFailureMessage([], 'pkg')).toBeUndefined();
  });

  // The default probe against the real test credential: on a correctly
  // provisioned box (and CI) `substrate_test` owns only its test database and can
  // write nothing elsewhere, despite holding the default PUBLIC CONNECT on all.
  it.skipIf(!process.env.POSTGRES_URL)(
    'the default probe passes the provisioned least-privilege test role',
    async () => {
      await expect(
        assertCannotWriteOutsideTestDatabases(process.env.POSTGRES_URL, OPTS)
      ).resolves.toBeUndefined();
    }
  );
});

describe('interpretSuperuserProbe', () => {
  it("reads 'on' as superuser and anything else as not", () => {
    expect(interpretSuperuserProbe([{ su: 'on' }])).toBe(true);
    expect(interpretSuperuserProbe([{ su: 'off' }])).toBe(false);
  });

  it('THROWS on an empty result set rather than reporting not-a-superuser', () => {
    // An unanswerable probe must not read as safe: a missing row must not
    // become not-a-superuser. The injectable-probe tests above cannot reach
    // this branch, because they replace the probe entirely.
    expect(() => interpretSuperuserProbe([])).toThrow(/unanswerable probe/);
    expect(() => interpretSuperuserProbe([{}])).toThrow(/unanswerable probe/);
  });
});

describe('announcePgGating', () => {
  // Called from `vitest.config.ts`, which is evaluated once per run — see the
  // docblock for why `setupFiles` cannot host this.
  it('announces when POSTGRES_URL is unset, naming the package and the fix', () => {
    const lines: string[] = [];
    announcePgGating(undefined, { packageName: 'substrate-recall', warn: (m) => lines.push(m) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('substrate-recall');
    expect(lines[0]).toMatch(/POSTGRES_URL/);
    expect(lines[0]).toMatch(/SKIP/);
    expect(lines[0]).toContain('_test');
  });

  it('says nothing when a URL IS supplied — the suites are actually running', () => {
    const lines: string[] = [];
    announcePgGating('postgres://u:p@h:5432/substrate_test', {
      packageName: 'substrate-recall',
      warn: (m) => lines.push(m)
    });
    expect(lines).toEqual([]);
  });

  it('treats an empty string like an unset variable', () => {
    const lines: string[] = [];
    announcePgGating('', { packageName: 'p', warn: (m) => lines.push(m) });
    expect(lines).toHaveLength(1);
  });
});

describe('pgTestSchemaName', () => {
  it('derives a legal, stable identifier from a package name', () => {
    expect(pgTestSchemaName('substrate-dataset-pg')).toBe('substrate_test_substrate_dataset_pg');
    expect(pgTestSchemaName('apps/substrate')).toBe('substrate_test_apps_substrate');
    expect(pgTestSchemaName('substrate-recall')).toBe('substrate_test_substrate_recall');
  });

  it('never emits a character that would need quoting', () => {
    expect(pgTestSchemaName('@scope/Pkg.Name-42')).toMatch(/^[a-z0-9_]+$/);
  });

  it("stays inside postgres's 63-byte identifier limit", () => {
    expect(pgTestSchemaName('a'.repeat(120)).length).toBeLessThanOrEqual(63);
  });
});

describe('pgTestSchemaUrl', () => {
  it('pins search_path to the package schema, keeping public for the vector type', () => {
    const url = pgTestSchemaUrl('postgres://u:p@h:5432/substrate_test', 'substrate-recall');
    const options = new URL(url).searchParams.get('options');
    expect(options).toBe('-c search_path=substrate_test_substrate_recall,public');
  });

  it('preserves the rest of the URL', () => {
    const url = pgTestSchemaUrl(
      'postgres://u:p@h:5432/substrate_test?sslmode=require',
      'substrate-recall'
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/substrate_test');
    expect(parsed.searchParams.get('sslmode')).toBe('require');
  });

  it('is idempotent — re-isolating an already-isolated URL does not stack options', () => {
    const once = pgTestSchemaUrl('postgres://u:p@h:5432/substrate_test', 'substrate-recall');
    expect(pgTestSchemaUrl(once, 'substrate-recall')).toBe(once);
  });

  it('encodes the space as %20, never as a form-encoded plus', () => {
    // postgres.js percent-decodes the value, so a `+` arrives as a literal
    // plus and the startup packet is rejected. `URLSearchParams.toString()`
    // emits exactly that, which is why the query string is built by hand.
    // Asserting the decoded value alone cannot catch this — `URLSearchParams`
    // reads `+` back as a space too.
    const url = pgTestSchemaUrl('postgres://u:p@h:5432/substrate_test', 'substrate-recall');
    expect(url).toContain('%20');
    expect(url).not.toContain('+');
  });
});

describe('preparePgTestSchema', () => {
  /** Any call is a bug in the test's premise, so make it loud. */
  const fail = (): Promise<string[]> => {
    throw new Error('should not have been probed');
  };
  const collect = (): {
    calls: Array<[string, string]>;
    fn: (u: string, s: string) => Promise<void>;
  } => {
    const calls: Array<[string, string]> = [];
    return {
      calls,
      fn: async (u, s) => {
        calls.push([u, s]);
      }
    };
  };

  it('creates the package schema and returns the URL that reaches it', async () => {
    const { calls, fn } = collect();
    const url = await preparePgTestSchema('postgres://u:p@h:5432/substrate_test', {
      packageName: 'substrate-recall',
      createSchema: fn,
      findPublicLeftovers: async () => []
    });
    expect(calls).toEqual([
      ['postgres://u:p@h:5432/substrate_test', 'substrate_test_substrate_recall']
    ]);
    expect(new URL(url as string).searchParams.get('options')).toBe(
      '-c search_path=substrate_test_substrate_recall,public'
    );
  });

  it('stands down when POSTGRES_URL is unset, touching no database', async () => {
    const { calls, fn } = collect();
    const opts = { packageName: 'x', createSchema: fn, findPublicLeftovers: fail };
    expect(await preparePgTestSchema(undefined, opts)).toBeUndefined();
    expect(await preparePgTestSchema('', opts)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('propagates a failure to create the schema rather than running unisolated', async () => {
    // Falling back to the shared schema on error is what this exists to stop:
    // the run would go green having raced other packages.
    await expect(
      preparePgTestSchema('postgres://u:p@h:5432/substrate_test', {
        packageName: 'substrate-recall',
        createSchema: () => Promise.reject(new Error('permission denied for database')),
        findPublicLeftovers: fail
      })
    ).rejects.toThrow('permission denied');
  });

  it('warns about substrate tables still sitting in public, and says how to clear them', async () => {
    const { fn } = collect();
    const said: string[] = [];
    await preparePgTestSchema('postgres://u:p@h:5432/substrate_test', {
      packageName: 'substrate-recall',
      createSchema: fn,
      findPublicLeftovers: async () => ['rows', 'migrations'],
      warn: (m) => said.push(m)
    });
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('rows, migrations');
    expect(said[0]).toContain('DROP TABLE IF EXISTS');
  });
});

describe('publicLeftoverWarning', () => {
  it('says nothing when public is clean — the state the design assumes', () => {
    expect(publicLeftoverWarning([], 'substrate-recall')).toBeUndefined();
  });

  it('names every leftover, because the fix is to drop exactly those', () => {
    const warning = publicLeftoverWarning(['rows', 'edges'], 'substrate-recall') as string;
    expect(warning).toContain('substrate-recall');
    expect(warning).toContain('rows');
    expect(warning).toContain('edges');
    expect(warning).toContain('2 substrate');
  });
});
