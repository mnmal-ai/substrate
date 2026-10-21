import type { NlSuggestion } from '@mnmal-ai/substrate-nl/complete';
import { applySuggestion } from '@mnmal-ai/surface-core';
import { describe, expect, it } from 'vitest';
import { adapt, tokenEnd } from '../src/ask/adapt.js';

const s = (replace: [number, number], insert: string, label = insert): NlSuggestion => ({
  replace,
  insert,
  label,
  score: 2
});

describe('adapt', () => {
  it('a whole-token suggestion replaces its span', () => {
    expect(adapt('to', 2, s([0, 2], 'todos'))).toEqual({
      label: 'todos',
      insert: 'todos',
      replace: [0, 2],
      score: 2
    });
  });
  it('a value suggestion replaces only the value, keeping the field: prefix', () => {
    const draft = 'todos status:op';
    const got = adapt(draft, draft.length, s([13, 15], 'open'));
    expect(got).toMatchObject({ insert: 'open', replace: [13, 15] });
    expect(applySuggestion(draft, draft.length, got)).toEqual({
      text: 'todos status:open',
      cursor: 17
    });
  });
  it('mid-token, the span runs to the token end', () => {
    const draft = 'todos status:opp more';
    const got = adapt(draft, 15, s([13, 15], 'open'));
    expect(got.replace).toEqual([13, 16]);
    expect(applySuggestion(draft, 15, got)).toEqual({ text: 'todos status:open more', cursor: 17 });
  });
  it('tokenEnd stops at whitespace and at the draft end', () => {
    expect(tokenEnd('ab cd', 1)).toBe(2);
    expect(tokenEnd('ab cd', 4)).toBe(5);
    expect(tokenEnd('ab ', 3)).toBe(3);
  });
  it('carries detail when present', () => {
    expect(adapt('x', 1, { ...s([0, 1], 'xs'), detail: 'journal/X' }).detail).toBe('journal/X');
  });
});
