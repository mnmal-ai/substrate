import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Pins search_path to a per-package schema BEFORE any worker forks.
    globalSetup: ['./test/_global-setup.ts'],
    // Pg-gated tests build indexes CONCURRENTLY, which waits on every open
    // transaction in the database, including other packages' suites.
    testTimeout: process.env.POSTGRES_URL ? 30_000 : 5_000,
    // uuid-check's beforeAll migrates its own schema; a timed-out hook runs afterAll's
    // DROP SCHEMA while that DDL is still in flight ('tuple concurrently updated').
    hookTimeout: process.env.POSTGRES_URL ? 60_000 : 10_000
  }
});
