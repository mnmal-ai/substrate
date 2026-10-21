import { announcePgGating } from '@mnmal-ai/substrate-dataset-pg/testing';
import { defineConfig } from 'vitest/config';

// Evaluated ONCE per vitest run, in the main process — the only place a
// once-per-run notice can live. `setupFiles` runs per test file and vitest
// isolates files hard enough that neither module state nor globalThis
// survives between them (measured: 51 duplicate lines for one package).
announcePgGating(process.env.POSTGRES_URL, { packageName: 'substrate-recall' });

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
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
    hookTimeout: process.env.POSTGRES_URL ? 60_000 : 10_000,
    // Single shared pg database across all pg-gated files (substrate_test). The
    // two live-db suites race on the shared `embeddings` table:
    // migrations.test.ts runs `DROP TABLE … CASCADE` (beforeAll/afterAll +
    // rollback test) while embeddings-store-parity.test.ts runs `TRUNCATE …`
    // in beforeEach — a concurrent DROP makes the TRUNCATE throw
    // `relation "embeddings" does not exist`. Serialising at file level
    // keeps the suites self-contained without per-file schemas. Matches the
    // substrate-dataset-pg vitest config, which serialises for the same reason.
    fileParallelism: false
  }
});
