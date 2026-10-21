import { describe, expect, it } from 'vitest';
import { matchRoute } from '../src/route-matcher.js';

describe('matchRoute', () => {
  it('matches identical literal paths with empty params', () => {
    expect(matchRoute('/foo', '/foo')).toEqual({});
  });

  it('matches the root', () => {
    expect(matchRoute('/', '/')).toEqual({});
    expect(matchRoute('', '/')).toEqual({});
    expect(matchRoute('/', '')).toEqual({});
  });

  it('returns null for a literal non-match', () => {
    expect(matchRoute('/foo', '/bar')).toBeNull();
    expect(matchRoute('/foo', '/foo/bar')).toBeNull();
    expect(matchRoute('/foo/bar', '/foo')).toBeNull();
  });

  it('captures a :param', () => {
    expect(matchRoute('/users/:id', '/users/42')).toEqual({ id: '42' });
  });

  it('captures multiple :params in order', () => {
    expect(matchRoute('/users/:uid/posts/:pid', '/users/7/posts/abc')).toEqual({
      uid: '7',
      pid: 'abc'
    });
  });

  it('returns null when segment counts differ and no wildcard is present', () => {
    expect(matchRoute('/users/:id', '/users')).toBeNull();
    expect(matchRoute('/users/:id', '/users/42/extra')).toBeNull();
  });

  it('captures wildcard rest', () => {
    expect(matchRoute('/files/*', '/files/a/b/c')).toEqual({ rest: 'a/b/c' });
  });

  it('allows an empty wildcard match', () => {
    expect(matchRoute('/files/*', '/files')).toEqual({ rest: '' });
  });

  it('combines :param with wildcard', () => {
    expect(matchRoute('/u/:id/*', '/u/5/docs/spec.md')).toEqual({
      id: '5',
      rest: 'docs/spec.md'
    });
  });

  it('treats trailing slashes as significant (exact match only)', () => {
    // Design call: the matcher is strict on trailing slashes. Callers that
    // want lenient matching register both variants.
    expect(matchRoute('/foo', '/foo/')).toBeNull();
    expect(matchRoute('/foo/', '/foo')).toBeNull();
  });

  it('does not treat :x embedded mid-segment as a capture', () => {
    // Only segments that START with ':' are captures.
    expect(matchRoute('/a:id', '/a42')).toBeNull();
    expect(matchRoute('/a:id', '/a:id')).toEqual({});
  });
});
