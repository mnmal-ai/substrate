/**
 * `substrateFetch`: the one fetch every Substrate caller goes through (Todo #1850).
 * It is the platform fetch until the HTTP/2-only cutover, when it becomes the
 * process-wide `createH2Fetch()` in Node and Bun and stays `fetch` in browsers.
 */

import type { FetchLike } from './h2-fetch.js';

export const substrateFetch: FetchLike = (input, init) => globalThis.fetch(input, init);
