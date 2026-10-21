import { defineLibTsdown } from '@mnmal-ai/substrate-config/tsdown';

export default defineLibTsdown({
  entry: { index: 'src/index.ts' },
  external: ['@mnmal-ai/substrate-pack', '@mnmal-ai/substrate-types', '@preact/signals-core', 'ws']
});
