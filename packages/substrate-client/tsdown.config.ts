import { fileURLToPath } from 'node:url';
import { defineLibTsdown } from '@mnmal-ai/substrate-config/tsdown';

const external = ['@mnmal-ai/substrate-pack', '@mnmal-ai/substrate-types', '@preact/signals-core'];

// The browser entry takes the platform `fetch` as `substrateFetch`'s default
// instead of the `node:http2` pool.
const browser = {
  ...defineLibTsdown({ entry: { browser: 'src/browser.ts' }, external }),
  clean: false,
  alias: {
    './platform-fetch.js': fileURLToPath(
      new URL('./src/transport/platform-fetch.browser.ts', import.meta.url)
    )
  }
};

export default [defineLibTsdown({ entry: { index: 'src/index.ts' }, external }), browser];
