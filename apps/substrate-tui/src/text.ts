import { sanitise } from '@mnmal-ai/surface-core';

/** Server text on one line: no escape or control bytes, and line breaks collapsed to a space. */
export const clean = (s: string): string => sanitise(s.replace(/[\r\n]+/g, ' '));
