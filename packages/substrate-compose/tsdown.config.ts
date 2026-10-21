import { defineLibTsdown } from '@mnmal-ai/substrate-config/tsdown';

export default defineLibTsdown({
  external: [
    '@mnmal-ai/substrate-core',
    '@mnmal-ai/substrate-dataset-memory',
    '@mnmal-ai/substrate-pack',
    '@mnmal-ai/substrate-policy',
    '@mnmal-ai/substrate-sdk',
    '@mnmal-ai/substrate-types',
    'node:crypto',
    'node:fs',
    'node:module'
  ]
});
