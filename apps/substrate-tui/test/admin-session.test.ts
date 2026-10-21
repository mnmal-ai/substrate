import { AdminBackfillError, AuthError, type SubstrateClient } from '@mnmal-ai/substrate/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminLockedError, adminIdleMs, createAdminSession } from '../src/admin/session.js';

function counting() {
  const made = { n: 0, closed: 0, tokens: [] as string[] };
  const makeClient = (getToken: () => string) => {
    made.n += 1;
    return {
      close: async () => {
        made.closed += 1;
      },
      _token: () => made.tokens.push(getToken())
    } as unknown as SubstrateClient;
  };
  return { made, makeClient };
}

describe('AdminSession', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('1. locked by default; run refuses with AdminLockedError and builds no client', async () => {
    const { made, makeClient } = counting();
    const s = createAdminSession({ endpoint: 'http://h', idleMs: 1000, makeClient });
    expect(s.state()).toEqual({ kind: 'locked', reason: null });
    await expect(s.run(async () => 1)).rejects.toBeInstanceOf(AdminLockedError);
    expect(made.n).toBe(0);
  });

  it('2. every run gets its own client, closed even when the op throws', async () => {
    const { made, makeClient } = counting();
    const s = createAdminSession({ endpoint: 'http://h', idleMs: 60_000, makeClient });
    s.unlock('admin@Box', () => 'jwt');
    await s.run(async () => 1);
    await expect(
      s.run(async () => {
        throw new Error('x');
      })
    ).rejects.toThrow('x');
    expect(made).toMatchObject({ n: 2, closed: 2 });
  });

  it('3. idles out after idleMs without use, and use resets the clock', async () => {
    const { makeClient } = counting();
    const seen: string[] = [];
    const s = createAdminSession({ endpoint: 'http://h', idleMs: 1000, makeClient });
    s.onChange((st) => seen.push(st.kind === 'locked' ? `locked:${st.reason}` : 'unlocked'));
    s.unlock('admin@Box', () => 'jwt');
    vi.advanceTimersByTime(900);
    await s.run(async () => 1);
    vi.advanceTimersByTime(900);
    expect(s.unlocked()).toBe(true);
    vi.advanceTimersByTime(200);
    expect(s.unlocked()).toBe(false);
    expect(seen.at(-1)).toBe('locked:idle — no admin action for 0m');
  });

  it('4. an op in flight when the lock fires finishes; a new one is refused', async () => {
    const { makeClient } = counting();
    const s = createAdminSession({ endpoint: 'http://h', idleMs: 60_000, makeClient });
    s.unlock('admin@Box', () => 'jwt');
    let release!: () => void;
    const inflight = s.run(
      () =>
        new Promise<number>((r) => {
          release = () => r(7);
        })
    );
    s.lock('locked by /admin lock');
    await expect(s.run(async () => 1)).rejects.toBeInstanceOf(AdminLockedError);
    release();
    await expect(inflight).resolves.toBe(7);
  });

  it('5. a 401/403 from an op locks the session and names it', async () => {
    const { makeClient } = counting();
    const s = createAdminSession({ endpoint: 'http://h', idleMs: 60_000, makeClient });
    s.unlock('admin@Box', () => 'jwt');
    await expect(
      s.run(async () => {
        throw new AuthError('Forbidden', 403);
      })
    ).rejects.toBeInstanceOf(AuthError);
    expect(s.state()).toEqual({
      kind: 'locked',
      reason: 'admin locked: 403 — the admin key was rejected'
    });
  });

  const partial = {
    requested: 1,
    write: 0,
    kept: 0,
    unchanged: 0,
    missing: [],
    counts: {},
    applied: true,
    chunks: 1
  };

  it('5b. a rejected key inside a backfill (AdminBackfillError wrapping a 401) locks the session', async () => {
    const { makeClient } = counting();
    const s = createAdminSession({ endpoint: 'http://h', idleMs: 60_000, makeClient });
    s.unlock('admin@Box', () => 'jwt');
    await expect(
      s.run(async () => {
        throw new AdminBackfillError(new AuthError('Unauthorised', 401), 0, 1, partial);
      })
    ).rejects.toBeInstanceOf(AdminBackfillError);
    expect(s.unlocked()).toBe(false);
  });

  it('5c. a coded route 403 inside a backfill does not lock', async () => {
    const { makeClient } = counting();
    const s = createAdminSession({ endpoint: 'http://h', idleMs: 60_000, makeClient });
    s.unlock('admin@Box', () => 'jwt');
    await expect(
      s.run(async () => {
        throw new AdminBackfillError(
          new AuthError('Forbidden', 403, { code: 'destructive_ops_disabled' }),
          0,
          1,
          partial
        );
      })
    ).rejects.toBeInstanceOf(AdminBackfillError);
    expect(s.unlocked()).toBe(true);
  });

  it('6. lock drops the token provider: run after re-unlock uses the new one', async () => {
    const tokens: string[] = [];
    const s = createAdminSession({
      endpoint: 'http://h',
      idleMs: 60_000,
      makeClient: (g) => ({ close: async () => {}, g }) as unknown as SubstrateClient
    });
    s.unlock('a', () => 'one');
    await s.run(async ({ authorization }) => {
      tokens.push(authorization());
    });
    s.lock('x');
    s.unlock('a', () => 'two');
    await s.run(async ({ authorization }) => {
      tokens.push(authorization());
    });
    expect(tokens).toEqual(['Bearer one', 'Bearer two']);
  });

  it('7. dispose locks: state, unlocked() and run agree the session is closed', async () => {
    const { makeClient } = counting();
    const s = createAdminSession({ endpoint: 'http://h', idleMs: 60_000, makeClient });
    s.unlock('admin@Box', () => 'jwt');
    s.dispose();
    expect(s.state().kind).toBe('locked');
    expect(s.unlocked()).toBe(false);
    await expect(s.run(async () => 1)).rejects.toBeInstanceOf(AdminLockedError);
  });

  it('dispose latches: a late unlock stays locked and run rejects', async () => {
    const { makeClient } = counting();
    const s = createAdminSession({ endpoint: 'http://h', idleMs: 1000, makeClient });
    s.dispose();
    s.unlock('k', () => 'jwt');
    expect(s.unlocked()).toBe(false);
    expect(s.state().kind).toBe('locked');
    await expect(s.run(async () => 1)).rejects.toBeInstanceOf(AdminLockedError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('run with touch:false does not extend the idle clock', async () => {
    const { makeClient } = counting();
    const s = createAdminSession({ endpoint: 'http://h', idleMs: 1000, makeClient });
    s.unlock('k', () => 'jwt');
    await vi.advanceTimersByTimeAsync(900);
    await s.run(async () => 1, { touch: false });
    await vi.advanceTimersByTimeAsync(200);
    expect(s.unlocked()).toBe(false);
  });
});

describe('admin.run — which 403 locks', () => {
  const session = (err: unknown) => {
    const s = createAdminSession({
      endpoint: 'http://h',
      idleMs: 60_000,
      makeClient: () => ({ close: async () => {} }) as unknown as SubstrateClient
    });
    s.unlock('root@h', () => 't');
    return {
      s,
      run: () =>
        s
          .run(async () => {
            throw err;
          })
          .catch(() => {})
    };
  };
  it("the auth gate's forbidden locks", async () => {
    const { s, run } = session(new AuthError('Forbidden', 403, { code: 'forbidden' }));
    await run();
    expect(s.unlocked()).toBe(false);
  });
  it('a 403 with no code locks (an older server)', async () => {
    const { s, run } = session(new AuthError('Forbidden', 403));
    await run();
    expect(s.unlocked()).toBe(false);
  });
  it("a route's own 403 (directory_denied) does not lock", async () => {
    const { s, run } = session(new AuthError('Forbidden', 403, { code: 'directory_denied' }));
    await run();
    expect(s.unlocked()).toBe(true);
  });
  it('a 401 locks whatever its code', async () => {
    const { s, run } = session(new AuthError('Unauthorised', 401, { code: 'unauthorized' }));
    await run();
    expect(s.unlocked()).toBe(false);
  });
});

describe('adminIdleMs', () => {
  it('defaults to 15 minutes; takes a positive integer; ignores junk', () => {
    expect(adminIdleMs({})).toBe(15 * 60_000);
    expect(adminIdleMs({ SUBSTRATE_TUI_ADMIN_IDLE_MINUTES: '5' })).toBe(5 * 60_000);
    expect(adminIdleMs({ SUBSTRATE_TUI_ADMIN_IDLE_MINUTES: '0' })).toBe(15 * 60_000);
    expect(adminIdleMs({ SUBSTRATE_TUI_ADMIN_IDLE_MINUTES: 'soon' })).toBe(15 * 60_000);
  });

  it("clamps to setTimeout's ceiling, so a huge value cannot overflow into an immediate lock", () => {
    expect(adminIdleMs({ SUBSTRATE_TUI_ADMIN_IDLE_MINUTES: '99999999' })).toBeLessThanOrEqual(
      2147483647
    );
    // Clamped to the ceiling (~24.8 days), not reset to the default.
    expect(adminIdleMs({ SUBSTRATE_TUI_ADMIN_IDLE_MINUTES: '99999999' })).toBe(2147483647);
  });
});
