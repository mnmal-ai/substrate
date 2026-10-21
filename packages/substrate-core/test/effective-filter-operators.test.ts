/**
 * `effectiveFilterOperators` — the operator contract, expressed as data so the
 * server can publish it instead of consumers transcribing it.
 *
 * It must not report either input on its own. The validator's builtin sets say
 * what will be RECOGNISED; the dataset's capability list says what can be
 * EXECUTED; an operator needs both, and a caller can see neither.
 *
 * So the two directions below are the substance of this suite, not two flavours
 * of the same assertion. One is a dataset that cannot do what the validator
 * allows; the other is a dataset that claims what the validator will refuse.
 */

import type { FilterCapabilities } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { effectiveFilterOperators } from '../src/index.js';

/** A capability declaration with every kind empty unless named. */
function caps(operators: Partial<FilterCapabilities['operators']>): FilterCapabilities {
  return {
    operators: {
      'scalar.number': [],
      'scalar.string': [],
      'scalar.boolean': [],
      'scalar.date': [],
      'scalar.json': [],
      crossRef: [],
      list: [],
      ...operators
    },
    orderBy: true,
    cursor: true
  };
}

describe('effectiveFilterOperators', () => {
  it('narrows to what the dataset can actually execute', async () => {
    // The validator recognises twelve string operators. A substrate that can
    // only match equality must not have `contains` published on its behalf —
    // that is the "silent empty result because substrate X cannot run LIKE"
    // class the capability negotiation exists to retire.
    const out = effectiveFilterOperators(caps({ 'scalar.string': ['eq'] }));

    expect(out['scalar.string']).toEqual(['eq']);
  });

  it('drops what the validator will reject, however loudly the dataset claims it', async () => {
    // The dataset-overclaims direction. Both substrates compile `contains` on a
    // crossRef perfectly well; the validator refuses it anyway, because
    // lexicographic matching on an opaque id is meaningless. Publishing the
    // dataset's claim would tell a caller to send a predicate that is certain
    // to be refused.
    const out = effectiveFilterOperators(caps({ crossRef: ['eq', 'contains', 'gt', 'in'] }));

    expect(out.crossRef).toEqual(['eq', 'in']);
  });

  it('reports scalar.json as the declared ops the json-path set recognises', async () => {
    // Json operators apply inside a { path: [...] } predicate.
    // The intersection works as for any kind: undeclared ops drop out, and an
    // op the validator does not know is never published.
    const out = effectiveFilterOperators(caps({ 'scalar.json': ['eq', 'contains', 'bogus'] }));

    expect(out['scalar.json']).toEqual(['contains', 'eq']);
  });

  it('answers for every field kind, so a consumer never needs a fallback', async () => {
    // The point of publishing is that a caller can index by the `kind` the
    // schema already gives them. A missing key would send them back to
    // guessing for that kind, which is the whole defect.
    const out = effectiveFilterOperators(caps({}));

    expect(Object.keys(out).sort()).toEqual([
      'crossRef',
      'list',
      'scalar.boolean',
      'scalar.date',
      'scalar.json',
      'scalar.number',
      'scalar.string'
    ]);
  });

  it('omits struct, which is a validator kind but not a field kind', async () => {
    // A struct is walked INTO rather than filtered on, so there is no dataset
    // capability to intersect and nothing truthful to publish.
    expect(effectiveFilterOperators(caps({}))).not.toHaveProperty('struct');
  });

  it('sorts, so the published answer is stable to diff', async () => {
    // A consumer diffing two deployments' contracts should see a real change
    // or nothing. Declaration order is the dataset author's accident.
    const out = effectiveFilterOperators(caps({ 'scalar.number': ['lt', 'eq', 'between'] }));

    expect(out['scalar.number']).toEqual(['between', 'eq', 'lt']);
  });

  it('passes a full declaration through unchanged — the intersection is not a filter in disguise', async () => {
    // Today neither shipped substrate is narrowed by this function: both
    // declare exactly what the validator recognises. That makes it worth
    // pinning that the common case is identity, so a future narrowing is
    // visible as a change rather than mistaken for this function's doing.
    const out = effectiveFilterOperators(
      caps({
        crossRef: ['eq', 'neq', 'in', 'nin'],
        list: ['has'],
        'scalar.boolean': ['eq']
      })
    );

    expect(out.crossRef).toEqual(['eq', 'in', 'neq', 'nin']);
    expect(out.list).toEqual(['has']);
    expect(out['scalar.boolean']).toEqual(['eq']);
  });
});
