import { defineLibTsdown } from '@mnmal-ai/substrate-config/tsdown';

export default defineLibTsdown({
  entry: { index: 'src/index.ts', bootstrap: 'src/bootstrap.ts' },
  external: [/^@mnmal-ai\/substrate\//, 'node:module', 'zod']
});
