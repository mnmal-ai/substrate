/**
 * The default behind `substrateFetch` in Node and Bun: one process-wide HTTP/2
 * session pool, opened on first use. Browser builds swap in
 * `platform-fetch.browser.ts`.
 */

import { createH2Fetch, type FetchLike, type H2Fetch } from './h2-fetch.js';

let pool: H2Fetch | undefined;

export const platformFetch: FetchLike = (input, init) => {
  pool ??= createH2Fetch();
  return pool(input, init);
};
