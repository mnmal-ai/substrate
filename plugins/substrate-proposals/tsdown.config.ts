import { defineLibTsdown } from '@mnmal-ai/substrate-config/tsdown';

export default defineLibTsdown({
  entry: { index: 'src/index.ts', bootstrap: 'src/bootstrap.ts' },
  external: [
    '@mnmal-ai/substrate-compose',
    '@mnmal-ai/substrate-core',
    '@mnmal-ai/substrate-policy',
    '@mnmal-ai/substrate-sdk',
    '@mnmal-ai/substrate-types',
    'node:crypto',
    'node:module'
  ]
});
