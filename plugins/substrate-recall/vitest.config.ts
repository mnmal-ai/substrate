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
    // Pg-gated suites do real DDL (recall's own migrations, dropped and
    // reapplied per test), which vitest's 5s default is sized too tight for
    // under a parallel gate. The core migrations, whose CREATE INDEX
    // CONCURRENTLY builds wait on every open transaction in the database, run
    // once in globalSetup, so hooks keep vitest's default timeout.
    testTimeout: process.env.POSTGRES_URL ? 30_000 : 5_000,
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
