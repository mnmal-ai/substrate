import { defineLibTsdown } from '@mnmal-ai/substrate-config/tsdown';

export default defineLibTsdown({
  external: ['@mnmal-ai/substrate-types', 'msgpackr', 'node:module']
});
