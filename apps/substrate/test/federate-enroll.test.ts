import { AUDIT_EVENT_TYPE, INVITE_TYPE } from '@mnmal-ai/substrate-compose';
import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { describe, expect, it } from 'vitest';
import type { OpenDatasetFn, OpenedDataset } from '../src/admin/dataset.js';
import { MAX_TTL_MS, parseDuration } from '../src/cli/federate/duration.js';
import { runEnroll } from '../src/cli/federate/enroll.js';
import { parseEnrollArgs } from '../src/cli/federate/main.js';
import type { AuthPosture } from '../src/cli/federate/probe.js';
import { decodeJoinToken } from '../src/cli/federate/token.js';

function makeOpener(dataset: MemoryDataset): OpenDatasetFn {
  return async (): Promise<OpenedDataset> => ({
    dataset,
    close: async () => {
      /* memory dataset has nothing to release */
    }
  });
}

function posture(value: AuthPosture): () => Promise<AuthPosture> {
  return async () => value;
}

const ENV = { SUBSTRATE_DATABASE_URL: 'postgres://ignored' };

describe('parseDuration', () => {
  it('parses each supported unit', () => {
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('24h')).toBe(86_400_000);
    expect(parseDuration('7d')).toBe(604_800_000);
  });

  it('rejects a unitless value', () => {
    expect(() => parseDuration('15')).toThrow(/30s, 15m, 24h, 7d/);
  });

  it('rejects zero', () => {
    expect(() => parseDuration('0m')).toThrow(/greater than zero/);
  });

  it('rejects a negative value', () => {
    expect(() => parseDuration('-5m')).toThrow(/30s, 15m, 24h, 7d/);
  });

  it('rejects a value beyond the 30-day cap', () => {
    expect(() => parseDuration('31d')).toThrow(/30 days/);
    expect(parseDuration('30d')).toBe(MAX_TTL_MS);
  });

  it('rejects nonsense', () => {
    expect(() => parseDuration('abc')).toThrow(/30s, 15m, 24h, 7d/);
  });
});

describe('parseEnrollArgs', () => {
  const base = ['enroll', '--origin', 'https://b.internal:3100', '--ns', 'demo'];

  it('applies the documented defaults', () => {
    const args = parseEnrollArgs(base);
    expect(args.capabilities).toEqual(['read']);
    expect(args.ttlMs).toBe(900_000);
  });

  it('normalises the origin', () => {
    expect(
      parseEnrollArgs([...base.slice(0, 2), 'https://b.internal:3100/', ...base.slice(3)]).origin
    ).toBe('https://b.internal:3100');
  });

  it('requires --origin', () => {
    expect(() => parseEnrollArgs(['enroll', '--ns', 'demo'])).toThrow(/--origin/);
  });

  it('rejects a non-http(s) origin', () => {
    expect(() => parseEnrollArgs(['enroll', '--origin', 'ftp://b', '--ns', 'demo'])).toThrow(
      /http\(s\)/
    );
  });

  it('requires --ns', () => {
    expect(() => parseEnrollArgs(['enroll', '--origin', 'https://b.internal:3100'])).toThrow(
      /--ns/
    );
  });

  it('refuses a wildcard namespace', () => {
    // A wildcard grant cannot produce a usable SUBSTRATE_BRIDGES entry — `*` is
    // not a namespace the caller can alias locally. Catching it at mint is
    // the only place it can be caught before the operator pastes something
    // that cannot work.
    expect(() =>
      parseEnrollArgs(['enroll', '--origin', 'https://b.internal:3100', '--ns', '*'])
    ).toThrow(/wildcard/);
  });

  it('refuses a wildcard hidden inside a list', () => {
    expect(() =>
      parseEnrollArgs(['enroll', '--origin', 'https://b.internal:3100', '--ns', 'demo,*'])
    ).toThrow(/wildcard/);
  });

  it('rejects a duplicated flag', () => {
    expect(() => parseEnrollArgs([...base, '--ns', 'other'])).toThrow(/more than once/);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseEnrollArgs([...base, '--wat'])).toThrow(/unknown flag/);
  });

  it('rejects a stray positional', () => {
    expect(() => parseEnrollArgs([...base, 'oops'])).toThrow(/unexpected positional/);
  });

  it('rejects a misspelled capability', () => {
    expect(() => parseEnrollArgs([...base, '--caps', 'reads'])).toThrow(/unknown --caps value/);
  });

  it('rejects a valid capability mixed with a misspelled one', () => {
    expect(() => parseEnrollArgs([...base, '--caps', 'read,mutte'])).toThrow(
      /unknown --caps value 'mutte'/
    );
  });

  it('refuses --caps admin without --allow-admin', () => {
    expect(() => parseEnrollArgs([...base, '--caps', 'admin'])).toThrow(/--allow-admin/);
  });

  it('accepts --caps admin with --allow-admin', () => {
    const args = parseEnrollArgs([...base, '--caps', 'admin', '--allow-admin']);
    expect(args.capabilities).toEqual(['admin']);
  });

  it('accepts --allow-admin with a non-admin --caps as a no-op', () => {
    const args = parseEnrollArgs([...base, '--caps', 'read,mutate', '--allow-admin']);
    expect(args.capabilities).toEqual(['read', 'mutate']);
  });

  it('rejects --allow-admin specified twice', () => {
    expect(() =>
      parseEnrollArgs([...base, '--caps', 'admin', '--allow-admin', '--allow-admin'])
    ).toThrow(/more than once/);
  });
});

describe('runEnroll', () => {
  it('mints an invite row and an audit row in one transaction', async () => {
    const dataset = new MemoryDataset({ namespace: '_system' });
    const result = await runEnroll(
      {
        origin: 'https://b.internal:3100',
        namespaces: ['demo'],
        capabilities: ['read'],
        ttlMs: 900_000
      },
      ENV,
      makeOpener(dataset),
      posture('enabled')
    );

    const invites = await dataset.read(INVITE_TYPE, {});
    expect(invites.rows).toHaveLength(1);
    const invite = invites.rows[0];
    expect(invite?.namespaces).toBe('demo');
    expect(invite?.capabilities).toBe('read');
    expect(invite?.consumedAt).toBeNull();

    const audits = await dataset.read(AUDIT_EVENT_TYPE, {});
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]?.kind).toBe('invite_created');
    expect(audits.rows[0]?.actorKid).toBe('substrate-federate-cli');

    // The token's code IS the invite row's id.
    expect(decodeJoinToken(result.token)).toEqual({
      origin: 'https://b.internal:3100',
      code: invite?.id
    });
    expect(result.probeWarning).toBeNull();
  });

  it('refuses a callee with auth disabled and writes nothing', async () => {
    const dataset = new MemoryDataset({ namespace: '_system' });
    await expect(
      runEnroll(
        {
          origin: 'https://b.internal:3100',
          namespaces: ['demo'],
          capabilities: ['read'],
          ttlMs: 900_000
        },
        ENV,
        makeOpener(dataset),
        posture('disabled')
      )
    ).rejects.toThrow(/auth is DISABLED/);

    // The refusal must precede any write — a half-minted invite on an
    // unverified peer is exactly what this check exists to prevent.
    const invites = await dataset.read(INVITE_TYPE, {});
    expect(invites.rows).toHaveLength(0);
  });

  it('mints with a warning when the callee cannot be probed', async () => {
    const dataset = new MemoryDataset({ namespace: '_system' });
    const result = await runEnroll(
      {
        origin: 'https://b.internal:3100',
        namespaces: ['demo'],
        capabilities: ['read'],
        ttlMs: 900_000
      },
      ENV,
      makeOpener(dataset),
      posture('unreachable')
    );
    expect(result.probeWarning).toMatch(/could not reach/);
    const invites = await dataset.read(INVITE_TYPE, {});
    expect(invites.rows).toHaveLength(1);
  });

  it('sets expiresAt from the ttl', async () => {
    const dataset = new MemoryDataset({ namespace: '_system' });
    const before = Date.now();
    const result = await runEnroll(
      {
        origin: 'https://b.internal:3100',
        namespaces: ['demo', 'logs'],
        capabilities: ['read', 'mutate'],
        ttlMs: 900_000
      },
      ENV,
      makeOpener(dataset),
      posture('enabled')
    );
    const expiry = new Date(result.expiresAt).getTime();
    expect(expiry).toBeGreaterThanOrEqual(before + 900_000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + 900_000);
    expect(result.namespaces).toEqual(['demo', 'logs']);
    expect(result.capabilities).toEqual(['read', 'mutate']);
  });
});
