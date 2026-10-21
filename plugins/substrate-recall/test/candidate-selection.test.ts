import { describe, expect, it } from 'vitest';
import { SELECT_CANDIDATES_MAX_LIMIT, validateSelector } from '../src/candidate-selection.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
};

describe('validateSelector', () => {
  it('accepts a minimal explicit selector', () => {
    const out = validateSelector({
      scopes: [{ namespace: 'cortext', type: 'Decision' }]
    });
    expect(out.scopes).toEqual([{ namespace: 'cortext', type: 'Decision' }]);
    expect(out.limit).toBe(SELECT_CANDIDATES_MAX_LIMIT);
    expect(out.excludeTextPrefixes).toEqual([]);
  });

  it('rejects a missing selector rather than defaulting to "everything"', () => {
    expect(codeOf(() => validateSelector(undefined))).toBe('bad_request');
    expect(() => validateSelector(undefined)).toThrow(/selection filter is required/i);
  });

  it('rejects an empty scope list — there is no cluster-everything default', () => {
    expect(codeOf(() => validateSelector({ scopes: [] }))).toBe('bad_request');
    expect(() => validateSelector({ scopes: [] })).toThrow(/at least one scope/i);
  });

  it('rejects a malformed scope', () => {
    expect(codeOf(() => validateSelector({ scopes: [{ namespace: 'cortext' }] }))).toBe(
      'bad_request'
    );
    expect(codeOf(() => validateSelector({ scopes: [{ namespace: '', type: 'x' }] }))).toBe(
      'bad_request'
    );
  });

  it('dedupes duplicate scopes, preserving first-seen order', () => {
    const out = validateSelector({
      scopes: [
        { namespace: 'cortext', type: 'Decision' },
        { namespace: 'cortext', type: 'Memory' },
        { namespace: 'cortext', type: 'Decision' }
      ]
    });
    expect(out.scopes).toEqual([
      { namespace: 'cortext', type: 'Decision' },
      { namespace: 'cortext', type: 'Memory' }
    ]);
  });

  it('carries text-prefix exclusions through', () => {
    const out = validateSelector({
      scopes: [{ namespace: 'cortext', type: 'SessionLog' }],
      excludeTextPrefixes: [
        { field: 'synopsis', prefix: 'Seed session ' },
        { field: 'name', prefix: 'perf-seed-memory-' }
      ]
    });
    expect(out.excludeTextPrefixes).toEqual([
      { field: 'synopsis', prefix: 'Seed session ' },
      { field: 'name', prefix: 'perf-seed-memory-' }
    ]);
  });

  it('rejects a malformed exclusion', () => {
    expect(
      codeOf(() =>
        validateSelector({
          scopes: [{ namespace: 'cortext', type: 'Decision' }],
          excludeTextPrefixes: [{ field: 'synopsis' }]
        })
      )
    ).toBe('bad_request');
  });

  it('clamps limit into (0, SELECT_CANDIDATES_MAX_LIMIT]', () => {
    const scopes = [{ namespace: 'cortext', type: 'Decision' }];
    expect(validateSelector({ scopes, limit: 50 }).limit).toBe(50);
    expect(validateSelector({ scopes, limit: 10_000_000 }).limit).toBe(SELECT_CANDIDATES_MAX_LIMIT);
    expect(codeOf(() => validateSelector({ scopes, limit: 0 }))).toBe('bad_request');
    expect(codeOf(() => validateSelector({ scopes, limit: 1.5 }))).toBe('bad_request');
  });
});
