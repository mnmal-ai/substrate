import { defineLibTsdown } from '@mnmal-ai/substrate-config/tsdown';

export default defineLibTsdown({
  external: [
    '@mnmal-ai/substrate-filter',
    '@mnmal-ai/substrate-types',
    'node:crypto',
    'node:module'
  ]
});
