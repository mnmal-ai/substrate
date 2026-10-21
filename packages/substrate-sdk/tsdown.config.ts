import { defineLibTsdown } from '@mnmal-ai/substrate-config/tsdown';

export default defineLibTsdown({
  entry: { index: 'src/index.ts', 'autocrud/index': 'src/autocrud/index.ts' },
  external: [
    '@mnmal-ai/substrate-core',
    '@mnmal-ai/substrate-policy',
    '@mnmal-ai/substrate-types',
    'node:crypto',
    'node:module'
  ]
});
