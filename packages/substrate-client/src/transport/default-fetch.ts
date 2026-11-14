/**
 * `substrateFetch`: the one fetch every Substrate caller goes through. It
 * calls the platform default (HTTP/2 in Node and Bun, the platform `fetch` in
 * browser builds) until a test setup replaces it.
 */

import type { FetchLike } from './h2-fetch.js';
import { platformFetch } from './platform-fetch.js';

let current: FetchLike = platformFetch;

export const substrateFetch: FetchLike = (input, init) => current(input, init);

/** Replace what `substrateFetch` calls. Test setups use it. */
export function setSubstrateFetch(fetch: FetchLike): void {
  current = fetch;
}
