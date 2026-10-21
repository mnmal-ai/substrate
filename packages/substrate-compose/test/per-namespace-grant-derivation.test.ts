/**
 * Per-namespace grants reaching `Identity` (spec §3 steps 1-3).
 *
 * A FLAT row derives exactly the GRANT it always meant, and the verified
 * identity carries that grant and nothing else — no flat view, widest or
 * otherwise.
 */

import { generateKeyPairSync } from 'node:crypto';
import { grantedIn, grantOf } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import type { KeyRecord, KeyRegistry } from '../src/_system/registry.js';
import { type AuthConfig, signEdDSA, verifyBearerToken } from '../src/auth.js';

const KID = 'agent@host';

function keypair(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString()
  };
}

function registry(record: KeyRecord): KeyRegistry {
  return {
    lookup: (kid) => (kid === record.kid ? record : null),
    install: () => true,
    refresh: () => Promise.resolve(),
    evict: () => {},
    primeFromDataset: () => Promise.resolve(),
    dispose: () => {}
  };
}

async function verify(
  rowNamespaces: string[],
  rowCapabilities: string[],
  claim: { ns: string[]; capabilities: string[] }
) {
  const { privatePem, publicPem } = keypair();
  const cfg: AuthConfig = {
    keys: [],
    keyRegistry: registry({
      kid: KID,
      algorithm: 'EdDSA',
      publicKey: publicPem,
      namespaces: rowNamespaces,
      capabilities: rowCapabilities,
      revokedAt: null
    })
  };
  const now = Math.floor(Date.now() / 1000);
  const jwt = signEdDSA(
    { sub: KID, iat: now, exp: now + 300, ns: claim.ns, capabilities: claim.capabilities },
    privatePem,
    { kid: KID }
  );
  return verifyBearerToken(jwt, cfg);
}

describe('a FLAT row derives the grant it always meant', () => {
  it('wildcard claim inherits the row — the shape every agent token uses', async () => {
    const id = await verify(['journal', 'recall'], ['read', 'mutate'], {
      ns: ['*'],
      capabilities: ['read', 'mutate']
    });
    expect(id?.grants).toEqual({ journal: ['mutate', 'read'], recall: ['mutate', 'read'] });
    // A verified identity carries the grant and only the grant.
    expect('namespaces' in (id ?? {})).toBe(false);
    expect('capabilities' in (id ?? {})).toBe(false);
  });

  it('a narrower claim still narrows', async () => {
    const id = await verify(['journal', 'recall'], ['read', 'mutate'], {
      ns: ['journal'],
      capabilities: ['read']
    });
    expect(id?.grants).toEqual({ journal: ['read'] });
  });

  it('a claim cannot widen past the row', async () => {
    const id = await verify(['journal'], ['read'], {
      ns: ['journal', 'board'],
      capabilities: ['read', 'mutate', 'admin']
    });
    expect(id?.grants).toEqual({ journal: ['read'] });
  });
});

describe('a PER-NAMESPACE row narrows within a namespace', () => {
  it('carries the grant and nothing else', async () => {
    const id = await verify(['board:read', 'journal'], ['read', 'mutate'], {
      ns: ['*'],
      capabilities: ['read', 'mutate']
    });

    // The grant is the truth.
    expect(id?.grants).toEqual({ board: ['read'], journal: ['mutate', 'read'] });

    // No flat view — not the widest reading, not any reading. The route gate
    // asks `confersAnywhere` of the grant instead.
    expect('namespaces' in (id ?? {})).toBe(false);
    expect('capabilities' in (id ?? {})).toBe(false);
  });

  it('the motivating case: read board WITHOUT gaining mutate on it', async () => {
    // Read-only on one namespace alongside mutate on others; without it the
    // only move is mutate (including delete) on every namespace listed.
    const id = await verify(['journal', 'recall', 'tasks', 'board:read'], ['read', 'mutate'], {
      ns: ['*'],
      capabilities: ['read', 'mutate']
    });
    expect(id?.grants?.board).toEqual(['read']);
    expect(id?.grants?.journal).toEqual(['mutate', 'read']);
    expect(id?.grants?.tasks).toEqual(['mutate', 'read']);
  });

  it('a wildcard entry is a legal key and an explicit entry beats it', async () => {
    const id = await verify(['*:read', 'journal:read+mutate'], ['read'], {
      ns: ['*'],
      capabilities: ['read', 'mutate']
    });
    expect(id?.grants?.['*']).toEqual(['read']);
    expect(id?.grants?.journal).toEqual(['mutate', 'read']);
  });
});

describe('grants is JSON-safe — it rides the SSE stream ticket', () => {
  it('survives a JSON round-trip, which a Map would not', async () => {
    const id = await verify(['board:read'], ['read', 'mutate'], {
      ns: ['*'],
      capabilities: ['read', 'mutate']
    });
    const roundTripped = JSON.parse(JSON.stringify(id)) as typeof id;
    expect(roundTripped?.grants).toEqual({ board: ['read'] });
  });
});

describe('a narrowed namespace under a wildcard cannot be re-widened by the claim', () => {
  // Row: read+mutate everywhere, read-only on board. The holder signs its own claim.
  const rowNs = ['*:read+mutate', 'board:read'];

  it('a mutate-only claim carries NO capability on board, not the wildcard mutate', async () => {
    const id = await verify(rowNs, ['read'], { ns: ['*'], capabilities: ['mutate'] });
    expect(id?.grants).toEqual({ '*': ['mutate'], board: [] });
    // The gates resolve through grantedIn; board must not fall back to '*'.
    expect(grantedIn(grantOf(id), 'board')).toEqual([]);
    expect(grantedIn(grantOf(id), 'journal')).toEqual(['mutate']);
  });

  it('the default agent claim is unchanged', async () => {
    const id = await verify(rowNs, ['read'], { ns: ['*'], capabilities: ['read', 'mutate'] });
    expect(id?.grants).toEqual({ '*': ['mutate', 'read'], board: ['read'] });
  });
});
