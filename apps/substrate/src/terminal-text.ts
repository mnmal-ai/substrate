import { sanitise } from '@mnmal-ai/surface-core/pure';

/** Text a server, a peer or a stored row supplied, as one line with no escape or control bytes. */
export const oneLine = (s: unknown): string =>
  sanitise(String(s).replace(/[\n\v\f\r\u0085\u2028\u2029]+/g, ' '));
