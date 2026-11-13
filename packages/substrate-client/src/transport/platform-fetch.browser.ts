/** The default behind `substrateFetch` in browser builds: the platform `fetch`. */

import type { FetchLike } from './h2-fetch.js';

export const platformFetch: FetchLike = (input, init) => globalThis.fetch(input, init);
