import { defineLibTsdown } from '@mnmal-ai/substrate-config/tsdown';

export default defineLibTsdown({
  external: [
    '@fastify/websocket',
    '@mnmal-ai/substrate-types',
    'fastify',
    'node:crypto',
    'node:module'
  ]
});
