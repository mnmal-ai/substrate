/**
 * `substrateFetch`: the one fetch every Substrate caller goes through (Todo #1850).
 * It is the platform `fetch` until the Node entry installs the process-wide
 * `createH2Fetch()`; the browser entry never does.
 */

import type { FetchLike } from './h2-fetch.js';

let current: FetchLike = (input, init) => globalThis.fetch(input, init);

export const substrateFetch: FetchLike = (input, init) => current(input, init);

/** Replace what `substrateFetch` calls. The Node entry and test setups use it. */
export function setSubstrateFetch(fetch: FetchLike): void {
  current = fetch;
}
