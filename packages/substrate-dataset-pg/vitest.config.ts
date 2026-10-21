import { defineConfig } from 'vitest/config';
import { announcePgGating } from './src/testing.js';

// Evaluated ONCE per vitest run, in the main process — the only place a
// once-per-run notice can live. `setupFiles` runs per test file and vitest
// isolates files hard enough that neither module state nor globalThis
// survives between them (measured: 51 duplicate lines for one package).
announcePgGating(process.env.POSTGRES_URL, { packageName: 'substrate-dataset-pg' });

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
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
    // Single shared pg database across all test files. File-level parallelism
    // would race on TRUNCATE between suites and on idempotent CREATE TABLE in
    // runMigrations (pg throws on concurrent `CREATE TABLE IF NOT EXISTS` due
    // to pg_type catalog uniqueness). Serialising at file level keeps tests
    // self-contained without per-file schemas.
    fileParallelism: false
  }
});
