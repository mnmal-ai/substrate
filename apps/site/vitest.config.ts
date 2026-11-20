import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // licensed-build.test.ts briefly adds files under public/ that other suites read.
    fileParallelism: false,
    testTimeout: 120_000,
    // Gives the pg-gated example a schema of its own.
    globalSetup: ['./test/_global-setup.ts'],
    include: ['test/**/*.test.ts', 'examples/**/*.test.ts']
  }
});
