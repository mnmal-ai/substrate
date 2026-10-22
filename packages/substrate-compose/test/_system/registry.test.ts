import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import type { Dataset, Row } from '@mnmal-ai/substrate-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEY_TYPE, SYSTEM_NAMESPACE } from '../../src/_system/index.js';
import { createKeyRegistry } from '../../src/_system/registry.js';

describe('createKeyRegistry — kid-field resolution', () => {
  it('resolves keys by the kid field, not the row id', async () => {
    const dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    const registry = createKeyRegistry({ dataset });
    await dataset.write(
      KEY_TYPE,
      [
        {
          id: '11111111-1111-4111-8111-111111111111',
          kid: 'svc-claude@host',
          name: 'svc',
          algorithm: 'EdDSA',
          publicKey: 'pk',
          namespaces: '*',
          capabilities: 'read',
          revokedAt: null
        }
      ],
      { identity: { kind: 'system', id: 'test' }, now: new Date() }
    );

    await registry.primeFromDataset();
    expect(registry.lookup('svc-claude@host')?.publicKey).toBe('pk');
    expect(registry.lookup('11111111-1111-4111-8111-111111111111')).toBeNull();
  });

  it('refresh(kid) reloads by kid field', async () => {
    const dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    const registry = createKeyRegistry({ dataset });
    await dataset.write(
      KEY_TYPE,
      [
        {
          id: '22222222-2222-4222-8222-222222222222',
          kid: 'k@host',
          name: 'k',
          algorithm: 'EdDSA',
          publicKey: 'pk2',
          namespaces: '*',
          capabilities: 'read',
          revokedAt: null
        }
      ],
      { identity: { kind: 'system', id: 'test' }, now: new Date() }
    );
    await registry.refresh('k@host');
    expect(registry.lookup('k@host')?.publicKey).toBe('pk2');
  });

  it('kid-less row is dropped (malformed) — lookup by its id returns null', async () => {
    const dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    const warnings: Array<unknown> = [];
    const registry = createKeyRegistry({
      dataset,
      onWarn: (_msg, detail) => warnings.push(detail)
    });
    await dataset.write(
      KEY_TYPE,
      [
        {
          id: '33333333-3333-4333-8333-333333333333',
          name: 'malformed',
          algorithm: 'EdDSA',
          publicKey: 'pk3',
          namespaces: '*',
          capabilities: 'read',
          revokedAt: null
          // no kid field — row is malformed
        }
      ],
      { identity: { kind: 'system', id: 'test' }, now: new Date() }
    );
    await registry.primeFromDataset();
    // Malformed row must be dropped — not resolvable by id or any other key.
    expect(registry.lookup('33333333-3333-4333-8333-333333333333')).toBeNull();
    // A warning must have been emitted for the malformed row.
    expect(warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Periodic re-prime bounds multi-instance revocation staleness
// ---------------------------------------------------------------------------

/**
 * The write-through `refresh`/`evict` path keeps a single process consistent,
 * but a *second* instance that revokes a key writes only to the shared store —
 * this instance's cache stays stale until restart. The opt-in re-prime timer
 * closes that window by periodically reloading the whole table. A hand-driven
 * fake dataset gives deterministic control over what a "peer instance" wrote
 * and lets us fault-inject a failed read.
 */
interface FakeState {
  rows: Array<Row>;
  failNextRead: boolean;
  reads: number;
}

function fakeDataset(state: FakeState): Dataset {
  return {
    read: async (): Promise<{ rows: Array<Row> }> => {
      state.reads++;
      if (state.failNextRead) {
        state.failNextRead = false;
        throw new Error('transient dataset failure');
      }
      return { rows: state.rows.slice() };
    }
  } as unknown as Dataset;
}

function keyRow(kid: string, revokedAt: Date | null): Row {
  return {
    id: `id-${kid}`,
    kid,
    name: kid,
    algorithm: 'EdDSA',
    publicKey: `pk-${kid}`,
    namespaces: '*',
    capabilities: 'read',
    revokedAt
  } as unknown as Row;
}

describe('createKeyRegistry — periodic re-prime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-primes on the interval, converging to an out-of-band key addition (no write-through call)', async () => {
    vi.useFakeTimers();
    const state: FakeState = { rows: [], failNextRead: false, reads: 0 };
    const registry = createKeyRegistry({
      dataset: fakeDataset(state),
      reprimeIntervalMs: 1000
    });
    await registry.primeFromDataset();
    expect(registry.lookup('a@host')).toBeNull();

    // A peer instance registers the key straight into the shared store — this
    // registry never receives a refresh(kid) call, so it stays stale...
    state.rows = [keyRow('a@host', null)];
    expect(registry.lookup('a@host')).toBeNull();

    // ...until the timer fires.
    await vi.advanceTimersByTimeAsync(1000);
    expect(registry.lookup('a@host')?.publicKey).toBe('pk-a@host');
    registry.dispose();
  });

  it('re-prime honours out-of-band revocation (the security-relevant direction)', async () => {
    vi.useFakeTimers();
    const clock = new Date('2020-06-01T00:00:00Z');
    const state: FakeState = { rows: [keyRow('k@host', null)], failNextRead: false, reads: 0 };
    const registry = createKeyRegistry({
      dataset: fakeDataset(state),
      reprimeIntervalMs: 1000,
      now: () => clock
    });
    await registry.primeFromDataset();
    expect(registry.lookup('k@host')).not.toBeNull();

    // Peer instance revokes it (revokedAt in the past relative to `now`).
    state.rows = [keyRow('k@host', new Date('2020-01-01T00:00:00Z'))];
    expect(registry.lookup('k@host')).not.toBeNull(); // stale until the tick

    await vi.advanceTimersByTimeAsync(1000);
    expect(registry.lookup('k@host')).toBeNull();
    registry.dispose();
  });

  it('a transient dataset failure during re-prime keeps the last-known-good cache', async () => {
    vi.useFakeTimers();
    const warnings: Array<string> = [];
    const state: FakeState = { rows: [keyRow('k@host', null)], failNextRead: false, reads: 0 };
    const registry = createKeyRegistry({
      dataset: fakeDataset(state),
      reprimeIntervalMs: 1000,
      onWarn: (msg) => warnings.push(msg)
    });
    await registry.primeFromDataset();
    expect(registry.lookup('k@host')).not.toBeNull();

    state.failNextRead = true;
    await vi.advanceTimersByTimeAsync(1000);

    // A failed reload must not nuke the cache — serve last-known-good and warn.
    expect(registry.lookup('k@host')?.publicKey).toBe('pk-k@host');
    expect(warnings).toContain('substrate_key_registry_reprime_failed');
    registry.dispose();
  });

  it('a revoke installed while a re-prime is reading survives the older snapshot', async () => {
    vi.useFakeTimers();
    const clock = new Date('2020-06-01T00:00:00Z');
    const live = keyRow('k@host', null);
    let release: (() => void) | undefined;
    let gated = false;
    const dataset = {
      read: async (): Promise<{ rows: Array<Row> }> => {
        // The snapshot is taken before the revoke, and returned after it.
        const rows = [live];
        if (gated) await new Promise<void>((r) => (release = r));
        return { rows };
      }
    } as unknown as Dataset;
    const registry = createKeyRegistry({ dataset, reprimeIntervalMs: 1000, now: () => clock });
    await registry.primeFromDataset();
    gated = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(release).toBeDefined();

    registry.install(keyRow('k@host', new Date('2020-01-01T00:00:00Z')));
    expect(registry.lookup('k@host')).toBeNull();
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.lookup('k@host')).toBeNull();
    registry.dispose();
  });

  it('dispose() stops the timer — no further re-primes', async () => {
    vi.useFakeTimers();
    const state: FakeState = { rows: [], failNextRead: false, reads: 0 };
    const registry = createKeyRegistry({
      dataset: fakeDataset(state),
      reprimeIntervalMs: 1000
    });
    await registry.primeFromDataset();
    const readsAfterPrime = state.reads;
    registry.dispose();

    state.rows = [keyRow('late@host', null)];
    await vi.advanceTimersByTimeAsync(5000);

    expect(state.reads).toBe(readsAfterPrime); // timer never fired again
    expect(registry.lookup('late@host')).toBeNull();
  });

  it('no interval configured → no timer; dispose() is a safe no-op', async () => {
    const state: FakeState = { rows: [keyRow('k@host', null)], failNextRead: false, reads: 0 };
    const registry = createKeyRegistry({ dataset: fakeDataset(state) });
    await registry.primeFromDataset();
    expect(registry.lookup('k@host')).not.toBeNull();
    expect(() => registry.dispose()).not.toThrow();
  });
});

describe('createKeyRegistry — install(row) does not depend on a read', () => {
  const KEY_ROW: Row = {
    id: '33333333-3333-4333-8333-333333333333',
    kid: 'agent@vanilla',
    name: 'agent',
    algorithm: 'EdDSA',
    publicKey: 'pk-install',
    namespaces: 'probe',
    capabilities: 'read,mutate',
    revokedAt: null
  };

  /**
   * A dataset whose reads see NOTHING, standing in for the real defect: the
   * autoCRUD interceptor runs inside the writing transaction, so a read goes
   * out on a handle that cannot see the uncommitted row. Anything that has to
   * read to stay correct fails here, which is the point.
   */
  const blindDataset = (): Dataset =>
    ({
      namespace: SYSTEM_NAMESPACE,
      read: async () => ({ rows: [] })
    }) as unknown as Dataset;

  it('installs a key the caller already holds, with a dataset that reads empty', () => {
    const registry = createKeyRegistry({ dataset: blindDataset() });

    expect(registry.install(KEY_ROW)).toBe(true);

    const found = registry.lookup('agent@vanilla');
    expect(found?.publicKey).toBe('pk-install');
    expect(found?.namespaces).toEqual(['probe']);
    expect(found?.capabilities).toEqual(['read', 'mutate']);
  });

  it('install of a revoked row makes the key stop resolving immediately', () => {
    const registry = createKeyRegistry({ dataset: blindDataset() });
    registry.install(KEY_ROW);
    expect(registry.lookup('agent@vanilla')).not.toBeNull();

    // The fail-OPEN half: update returns the merged post-patch row, so the
    // registry is handed `revokedAt` set and must drop the key at once.
    expect(registry.install({ ...KEY_ROW, revokedAt: new Date(Date.now() - 1000) })).toBe(true);
    expect(registry.lookup('agent@vanilla')).toBeNull();
  });

  it('refuses an unprojectable row and leaves the cache untouched', () => {
    const registry = createKeyRegistry({ dataset: blindDataset() });
    registry.install(KEY_ROW);

    // `RS256`/`ES256` are both VALID here — the unprojectable case is an
    // algorithm the registry does not recognise at all, or absent key material.
    expect(registry.install({ ...KEY_ROW, algorithm: 'HS256' })).toBe(false);
    expect(registry.install({ ...KEY_ROW, algorithm: undefined })).toBe(false);
    expect(registry.install({ ...KEY_ROW, publicKey: '' })).toBe(false);
    // Still the good record — a caller handing over junk must not corrupt it.
    expect(registry.lookup('agent@vanilla')?.publicKey).toBe('pk-install');
  });

  it('refresh warns when it finds no row, so the eviction is not silent', async () => {
    const onWarn = vi.fn();
    const registry = createKeyRegistry({ dataset: blindDataset(), onWarn });
    registry.install(KEY_ROW);

    await registry.refresh('agent@vanilla');

    // Evicting is correct: refresh's callers are outside the tx, so an empty
    // read means no live row exists (gone or revoked), and fail-closed is the
    // right direction for an auth cache. It must still warn, or an in-tx
    // caller evicting its own new key would leave nothing in the logs.
    expect(registry.lookup('agent@vanilla')).toBeNull();
    expect(onWarn).toHaveBeenCalledWith('substrate_key_registry_no_live_row', {
      kid: 'agent@vanilla'
    });
  });
});

/**
 * `substrate-admin rotate` leaves TWO rows with the same `kid`: a new live one and
 * the old one stamped `revokedAt`. Both `loadAll` and `refresh` must resolve to
 * the LIVE row regardless of scan order.
 */
describe('duplicate-kid pairs resolve to the LIVE row', () => {
  const ACTOR = { identity: { kind: 'system' as const, id: 'test' }, now: new Date() };

  function pair(liveFirst: boolean): Array<Row> {
    const live: Row = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      kid: 'rotated@host',
      name: 'rotated',
      algorithm: 'EdDSA',
      publicKey: 'NEW-KEY',
      namespaces: '*',
      capabilities: 'read',
      revokedAt: null
    } as unknown as Row;
    const revoked: Row = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      kid: 'rotated@host',
      name: 'rotated',
      algorithm: 'EdDSA',
      publicKey: 'OLD-KEY',
      namespaces: '*',
      capabilities: 'read',
      revokedAt: new Date('2026-01-01T00:00:00Z')
    } as unknown as Row;
    return liveFirst ? [live, revoked] : [revoked, live];
  }

  for (const liveFirst of [true, false]) {
    const order = liveFirst ? 'live row written first' : 'revoked row written first';

    it(`prime resolves to the live key — ${order}`, async () => {
      const dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
      await dataset.write(KEY_TYPE, pair(liveFirst), ACTOR);
      const registry = createKeyRegistry({ dataset });

      await registry.primeFromDataset();

      expect(registry.lookup('rotated@host')?.publicKey).toBe('NEW-KEY');
    });

    it(`refresh AGREES with prime — ${order}`, async () => {
      const dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
      await dataset.write(KEY_TYPE, pair(liveFirst), ACTOR);
      const registry = createKeyRegistry({ dataset });

      await registry.refresh('rotated@host');

      expect(registry.lookup('rotated@host')?.publicKey).toBe('NEW-KEY');
    });
  }

  it('a kid whose only row is revoked stays unresolvable — revocation must still bite', async () => {
    const dataset = new MemoryDataset({ namespace: SYSTEM_NAMESPACE });
    await dataset.write(
      KEY_TYPE,
      [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          kid: 'gone@host',
          name: 'gone',
          algorithm: 'EdDSA',
          publicKey: 'DEAD',
          namespaces: '*',
          capabilities: 'read',
          revokedAt: new Date('2026-01-01T00:00:00Z')
        } as unknown as Row
      ],
      ACTOR
    );
    const registry = createKeyRegistry({ dataset });

    await registry.primeFromDataset();
    expect(registry.lookup('gone@host')).toBeNull();

    await registry.refresh('gone@host');
    expect(registry.lookup('gone@host')).toBeNull();
  });
});
