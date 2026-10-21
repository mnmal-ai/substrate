/**
 * The shared refusal rules for key mutation, asked by both the CLI and the
 * route transport.
 *
 * Pure functions on caller-supplied facts: each caller gathers them its own
 * way, and only the verdict has to be identical.
 */

import type { Identity, Row } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import {
  decodeList,
  isActiveAdminKeyRow,
  parseGrantEntries,
  requireCapability,
  SYSTEM_NAMESPACE
} from '../src/index.js';
import {
  checkRevocable,
  checkUpdatable,
  newlyGranted,
  newlyGrantedPairs,
  revokedAtIso
} from '../src/key-guards.js';

const row = (over: Record<string, unknown> = {}): Row =>
  ({
    kid: 'agent@host',
    capabilities: 'admin',
    namespaces: '*',
    revokedAt: null,
    ...over
  }) as unknown as Row;

describe('isActiveAdminKeyRow', () => {
  it('requires BOTH the admin capability and a wildcard namespace', () => {
    expect(isActiveAdminKeyRow(row(), 'admin')).toBe(true);
    // An admin-capable key scoped to one namespace cannot administer the
    // deployment, so it must not count towards the last-admin floor — or the
    // floor would be satisfied by a key that cannot unlock anything.
    expect(isActiveAdminKeyRow(row({ namespaces: 'journal' }), 'admin')).toBe(false);
    expect(isActiveAdminKeyRow(row({ capabilities: 'read,mutate' }), 'admin')).toBe(false);
  });

  it('ignores revoked rows and honours a non-default admin capability name', () => {
    expect(isActiveAdminKeyRow(row({ revokedAt: new Date() }), 'admin')).toBe(false);
    expect(isActiveAdminKeyRow(row({ capabilities: 'root' }), 'root')).toBe(true);
    expect(isActiveAdminKeyRow(row({ capabilities: 'root' }), 'admin')).toBe(false);
  });

  it('resolves admin through the parsed grant, not by splitting the raw strings', () => {
    // Admin carried on the wildcard ENTRY rather than in `capabilities`: the
    // policy grants it, so the last-active-admin floor must count it.
    expect(
      isActiveAdminKeyRow(
        row({ namespaces: '*:read+mutate+admin', capabilities: 'read,mutate' }),
        'admin'
      )
    ).toBe(true);
    // `_system` is a namespace like any other, and admin ON it is precisely
    // what administers the deployment.
    expect(isActiveAdminKeyRow(row({ namespaces: '_system:admin' }), 'admin')).toBe(true);
    // An explicit entry REPLACES the default capabilities, so this grant
    // confers no admin however the flat `capabilities` column reads.
    expect(
      isActiveAdminKeyRow(
        row({ namespaces: '*:read+mutate', capabilities: 'read,mutate,admin' }),
        'admin'
      )
    ).toBe(false);
    // Still not a deployment admin: admin scoped to journal cannot reach _system.
    expect(isActiveAdminKeyRow(row({ namespaces: 'journal:admin' }), 'admin')).toBe(false);
  });

  it('treats an unparseable grant as not-admin rather than throwing', () => {
    // The register ROUTE does not validate entry shape (only the CLI's
    // `assertGrantEntries` does), so a malformed entry is reachable. Such a key
    // 500s at token verification and is no operational admin — but the sweep
    // that classifies it reads the WHOLE table, so throwing here would take out
    // `substrate-admin list` and the very `revoke` that removes the bad row.
    expect(isActiveAdminKeyRow(row({ namespaces: ':admin' }), 'admin')).toBe(false);
    expect(isActiveAdminKeyRow(row({ namespaces: 'journal:' }), 'admin')).toBe(false);
  });
});

/**
 * The shared admin table. The guard and the policy reach their verdicts by
 * different parsers, so both are driven from THIS list: a rule that starts
 * answering differently fails here rather than in a lockout.
 */
const ADMIN_CASES: Array<{ namespaces: string; capabilities: string; admin: boolean }> = [
  { namespaces: '*', capabilities: 'admin', admin: true },
  { namespaces: '*', capabilities: 'read,mutate', admin: false },
  { namespaces: 'journal', capabilities: 'admin', admin: false },
  { namespaces: '*:read+mutate+admin', capabilities: 'read,mutate', admin: true },
  { namespaces: '_system:admin', capabilities: 'read', admin: true },
  { namespaces: '*:read+mutate', capabilities: 'read,mutate,admin', admin: false },
  { namespaces: 'journal:admin', capabilities: 'read', admin: false }
];

describe('isActiveAdminKeyRow agrees with requireCapability', () => {
  for (const c of ADMIN_CASES) {
    it(`'${c.namespaces}' / '${c.capabilities}' -> ${c.admin}`, () => {
      // The identity as `verifyBearerToken` assembles it for a wildcard claim
      // that inherits the row verbatim.
      const grant = parseGrantEntries(decodeList(c.namespaces), decodeList(c.capabilities));
      const identity: Identity = {
        id: 'agent@host',
        grants: Object.fromEntries([...grant].map(([ns, caps]) => [ns, [...caps].sort()]))
      };
      const decision = requireCapability('admin')(
        {
          identity,
          namespace: SYSTEM_NAMESPACE,
          operation: 'mutate',
          now: new Date(),
          headers: {},
          meta: {}
        },
        {}
      );

      expect(isActiveAdminKeyRow(row(c), 'admin')).toBe(c.admin);
      expect(decision.allow).toBe(c.admin);
    });
  }
});

describe('checkRevocable', () => {
  const base = { kid: 'a@h', exists: true, existingRevokedAt: null, activeAdminKids: ['x@h'] };

  it('allows an ordinary live key', () => {
    expect(checkRevocable(base)).toBeNull();
  });

  it('refuses an unknown kid and an already-revoked one', () => {
    expect(checkRevocable({ ...base, exists: false })?.code).toBe('unknown_kid');
    const already = checkRevocable({ ...base, existingRevokedAt: '2026-01-01T00:00:00.000Z' });
    expect(already?.code).toBe('already_revoked');
  });

  it('REFUSES revoking the last active admin — the lockout guard', () => {
    expect(checkRevocable({ ...base, kid: 'x@h', activeAdminKids: ['x@h'] })?.code).toBe(
      'last_active_admin'
    );
    // Not the last one: allowed.
    expect(checkRevocable({ ...base, kid: 'x@h', activeAdminKids: ['x@h', 'y@h'] })).toBeNull();
  });

  it('does not fire the lockout for a NON-admin key when one admin remains', () => {
    // The guard keys on the kid being revoked, not on the count alone — a
    // count-only test would refuse every revocation on a single-admin store.
    expect(checkRevocable({ ...base, kid: 'agent@h', activeAdminKids: ['x@h'] })).toBeNull();
  });
});

describe('newlyGranted', () => {
  it('treats a LATERAL move as a grant, which a superset test would miss', () => {
    expect(newlyGranted(['journal'], ['recall'])).toEqual(['recall']);
    expect(newlyGranted(['journal'], ['journal'])).toEqual([]);
    // Narrowing grants nothing new.
    expect(newlyGranted(['journal', 'recall'], ['journal'])).toEqual([]);
    // A held wildcard already covers everything.
    expect(newlyGranted(['*'], ['anything'])).toEqual([]);
    // Acquiring the wildcard is itself a grant.
    expect(newlyGranted(['journal'], ['*'])).toEqual(['*']);
  });
});

describe('checkUpdatable', () => {
  const base = {
    kid: 'a@h',
    exists: true,
    existingRevokedAt: null as unknown,
    prevNamespaces: ['journal'],
    prevCapabilities: ['read'],
    nextNamespaces: ['journal'],
    nextCapabilities: ['read'],
    activeAdminKids: ['x@h'],
    adminCapability: 'admin',
    widen: false,
    allowAdmin: false
  };

  it('allows a no-op and allows narrowing without confirmation', () => {
    expect(checkUpdatable(base)).toBeNull();
    expect(
      checkUpdatable({
        ...base,
        prevNamespaces: ['journal', 'recall'],
        nextNamespaces: ['journal']
      })
    ).toBeNull();
  });

  it('refuses a widening without confirmation, and names what was granted', () => {
    const r = checkUpdatable({ ...base, nextNamespaces: ['journal', 'recall'] });
    expect(r?.code).toBe('requires_widen');
    expect(r && 'namespacesGranted' in r ? r.namespacesGranted : []).toEqual(['recall']);
    expect(
      checkUpdatable({ ...base, nextNamespaces: ['journal', 'recall'], widen: true })
    ).toBeNull();
  });

  it('LOCKOUT OUTRANKS the confirmable refusal when one request trips both', () => {
    // `--caps read` on the last admin key drops `admin` AND grants `read`.
    // Reporting the widen refusal first would send the operator to add the
    // flag, re-run, and dead-end on the lockout. Ordering is part of the rule.
    //
    // The grant must be one `isActiveAdminKeyRow` would actually accept, since
    // that is what fills `activeAdminKids`.
    const r = checkUpdatable({
      ...base,
      kid: 'x@h',
      prevNamespaces: ['*'],
      prevCapabilities: ['admin'],
      nextCapabilities: ['read'],
      activeAdminKids: ['x@h']
    });
    expect(r?.code).toBe('last_admin_deadmin');
  });

  it('requires explicit confirmation to GRANT admin', () => {
    const r = checkUpdatable({
      ...base,
      nextCapabilities: ['read', 'admin'],
      widen: true
    });
    expect(r?.code).toBe('requires_allow_admin');
    expect(
      checkUpdatable({
        ...base,
        nextCapabilities: ['read', 'admin'],
        widen: true,
        allowAdmin: true
      })
    ).toBeNull();
  });

  it('refuses unknown and revoked kids before anything else', () => {
    expect(checkUpdatable({ ...base, exists: false })?.code).toBe('unknown_kid');
    expect(checkUpdatable({ ...base, existingRevokedAt: new Date() })?.code).toBe(
      'already_revoked'
    );
  });
});

describe('revokedAtIso', () => {
  it('normalises Date, string and empty-ish values', () => {
    expect(revokedAtIso(null)).toBeNull();
    expect(revokedAtIso(undefined)).toBeNull();
    expect(revokedAtIso('')).toBeNull();
    expect(revokedAtIso(new Date('2026-01-01T00:00:00.000Z'))).toBe('2026-01-01T00:00:00.000Z');
    expect(revokedAtIso('2026-01-01T00:00:00.000Z')).toBe('2026-01-01T00:00:00.000Z');
  });
});

/**
 * `--widen` over (namespace, capability) PAIRS (spec §6).
 *
 * Narrowing `board` to read while leaving `journal` alone is simultaneously a
 * narrow and a no-op per list; compared as pairs it yields the empty set.
 */
describe('newlyGrantedPairs — widening reasons over pairs', () => {
  const prev = { board: ['read', 'mutate'], journal: ['read', 'mutate'] };

  it('narrowing ONE namespace while leaving another alone grants nothing', () => {
    // The case §6 worried about. No flag should be required.
    const next = { board: ['read'], journal: ['read', 'mutate'] };
    expect(newlyGrantedPairs(prev, next)).toEqual([]);
  });

  it('widening a namespace within its existing grant IS a grant', () => {
    const next = { board: ['read', 'mutate'], journal: ['read', 'mutate'], tasks: ['read'] };
    expect(newlyGrantedPairs(prev, next)).toEqual(['tasks:read']);
  });

  it('re-adding a capability that was narrowed away is a grant', () => {
    const narrowed = { board: ['read'] };
    expect(newlyGrantedPairs(narrowed, { board: ['read', 'mutate'] })).toEqual(['board:mutate']);
  });

  it('a LATERAL move is a grant, which is why supersets are the wrong test', () => {
    expect(newlyGrantedPairs({ journal: ['read'] }, { recall: ['read'] })).toEqual(['recall:read']);
  });

  it('a wildcard in prev covers any namespace at that capability', () => {
    expect(newlyGrantedPairs({ '*': ['read'] }, { board: ['read'] })).toEqual([]);
    // ...but not a capability the wildcard never conferred.
    expect(newlyGrantedPairs({ '*': ['read'] }, { board: ['read', 'mutate'] })).toEqual([
      'board:mutate'
    ]);
  });

  it('an identical grant is not a widening', () => {
    expect(newlyGrantedPairs(prev, { ...prev })).toEqual([]);
  });
});

describe('checkUpdatable resolves admin through the grant, not the flat list', () => {
  const upd = (over: Record<string, unknown>) =>
    checkUpdatable({
      kid: 'a@h',
      exists: true,
      existingRevokedAt: null as unknown,
      prevNamespaces: ['journal'],
      prevCapabilities: ['read'],
      nextNamespaces: ['journal'],
      nextCapabilities: ['read'],
      activeAdminKids: ['x@h'],
      adminCapability: 'admin',
      widen: true,
      allowAdmin: true,
      ...over
    } as Parameters<typeof checkUpdatable>[0]);

  // The lockout floor and the admin SET it is compared against must classify a
  // row identically, or the guard compares two different questions.
  describe('the last-admin floor agrees with the admin set', () => {
    for (const c of ADMIN_CASES) {
      it(`'${c.namespaces}' / '${c.capabilities}' -> deadmin guarded: ${c.admin}`, () => {
        const r = upd({
          prevNamespaces: decodeList(c.namespaces),
          prevCapabilities: decodeList(c.capabilities),
          nextNamespaces: ['journal:read'],
          nextCapabilities: ['read'],
          activeAdminKids: ['a@h']
        });
        expect(r?.code === 'last_admin_deadmin').toBe(c.admin);
      });
    }
  });

  it('refuses to strip admin from the last admin when it is held per-namespace', () => {
    // Operator-admin shape: admin via namespace syntax, with `capabilities`
    // never mentioning admin at all.
    expect(
      upd({
        prevNamespaces: ['_system:read+mutate+admin'],
        prevCapabilities: ['read'],
        nextNamespaces: ['_system:read'],
        nextCapabilities: ['read'],
        activeAdminKids: ['a@h']
      })?.code
    ).toBe('last_admin_deadmin');
  });

  describe('the admin opt-in gate sees admin in any namespace', () => {
    // Scoped to _system the way the lockout floor is, this gate would stop
    // asking about `journal:admin` — which the FLAT spelling has always caught.
    // Handing out admin is the thing being confirmed, wherever it lands.
    it('fires for _system:admin granted via namespace syntax', () => {
      expect(
        upd({
          nextNamespaces: ['journal', '_system:admin'],
          allowAdmin: false
        })?.code
      ).toBe('requires_allow_admin');
    });

    it('fires for journal:admin granted via namespace syntax', () => {
      expect(upd({ nextNamespaces: ['journal:read+admin'], allowAdmin: false })?.code).toBe(
        'requires_allow_admin'
      );
    });

    it('stays silent when admin is not newly granted', () => {
      expect(
        upd({
          prevNamespaces: ['journal:read+admin'],
          nextNamespaces: ['journal:read+admin', 'recall:read'],
          allowAdmin: false
        })
      ).toBeNull();
    });

    it('stays silent when no admin is involved', () => {
      expect(upd({ nextNamespaces: ['journal', 'recall'], allowAdmin: false })).toBeNull();
    });

    it('honours a non-default adminCapability', () => {
      expect(
        upd({
          nextNamespaces: ['journal:read+root'],
          adminCapability: 'root',
          allowAdmin: false
        })?.code
      ).toBe('requires_allow_admin');
    });
  });

  it('refuses an unparseable grant rather than throwing out of a verdict', () => {
    // `validateKeysBody` does not check entry shape, so a malformed grant
    // reaches here. Throwing would turn a refusal into a 500 on a function
    // whose whole contract is to RETURN refusals.
    expect(upd({ nextNamespaces: [':admin'] })?.code).toBe('invalid_grant');
    expect(upd({ prevNamespaces: ['journal:'] })?.code).toBe('invalid_grant');
  });
});
