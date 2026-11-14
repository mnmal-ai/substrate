import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    // Pins search_path to a per-package schema before any worker forks; a no-op without POSTGRES_URL.
    globalSetup: ['./src/__tests__/_global-setup.ts'],
    testTimeout: process.env.POSTGRES_URL ? 30_000 : 5_000,
    hookTimeout: process.env.POSTGRES_URL ? 60_000 : 10_000
  }
});
