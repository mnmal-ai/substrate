import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
    // The panel suites drive Ink renders keystroke by keystroke; the slowest
    // take about 4s on an idle machine, so the 5s default fails them under
    // the full gate's parallel load.
    testTimeout: 20_000
  }
});
