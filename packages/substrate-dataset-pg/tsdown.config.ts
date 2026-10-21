import { defineLibTsdown } from '@mnmal-ai/substrate-config/tsdown';

export default defineLibTsdown({
  // `src/testing.ts` is the shared pg test guard, published under the
  // `./testing` subpath so apps/substrate and substrate-recall import one owner
  // instead of hand-copying it.
  entry: ['src/index.ts', 'src/testing.ts'],
  external: [
    '@mnmal-ai/substrate-filter',
    '@mnmal-ai/substrate-types',
    'postgres',
    'node:crypto',
    'node:module'
  ]
});
