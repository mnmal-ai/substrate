/**
 * substrate-types' `grantedIn` restates `capabilitiesFor` at the zero-dep layer so
 * the engine gate needs no policy import. Two copies of one rule drift, so the
 * same grants are asked of both here, prototype-named namespaces included.
 */

import { grantedIn, grantOf } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { capabilitiesFor, type Grant } from '../src/grant.js';

const TABLE: Record<string, readonly string[]>[] = [
  { board: ['read'] },
  { '*': ['read'] },
  { '*': ['read'], journal: ['read', 'mutate'] },
  // An empty explicit entry beats the wildcard.
  { '*': ['read', 'mutate'], board: [] },
  { _system: ['read', 'mutate', 'admin'] },
  {}
];
const PROBES = [
  'board',
  'journal',
  '_system',
  'other',
  '*',
  'constructor',
  'toString',
  '__proto__'
];

const asMap = (g: Record<string, readonly string[]>): Grant =>
  new Map(Object.entries(g).map(([ns, caps]) => [ns, new Set(caps)]));

describe('grantedIn and capabilitiesFor agree', () => {
  for (const grants of TABLE) {
    it(`agree for ${JSON.stringify(grants)}`, () => {
      const resolved = grantOf({ grants });
      for (const ns of PROBES) {
        expect([...grantedIn(resolved, ns)].sort(), ns).toEqual(
          [...capabilitiesFor(asMap(grants), ns)].sort()
        );
      }
    });
  }
});
