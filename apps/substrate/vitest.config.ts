import { fileURLToPath } from 'node:url';
import { announcePgGating } from '@mnmal-ai/substrate-dataset-pg/testing';
import { defineConfig } from 'vitest/config';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Evaluated ONCE per vitest run, in the main process — the only place a
// once-per-run notice can live. `setupFiles` runs per test file and vitest
// isolates files hard enough that neither module state nor globalThis
// survives between them (measured: 51 duplicate lines for one package).
announcePgGating(process.env.POSTGRES_URL, { packageName: 'apps/substrate' });

export default defineConfig({
  // The package's own subpaths resolve to their sources, and so do the sibling
  // plugins some suites compose, so a test and the code under test share one
  // copy of every workspace package. The siblings are not dependencies: they
  // depend on this package.
  resolve: {
    alias: [
      { find: /^@mnmal-ai\/substrate\/(.*)$/, replacement: here('./src/exports/$1.ts') },
      {
        find: '@mnmal-ai/substrate-nl',
        replacement: here('../../plugins/substrate-nl/src/index.ts')
      },
      {
        find: '@mnmal-ai/substrate-sentinel',
        replacement: here('../../plugins/substrate-sentinel/src/index.ts')
      }
    ]
  },
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // Pg-gated suites (pg-integration, _system-bootstrap) share one database and
    // TRUNCATE / DELETE overlapping rows. Serialise at file level only when
    // POSTGRES_URL is set so non-pg runs keep file-parallelism.
    fileParallelism: !process.env.POSTGRES_URL,
    // Refuse to start if POSTGRES_URL points at a production-like database
    // (anything not ending in `_test` / `_dev`), and refuses a superuser
    // credential. See @mnmal-ai/substrate-dataset-pg/testing.
    setupFiles: ['./test/_setup.ts'],
    // Pins search_path to a per-package schema BEFORE any worker forks.
    globalSetup: ['./test/_global-setup.ts'],
    // Pg-gated suites do real DDL — full migration sets including four
    // `CREATE INDEX CONCURRENTLY` builds. CIC waits on every concurrent
    // transaction in the DATABASE, not just this schema, so it gets slower as
    // the other pg packages run alongside; vitest's 5s/10s defaults are sized
    // for unit tests and timed out under a parallel gate. Raised
    // only when POSTGRES_URL is set, so non-pg runs keep the tight defaults.
    testTimeout: process.env.POSTGRES_URL ? 30_000 : 5_000,
    hookTimeout: process.env.POSTGRES_URL ? 60_000 : 10_000
  }
});
