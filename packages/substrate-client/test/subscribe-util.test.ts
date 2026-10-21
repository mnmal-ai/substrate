import { describe, expect, it } from 'vitest';
import { assertSingleKey, augmentFramesWithId } from '../src/subscribe-util.js';

describe('augmentFramesWithId', () => {
  it('adds id:true when missing', () => {
    expect(augmentFramesWithId({ 'claude/Todo': { params: {}, fields: { title: true } } })).toEqual(
      {
        'claude/Todo': { params: {}, fields: { id: true, title: true } }
      }
    );
  });

  it('preserves id:true when already present', () => {
    expect(
      augmentFramesWithId({ 'claude/Todo': { params: {}, fields: { id: true, title: true } } })
    ).toEqual({
      'claude/Todo': { params: {}, fields: { id: true, title: true } }
    });
  });

  it('leaves params untouched', () => {
    const out = augmentFramesWithId({
      'claude/Todo': { params: { where: { status: { eq: 'open' } } }, fields: {} }
    });
    const entry = out['claude/Todo'];
    if (Array.isArray(entry)) throw new Error('Expected non-array entry');
    expect(entry?.params).toEqual({ where: { status: { eq: 'open' } } });
    expect(entry?.fields).toEqual({ id: true });
  });

  it('handles missing fields object', () => {
    expect(augmentFramesWithId({ 'claude/Todo': { params: {} } })).toEqual({
      'claude/Todo': { params: {}, fields: { id: true } }
    });
  });

  it('does not mutate the input frame', () => {
    const input = { 'claude/Todo': { params: {}, fields: { title: true } } };
    const output = augmentFramesWithId(input);
    expect(input['claude/Todo'].fields).toEqual({ title: true });
    expect(output).not.toBe(input);
  });

  it('handles array-shaped entries', () => {
    expect(
      augmentFramesWithId({
        'claude/Todo': [
          { params: {}, fields: { title: true } },
          { params: { where: {} }, fields: { description: true } }
        ]
      })
    ).toEqual({
      'claude/Todo': [
        { params: {}, fields: { id: true, title: true } },
        { params: { where: {} }, fields: { id: true, description: true } }
      ]
    });
  });

  it('handles missing fields in array entries', () => {
    expect(
      augmentFramesWithId({
        'claude/Todo': [{ params: {} }, { params: { limit: 10 } }]
      })
    ).toEqual({
      'claude/Todo': [
        { params: {}, fields: { id: true } },
        { params: { limit: 10 }, fields: { id: true } }
      ]
    });
  });
});

describe('assertSingleKey', () => {
  it('returns the key for a single-key frame', () => {
    expect(assertSingleKey({ 'claude/Todo': { params: {}, fields: {} } })).toBe('claude/Todo');
  });

  it('throws on multi-key frames', () => {
    expect(() =>
      assertSingleKey({
        'claude/Todo': { params: {}, fields: {} },
        'claude/Decision': { params: {}, fields: {} }
      })
    ).toThrow(/single qualified key/i);
  });

  it('throws on empty frames', () => {
    expect(() => assertSingleKey({})).toThrow(/exactly one key/i);
  });
});
