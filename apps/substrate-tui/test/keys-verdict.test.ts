import type { AdminKeyRow } from '@mnmal-ai/substrate/client';
import { parseGrantEntries } from '@mnmal-ai/substrate/client';
import { describe, expect, it } from 'vitest';
import { hostedNamespaces } from '../src/keys/grant.js';
import { newKeyVerdict, revokeVerdict, updateVerdict } from '../src/keys/verdict.js';

const row = (kid: string, namespaces: string, capabilities = 'read,mutate'): AdminKeyRow => ({
  id: kid,
  kid,
  name: kid,
  algorithm: 'EdDSA',
  namespaces,
  capabilities,
  createdAt: ''
});
const g = (s: string) => parseGrantEntries(s.split(','), ['read']);
const AGENT = row('a@h', 'journal,plane:read');
const ADMIN = row('root@h', '_system:read+admin', 'read');
const TABLE = [AGENT, ADMIN];
const HOSTED = ['journal', 'plane', 'recall', '_system'];
const base = { table: TABLE, hosted: HOSTED, adminCapability: 'admin' };

describe('updateVerdict', () => {
  it('a narrowing is tier 1 with no flags', () => {
    expect(updateVerdict({ ...base, row: AGENT, next: g('journal:read+mutate') })).toEqual({
      kind: 'ok',
      tier: 1,
      flags: [],
      reasons: []
    });
  });
  it('a widening is tier 2 and names widen', () => {
    const v = updateVerdict({
      ...base,
      row: AGENT,
      next: g('journal:read+mutate,plane:read,recall:read')
    });
    expect(v).toMatchObject({ kind: 'ok', tier: 2, flags: ['widen'] });
  });
  it('widening AND granting admin collects both flags', () => {
    const v = updateVerdict({
      ...base,
      row: AGENT,
      next: g('journal:read+mutate,plane:read,_system:admin')
    });
    expect(v).toMatchObject({ kind: 'ok', tier: 2, flags: ['widen', 'allowAdmin'] });
  });
  it('dropping admin from the last admin is refused, ahead of any widen', () => {
    const v = updateVerdict({ ...base, row: ADMIN, next: g('_system:read,recall:read') });
    expect(v).toMatchObject({ kind: 'refused', code: 'last_admin_deadmin' });
  });
  it('an unhosted namespace is tier 2 with allowUnknownNs', () => {
    const v = updateVerdict({
      ...base,
      row: AGENT,
      next: g('journal:read+mutate,plane:read,typo:read')
    });
    expect(v).toMatchObject({ kind: 'ok', tier: 2 });
    expect((v as { flags: readonly string[] }).flags).toContain('allowUnknownNs');
  });
  it('touching the * row is tier 2 even when it narrows', () => {
    const star = row('s@h', '*:read+mutate', 'read');
    const v = updateVerdict({ ...base, table: [...TABLE, star], row: star, next: g('*:read') });
    expect(v).toMatchObject({ kind: 'ok', tier: 2, flags: [] });
  });
  it('a grant that already carries admin stays tier 2 when it narrows', () => {
    const second = row('root2@h', '_system:read+admin,journal:read', 'read');
    const v = updateVerdict({
      ...base,
      table: [...TABLE, second],
      row: second,
      next: g('_system:read+admin')
    });
    expect(v).toMatchObject({ kind: 'ok', tier: 2, flags: [] });
  });
  it('narrowing a held namespace the deployment no longer hosts still needs allowUnknownNs, as the route does', () => {
    // The route refuses any supplied list naming an unhosted namespace, held already or not.
    const held = row('h@h', 'journal,legacy:read+mutate', 'read');
    const v = updateVerdict({
      ...base,
      table: [...TABLE, held],
      row: held,
      next: g('journal,legacy:read')
    });
    expect(v).toMatchObject({ kind: 'ok', tier: 2, flags: ['allowUnknownNs'] });
    expect((v as { reasons: readonly string[] }).reasons.join()).toContain('legacy');
    // Dropping it entirely names nothing unhosted: back to tier 1.
    expect(
      updateVerdict({ ...base, table: [...TABLE, held], row: held, next: g('journal') })
    ).toMatchObject({
      kind: 'ok',
      tier: 1,
      flags: []
    });
  });
  it('a non-default adminCapability governs the last-admin rule and the admin flags', () => {
    const root = row('root@h', '_system:read+root', 'read');
    const rootBase = { ...base, table: [AGENT, root], adminCapability: 'root' };
    expect(updateVerdict({ ...rootBase, row: root, next: g('_system:read') })).toMatchObject({
      kind: 'refused',
      code: 'last_admin_deadmin'
    });
    expect(
      revokeVerdict({ kid: 'root@h', table: [AGENT, root], adminCapability: 'root' })
    ).toMatchObject({
      kind: 'refused',
      code: 'last_active_admin'
    });
    // Under 'root', the key carrying only 'admin' is no admin: revoking it is fine.
    expect(
      revokeVerdict({
        kid: 'adm@h',
        table: [AGENT, row('adm@h', '_system:read+admin', 'read'), root],
        adminCapability: 'root'
      })
    ).toMatchObject({
      kind: 'ok'
    });
    const grants = updateVerdict({
      ...rootBase,
      row: AGENT,
      next: g('journal:read+mutate,plane:read,_system:root')
    });
    expect(grants).toMatchObject({ kind: 'ok', tier: 2 });
    expect((grants as { flags: readonly string[] }).flags).toContain('allowAdmin');
    // 'admin' is an ordinary capability name under 'root': no admin flag for it.
    const plain = updateVerdict({
      ...rootBase,
      row: AGENT,
      next: g('journal:read+mutate,plane:read,_system:admin')
    });
    expect((plain as { flags: readonly string[] }).flags).not.toContain('allowAdmin');
    expect(
      newKeyVerdict({
        kind: 'register',
        next: g('_system:root'),
        hosted: HOSTED,
        adminCapability: 'root'
      })
    ).toMatchObject({
      kind: 'ok',
      flags: ['allowAdmin'],
      reasons: expect.arrayContaining(["carries 'root'"])
    });
  });
  it('an empty grant is refused locally', () => {
    expect(updateVerdict({ ...base, row: AGENT, next: new Map() })).toMatchObject({
      kind: 'refused',
      code: 'empty_grant'
    });
  });
});

describe('revokeVerdict', () => {
  it('revoking an agent is tier 1', () => {
    expect(revokeVerdict({ kid: 'a@h', table: TABLE, adminCapability: 'admin' })).toMatchObject({
      kind: 'ok',
      tier: 1
    });
  });
  it('revoking the last admin is refused', () => {
    expect(revokeVerdict({ kid: 'root@h', table: TABLE, adminCapability: 'admin' })).toMatchObject({
      kind: 'refused',
      code: 'last_active_admin'
    });
  });
});

describe('newKeyVerdict', () => {
  it('every register is tier 2', () => {
    expect(
      newKeyVerdict({
        kind: 'register',
        next: g('journal:read'),
        hosted: HOSTED,
        adminCapability: 'admin'
      })
    ).toMatchObject({ kind: 'ok', tier: 2, flags: [] });
  });
  it('a register carrying admin names allowAdmin', () => {
    expect(
      newKeyVerdict({
        kind: 'register',
        next: g('_system:admin'),
        hosted: HOSTED,
        adminCapability: 'admin'
      })
    ).toMatchObject({ flags: ['allowAdmin'] });
  });
  it('a plain invite is tier 1; an admin invite is tier 2 with no flag (the route has none)', () => {
    expect(
      newKeyVerdict({
        kind: 'invite',
        next: g('journal:read'),
        hosted: HOSTED,
        adminCapability: 'admin'
      })
    ).toMatchObject({ tier: 1 });
    expect(
      newKeyVerdict({
        kind: 'invite',
        next: g('_system:admin'),
        hosted: HOSTED,
        adminCapability: 'admin'
      })
    ).toMatchObject({ tier: 2, flags: [] });
  });
});

describe('hostedNamespaces', () => {
  const schema = { journal: {}, _system: {}, _enumVerdicts: {} };
  it("drops the federated schema's _enumVerdicts key and keeps every namespace, _system included", () => {
    expect(hostedNamespaces(schema)).toEqual(['journal', '_system']);
  });
  it('_enumVerdicts in a grant counts as unhosted', () => {
    const v = updateVerdict({
      ...base,
      hosted: hostedNamespaces(schema),
      row: AGENT,
      next: g('journal:read+mutate,_enumVerdicts:read')
    });
    expect(v).toMatchObject({ kind: 'ok', tier: 2 });
    expect(v.kind === 'ok' && v.flags).toContain('allowUnknownNs');
  });
});
