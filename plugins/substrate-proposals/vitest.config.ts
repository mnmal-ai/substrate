import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Pins search_path to a per-package schema BEFORE any worker forks.
    globalSetup: ['./test/_global-setup.ts'],
    // Pg-gated tests build indexes CONCURRENTLY, which waits on every open
    // transaction in the database, including other packages' suites.
    testTimeout: process.env.POSTGRES_URL ? 30_000 : 5_000
  }
});
