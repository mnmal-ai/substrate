import { sanitise } from '@mnmal-ai/surface-core';

/** Server text on one line: no escape or control bytes, and each run of line breaks one space. */
export const clean = (s: string): string =>
  sanitise(s.replace(/[\n\v\f\r\u0085\u2028\u2029]+/g, ' '));
