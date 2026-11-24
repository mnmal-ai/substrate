import { sanitise } from '@mnmal-ai/surface-core/pure';

/** Text a server, a peer or a stored row supplied, as one line with no escape or control bytes. */
export const oneLine = (s: unknown): string =>
  sanitise(String(s).replace(/[\n\v\f\r\u0085\u2028\u2029]+/g, ' '));

/** JSON text for a terminal, with the C1 control bytes `JSON.stringify` leaves raw written as escapes. */
export const jsonForTerminal = (json: string): string =>
  json.replace(/[\u0080-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
