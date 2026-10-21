import { describe, expect, it } from 'vitest';
import { describeGrant, isActiveAdminKeyRow, SYSTEM_NAMESPACE } from '../src/index.js';

describe('isActiveAdminKeyRow (moved from substrate-compose key-guards)', () => {
  it('an unrevoked key whose grant confers admin on _system is an admin', () => {
    expect(
      isActiveAdminKeyRow(
        { id: 'r', kid: 'a', namespaces: '_system:read+admin', capabilities: 'read' },
        'admin'
      )
    ).toBe(true);
  });
  it('the wildcard counts, as at dispatch', () => {
    expect(
      isActiveAdminKeyRow(
        { id: 'r', kid: 'a', namespaces: '*', capabilities: 'read,mutate,admin' },
        'admin'
      )
    ).toBe(true);
  });
  it('admin scoped to another namespace does not count', () => {
    expect(
      isActiveAdminKeyRow(
        { id: 'r', kid: 'a', namespaces: 'journal:admin', capabilities: 'read' },
        'admin'
      )
    ).toBe(false);
  });
  it('revoked, kid-less and unparseable rows are not admins and do not throw', () => {
    expect(
      isActiveAdminKeyRow(
        { id: 'r', kid: 'a', namespaces: '*', capabilities: 'admin', revokedAt: '2026-01-01' },
        'admin'
      )
    ).toBe(false);
    expect(isActiveAdminKeyRow({ id: 'r', namespaces: '*', capabilities: 'admin' }, 'admin')).toBe(
      false
    );
    expect(
      isActiveAdminKeyRow({ id: 'r', kid: 'a', namespaces: ':', capabilities: 'admin' }, 'admin')
    ).toBe(false);
  });
  it('SYSTEM_NAMESPACE is _system', () => {
    expect(SYSTEM_NAMESPACE).toBe('_system');
  });
});

describe('describeGrant (moved from the substrate-admin CLI)', () => {
  it('renders each namespace in --ns syntax, in the operator order', () => {
    expect(describeGrant('board:read,journal', 'read,mutate')).toEqual([
      'board:read',
      'journal:read+mutate'
    ]);
  });
  it('an empty grant says so', () => {
    expect(describeGrant('', 'read')).toEqual(['(none — this key is granted nothing)']);
  });
  it('an unparseable grant falls back to the raw columns instead of throwing', () => {
    expect(describeGrant(':', 'read')[0]).toMatch(/^UNPARSEABLE/);
  });
});
