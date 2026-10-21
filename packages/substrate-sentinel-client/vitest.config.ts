import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // The sentinel plugin depends on substrate, which bundles this package, so
  // the suite reads it from source, and its `@mnmal-ai/substrate/*` imports
  // from the bundle's sources: one copy of every workspace package.
  resolve: {
    alias: [
      {
        find: /^@mnmal-ai\/substrate\/(.*)$/,
        replacement: here('../../apps/substrate/src/exports/$1.ts')
      },
      {
        find: '@mnmal-ai/substrate-sentinel',
        replacement: here('../../plugins/substrate-sentinel/src/index.ts')
      }
    ]
  },
  test: {
    include: ['test/**/*.test.ts']
  }
});
