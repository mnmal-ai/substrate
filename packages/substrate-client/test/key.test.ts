import { describe, expect, it } from 'vitest';
import { canonicaliseFrameKey } from '../src/cache/key.js';

describe('canonicaliseFrameKey', () => {
  it('produces identical keys for identical frames', () => {
    const a = canonicaliseFrameKey('claude/Todo', {
      params: { limit: 10 },
      fields: { id: true, title: true }
    });
    const b = canonicaliseFrameKey('claude/Todo', {
      params: { limit: 10 },
      fields: { id: true, title: true }
    });
    expect(a).toBe(b);
  });

  it('is order-insensitive on params and fields keys', () => {
    const a = canonicaliseFrameKey('claude/Todo', {
      params: { limit: 10, offset: 5 },
      fields: { id: true, title: true }
    });
    const b = canonicaliseFrameKey('claude/Todo', {
      params: { offset: 5, limit: 10 },
      fields: { title: true, id: true }
    });
    expect(a).toBe(b);
  });

  it('distinguishes different params', () => {
    const a = canonicaliseFrameKey('claude/Todo', { params: { limit: 10 }, fields: { id: true } });
    const b = canonicaliseFrameKey('claude/Todo', { params: { limit: 20 }, fields: { id: true } });
    expect(a).not.toBe(b);
  });

  it('handles nested where clauses', () => {
    const a = canonicaliseFrameKey('claude/Todo', {
      params: { where: { status: { eq: 'open' }, archived: { eq: false } } },
      fields: { id: true }
    });
    const b = canonicaliseFrameKey('claude/Todo', {
      params: { where: { archived: { eq: false }, status: { eq: 'open' } } },
      fields: { id: true }
    });
    expect(a).toBe(b);
  });

  it('namespace/Type prefix is the leading segment', () => {
    expect(canonicaliseFrameKey('claude/Todo', { params: {}, fields: {} })).toMatch(
      /^claude\/Todo:/
    );
  });

  it('handles arrays for batched frames', () => {
    const a = canonicaliseFrameKey('claude/createTodo', [
      { params: { title: 'a' }, fields: { id: true } },
      { params: { title: 'b' }, fields: { id: true } }
    ]);
    expect(a).toMatch(/^claude\/createTodo:/);
    // Array order matters — different order = different key
    const b = canonicaliseFrameKey('claude/createTodo', [
      { params: { title: 'b' }, fields: { id: true } },
      { params: { title: 'a' }, fields: { id: true } }
    ]);
    expect(a).not.toBe(b);
  });
});
