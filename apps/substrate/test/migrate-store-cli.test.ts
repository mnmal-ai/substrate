/**
 * `substrate-admin migrate-store` end to end: argv refusals (pure), then the
 * command against a seeded source schema and an empty target schema (pg).
 */

import { describe, expect, it } from 'vitest';
import { migrateStoreCommand } from '../src/admin/commands/migrate-store.js';
import { main } from '../src/admin/main.js';
import { bootStore } from '../src/serve/boot-store.js';
import { parseEnv } from '../src/serve/config.js';
import { buildDeferredIndexes } from '../src/serve/wiring.js';
import { openSchemas, POSTGRES_URL, type Schemas } from './_fixtures/migrate-store.js';

const SECRET_URL = 'postgres://someone:hunter2secret@db.example:5432/store';

async function cli(argv: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    env,
    (s) => out.push(s),
    (s) => err.push(s)
  );
  return { code, out: out.join(''), err: err.join('') };
}

describe('migrate-store argv', () => {
  it('refuses a URL on argv', async () => {
    for (const argv of [
      ['migrate-store', SECRET_URL],
      ['migrate-store', '--from', SECRET_URL],
      ['migrate-store', `--to=${SECRET_URL}`],
      ['migrate-store', '--from-env', SECRET_URL]
    ]) {
      const r = await cli(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.err).toContain('--from-env');
      expect(r.err + r.out).not.toContain('hunter2secret');
      expect(r.err + r.out).not.toContain('db.example');
    }
  });

  it('refuses an unset source variable, and an unset disk path in a real run, before connecting', async () => {
    const unset = await cli(['migrate-store'], { SUBSTRATE_MIGRATE_TO_URL: SECRET_URL });
    expect(unset.code).toBe(2);
    expect(unset.err).toContain('SUBSTRATE_MIGRATE_FROM_URL');

    const disk = await cli(['migrate-store', '--json'], {
      SUBSTRATE_MIGRATE_FROM_URL: SECRET_URL,
      SUBSTRATE_MIGRATE_TO_URL: `${SECRET_URL}2`
    });
    expect(disk.code).toBe(2);
    const report = JSON.parse(disk.out) as { refusals: string[] };
    expect(report.refusals.join()).toMatch(/SUBSTRATE_INDEX_DISK_PATH.*or to off/);
    expect(disk.out + disk.err).not.toContain('hunter2secret');
  });

  it('refuses --dry-run with --verify-only, and a repeated --from-env', async () => {
    expect((await cli(['migrate-store', '--dry-run', '--verify-only'])).code).toBe(2);
    // The schema names boot accepts, and no others.
    expect((await cli(['migrate-store', '--to-schema', 'a$b'])).code).toBe(2);
    expect((await cli(['migrate-store', '--from-env', 'A', '--from-env', 'B'])).code).toBe(2);
  });
});

describe.skipIf(!POSTGRES_URL)('migrate-store (pg)', () => {
  const password = POSTGRES_URL ? new URL(POSTGRES_URL).password : '';

  const envFor = (s: Schemas, over: Record<string, string> = {}) => ({
    SUBSTRATE_MIGRATE_FROM_URL: POSTGRES_URL as string,
    SUBSTRATE_MIGRATE_TO_URL: POSTGRES_URL as string,
    SUBSTRATE_PLUGIN_DIR: s.pluginDir,
    SUBSTRATE_SYSTEM_ACTOR: 'copy-test',
    SUBSTRATE_INDEX_DISK_PATH: 'off',
    ...over
  });
  const schemaArgs = (s: Schemas) => ['--from-schema', s.srcSchema, '--to-schema', s.tgtSchema];
  const run = async (s: Schemas, argv: string[], hooks = {}, over = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await migrateStoreCommand(
      [...schemaArgs(s), ...argv],
      envFor(s, over),
      (x) => out.push(x),
      (x) => err.push(x),
      hooks
    );
    const all = out.join('') + err.join('');
    expect(all).not.toContain(password);
    expect(all).not.toContain('postgres://');
    return { code, out: out.join(''), err: err.join('') };
  };
  const markerPresent = async (s: Schemas) =>
    (await s.tgtSql`SELECT to_regclass('substrate_migrate_store_progress') AS r`)[0]?.r !== null;

  it('dry run reports the plan and writes nothing to the target', async () => {
    const s = await openSchemas('legacy');
    try {
      const r = await run(s, ['--dry-run', '--json']);
      expect(r.code).toBe(0);
      const report = JSON.parse(r.out) as {
        ok: boolean;
        plan: { tables: { name: string; bytes: number }[]; estimatedBytes: number };
        types: { namespace: string; type: string }[];
      };
      expect(report.ok).toBe(true);
      expect(report.plan.tables.map((t) => t.name)).toContain('embeddings');
      // A legacy rows is an ordinary table, which still has a size.
      expect(report.plan.tables.find((t) => t.name === 'rows')?.bytes).toBeGreaterThan(0);
      expect(report.plan.estimatedBytes).toBeGreaterThan(0);
      expect(report.types).toContainEqual(expect.objectContaining({ namespace: 'retired' }));
      const [n] = await s.tgtSql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = ${s.tgtSchema}::regnamespace`;
      expect(n?.n).toBe(0);

      // A schema the target lacks would fall through to public on the search_path: refused before any boot.
      const said: string[] = [];
      const absent = await migrateStoreCommand(
        ['--from-schema', s.srcSchema, '--to-schema', `${s.tgtSchema}_absent`, '--verify-only'],
        envFor(s),
        (x) => said.push(x),
        (x) => said.push(x)
      );
      expect(absent).toBe(2);
      expect(said.join('')).toContain(`the target has no schema ${s.tgtSchema}_absent`);
    } finally {
      await s.close();
    }
  }, 120_000);

  it('migrates end to end and the target boots with serve', async () => {
    const s = await openSchemas('legacy');
    try {
      const r = await run(s, []);
      expect(r.code, r.out + r.err).toBe(0);
      expect(r.out).toContain('copied and verified');
      expect(r.out).toMatch(/switch over: .*SUBSTRATE_DATABASE_URL.*SUBSTRATE_MIGRATE_TO_URL/);
      expect(r.out).toMatch(
        /ms: preflight \d+, prepare-and-copy \d+, indexes \d+, verify \d+, total \d+/
      );
      expect(await markerPresent(s)).toBe(false);
      const booted = await bootStore({
        config: parseEnv({
          SUBSTRATE_DATABASE_URL: s.tgtUrl,
          SUBSTRATE_SYSTEM_ACTOR: 'copy-test',
          SUBSTRATE_INDEX_DISK_PATH: 'off'
        }),
        pluginDir: s.pluginDir
      });
      await booted.close();
    } finally {
      await s.close();
    }
  }, 300_000);

  it('runs with a service env whose listener settings a prepare boot cannot meet', async () => {
    const s = await openSchemas('legacy');
    try {
      // Off loopback with auth on, serve would demand a public origin and a ticket secret.
      const r = await run(s, [], {}, { HOST: '0.0.0.0', SUBSTRATE_AUTH_MODE: 'required' });
      expect(r.code, r.out + r.err).toBe(0);
      expect(r.out).toContain('copied and verified');
    } finally {
      await s.close();
    }
  }, 300_000);

  it('exits 3 and keeps the marker when verification fails', async () => {
    const s = await openSchemas('partitioned');
    // Whatever reaches the real stderr mid-run passes the redactor too: capture it under the command's shim.
    const stderrWrite = process.stderr.write;
    const raw: string[] = [];
    process.stderr.write = ((chunk: string) => {
      raw.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      let r: Awaited<ReturnType<typeof run>>;
      try {
        r = await run(s, ['--skip-index-build', '--json'], {
          beforeVerify: async (t: import('postgres').Sql) => {
            process.stderr.write(`a writer that leaks ${POSTGRES_URL}\n`);
            await t`UPDATE rows SET body = '{"x":2}' WHERE namespace = 'retired'`;
          }
        });
      } finally {
        process.stderr.write = stderrWrite;
      }
      expect(raw.join('')).toContain('a writer that leaks <redacted url>');
      expect(raw.join('')).not.toContain(password);
      expect(r.code).toBe(3);
      const report = JSON.parse(r.out) as {
        ok: boolean;
        mismatches: { check: string }[];
        pendingIndexes: string[];
      };
      expect(report.ok).toBe(false);
      // Only the tampered content: the indexes --skip-index-build left pending are let through, and listed.
      expect([...new Set(report.mismatches.map((m) => m.check))]).toEqual(['sample']);
      expect(report.pendingIndexes.length).toBeGreaterThan(0);
      expect(await markerPresent(s)).toBe(true);

      // --verify-only reaches the same verdict on the left-behind target.
      const again = await run(s, ['--verify-only', '--skip-index-build']);
      expect(again.code).toBe(3);
      expect(again.out).toContain('VERIFICATION FAILED');
    } finally {
      await s.close();
    }
  }, 300_000);

  it('names an INVALID index as a mismatch, and --verify-only rebuilds it and finishes the run', async () => {
    const s = await openSchemas('partitioned');
    try {
      let broken = '';
      // What a failed CREATE INDEX CONCURRENTLY leaves: an INVALID index under an engine index's name.
      const breakIndex = async (t: import('postgres').Sql) => {
        const candidates = await t<{ name: string; tbl: string }[]>`
          SELECT c.relname AS name, i.indrelid::regclass::text AS tbl
          FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relnamespace = current_schema()::regnamespace AND NOT i.indisunique
            AND obj_description(c.oid, 'pg_class') = 'substrate: reconciled'
          ORDER BY c.relname`;
        for (const c of candidates) {
          if ((await t.unsafe(`SELECT 1 FROM ${c.tbl} LIMIT 1`)).length === 0) continue;
          await t.unsafe(`DROP INDEX ${c.name}`);
          await t
            .unsafe(
              `CREATE INDEX CONCURRENTLY ${c.name} ON ${c.tbl} ((1 / (length(id) - length(id))))`
            )
            .catch(() => undefined);
          broken = c.name;
          return;
        }
      };
      const r = await run(s, ['--json'], { beforeVerify: breakIndex });
      expect(broken).not.toBe('');
      expect(r.code, r.out + r.err).toBe(3);
      const report = JSON.parse(r.out) as { mismatches: { check: string; detail: string }[] };
      expect(report.mismatches).toEqual([
        expect.objectContaining({
          check: 'storage',
          detail: expect.stringContaining(`index ${broken} on `)
        })
      ]);
      expect(await markerPresent(s)).toBe(true);

      const again = await run(s, ['--verify-only']);
      expect(again.code, again.out + again.err).toBe(0);
      expect(again.out).toMatch(/ms: prepare \d+, indexes \d+, verify \d+/);
      expect(await markerPresent(s)).toBe(false);
      const [valid] = await s.tgtSql<{ ok: boolean }[]>`
        SELECT i.indisvalid AS ok FROM pg_index i
        WHERE i.indexrelid = to_regclass(${`${s.tgtSchema}.${broken}`})`;
      expect(valid?.ok).toBe(true);
    } finally {
      await s.close();
    }
  }, 300_000);

  it('names a failed index build as a mismatch and keeps the marker', async () => {
    const s = await openSchemas('legacy');
    try {
      const line =
        'indexes of a/T1 were not built and will be retried by the next build pass: boom';
      const r = await run(s, ['--json'], {
        buildIndexes: async (...a: Parameters<typeof buildDeferredIndexes>) => [
          ...(await buildDeferredIndexes(...a)),
          line
        ]
      });
      expect(r.code, r.out + r.err).toBe(3);
      const report = JSON.parse(r.out) as { mismatches: { check: string; detail: string }[] };
      expect(report.mismatches).toEqual([
        expect.objectContaining({ check: 'storage', detail: expect.stringContaining(line) })
      ]);
      expect(await markerPresent(s)).toBe(true);
    } finally {
      await s.close();
    }
  }, 300_000);

  it('refuses a source and target that are one store, though their URLs differ', async () => {
    const s = await openSchemas('legacy');
    try {
      const same = `${POSTGRES_URL}${(POSTGRES_URL as string).includes('?') ? '&' : '?'}application_name=other`;
      for (const mode of [[], ['--verify-only']]) {
        const said: string[] = [];
        const code = await migrateStoreCommand(
          ['--from-schema', s.srcSchema, '--to-schema', s.srcSchema, ...mode],
          envFor(s, { SUBSTRATE_MIGRATE_TO_URL: same }),
          (x) => said.push(x),
          (x) => said.push(x)
        );
        expect(code, mode.join()).toBe(2);
        expect(said.join('')).toContain('the source and the target are the same store');
      }
    } finally {
      await s.close();
    }
  }, 120_000);

  it('--verify-only refuses a target with no marker, before it boots', async () => {
    const s = await openSchemas('legacy');
    try {
      const r = await run(s, ['--verify-only']);
      expect(r.code, r.err).toBe(2);
      expect(r.out).toContain('already verified, or not a migrate-store target (no marker)');
      const [n] = await s.tgtSql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = ${s.tgtSchema}::regnamespace`;
      expect(n?.n).toBe(0);
    } finally {
      await s.close();
    }
  }, 120_000);

  it('never prints a connection string', async () => {
    const s = await openSchemas('legacy');
    try {
      const dead = new URL(POSTGRES_URL as string);
      dead.port = '1';
      // `run` asserts neither stream carries the password or a URL.
      const r = await run(s, [], {}, { SUBSTRATE_MIGRATE_TO_URL: dead.toString() });
      expect(r.code).toBe(1);
      expect(r.err).not.toBe('');
    } finally {
      await s.close();
    }
  }, 120_000);

  it('--json still prints a report when the run fails, naming the error and the phase', async () => {
    const s = await openSchemas('legacy');
    try {
      const dead = new URL(POSTGRES_URL as string);
      dead.port = '1';
      const r = await run(s, ['--json'], {}, { SUBSTRATE_MIGRATE_TO_URL: dead.toString() });
      expect(r.code).toBe(1);
      const report = JSON.parse(r.out);
      expect(report).toMatchObject({ ok: false, exitCode: 1 });
      expect(typeof report.error).toBe('string');
      expect(report.error.length).toBeGreaterThan(0);
    } finally {
      await s.close();
    }
  }, 120_000);
});
