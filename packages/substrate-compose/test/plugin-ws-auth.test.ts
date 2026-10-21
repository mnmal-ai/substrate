import type { SubstrateRequest, WsConnection } from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
import type { AuthConfig } from '../src/auth.js';
import { CREDENTIAL_RECHECK_MS, signHs256 } from '../src/auth.js';
import { wrapWsHandler } from '../src/compose.js';

/** Minimal conn double: records sends, lets the test push frames in. */
function makeConn(): {
  conn: WsConnection;
  push: (b: Buffer) => void;
  closed: Array<number | undefined>;
} {
  let onMsg: ((b: Buffer) => void) | undefined;
  const closed: Array<number | undefined> = [];
  return {
    closed,
    push: (b) => onMsg?.(b),
    conn: {
      id: 'c1',
      send: () => {},
      onMessage: (cb) => {
        onMsg = cb;
      },
      onClose: () => {},
      close: (code) => {
        closed.push(code);
      }
    }
  };
}

const NO_AUTH = { mode: 'attribute', keys: [] } as never;
// `required` is withAuth's default when `SUBSTRATE_AUTH_MODE` is unset — an
// anonymous WS caller must be rejected under it too.
const REQUIRED_AUTH = { mode: 'required', keys: [] } as never;

const HS_SECRET = 'plugin-ws-auth-test-secret';
const HS_KID = 'plugin-ws-auth';
const REAL_AUTH: AuthConfig = {
  mode: 'attribute',
  keys: [{ kid: HS_KID, alg: 'HS256', publicKey: HS_SECRET }]
};

function validToken(capabilities: string[] = ['read', 'mutate']): string {
  return signHs256(
    { sub: 'ws-caller', capabilities, exp: Math.floor(Date.now() / 1000) + 300 },
    HS_SECRET,
    { kid: HS_KID }
  );
}

describe('wrapWsHandler', () => {
  it('closes an authenticated socket once its token expires', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const token = signHs256(
        { sub: 'ws-caller', capabilities: ['read'], exp: Math.floor(Date.now() / 1000) + 20 },
        HS_SECRET,
        { kid: HS_KID }
      );
      const { conn, closed } = makeConn();
      await wrapWsHandler(async () => {}, REAL_AUTH)(
        {
          method: 'GET',
          path: '/p',
          query: {},
          params: {},
          body: null,
          headers: { authorization: `Bearer ${token}` }
        },
        conn
      );
      expect(closed).toEqual([]);
      vi.advanceTimersByTime(30_000 + CREDENTIAL_RECHECK_MS);
      expect(closed).toEqual([1008]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves identity undefined when no token is presented', async () => {
    let seen: SubstrateRequest | undefined;
    const { conn } = makeConn();
    await wrapWsHandler(async (r) => {
      seen = r;
    }, NO_AUTH)(
      { method: 'GET', path: '/p', headers: {}, query: {}, params: {}, body: null },
      conn
    );
    expect(seen?.identity).toBeUndefined();
  });

  it('closes the socket with 1008 when a token is present but invalid', async () => {
    let called = false;
    const { conn, closed } = makeConn();
    await wrapWsHandler(async () => {
      called = true;
    }, NO_AUTH)(
      {
        method: 'GET',
        path: '/p',
        query: {},
        params: {},
        body: null,
        headers: { authorization: 'Bearer not-a-real-token' }
      },
      conn
    );
    expect(called).toBe(false);
    expect(closed).toEqual([1008]);
  });

  it('replays a frame that arrived before the inner handler registered', async () => {
    const received: string[] = [];
    const { conn, push } = makeConn();

    const inner = async (_r: SubstrateRequest, c: WsConnection): Promise<void> => {
      // Yield once so the buffering path is genuinely exercised.
      await Promise.resolve();
      c.onMessage((b) => {
        received.push(b.toString('utf8'));
      });
    };

    const running = wrapWsHandler(inner, NO_AUTH)(
      { method: 'GET', path: '/p', headers: {}, query: {}, params: {}, body: null },
      conn
    );
    push(Buffer.from('early', 'utf8')); // arrives before inner registers
    await running;
    push(Buffer.from('late', 'utf8'));

    expect(received).toEqual(['early', 'late']);
  });

  // `withAuth` 401s an anonymous HTTP caller under the default `required`
  // mode; the WS path must match.
  it('closes the socket with 1008 when no token is presented and mode is not attribute', async () => {
    let called = false;
    const { conn, closed } = makeConn();
    await wrapWsHandler(async () => {
      called = true;
    }, REQUIRED_AUTH)(
      { method: 'GET', path: '/p', headers: {}, query: {}, params: {}, body: null },
      conn
    );
    expect(called).toBe(false);
    expect(closed).toEqual([1008]);
  });

  // A valid token must actually reach the inner handler as a populated
  // `identity`, not just leave it undefined on the negative paths above.
  it('populates identity when a valid token is presented', async () => {
    let seen: SubstrateRequest | undefined;
    const { conn } = makeConn();
    await wrapWsHandler(async (r) => {
      seen = r;
    }, REAL_AUTH)(
      {
        method: 'GET',
        path: '/p',
        query: {},
        params: {},
        body: null,
        headers: { authorization: `Bearer ${validToken()}` }
      },
      conn
    );
    expect(seen?.identity?.id).toBe('ws-caller');
    expect(seen?.identity?.grants).toEqual({ '*': ['mutate', 'read'] });
  });

  // withAuth strips a caller-supplied `identity` on its anonymous path
  // as defence in depth (a request object should never carry an identity
  // claim the wrapper didn't itself verify); the WS wrapper must do the same.
  it('strips a caller-supplied identity when no token is presented', async () => {
    let seen: SubstrateRequest | undefined;
    const { conn } = makeConn();
    const spoofed = {
      method: 'GET',
      path: '/p',
      headers: {},
      query: {},
      params: {},
      body: null,
      identity: { id: 'spoofed', tokenId: 'spoofed', grants: { '*': ['admin'] } }
    } as SubstrateRequest;
    await wrapWsHandler(async (r) => {
      seen = r;
    }, NO_AUTH)(spoofed, conn);
    expect(seen?.identity).toBeUndefined();
    // exactOptionalPropertyTypes: the key itself must be gone, not merely
    // set to undefined.
    expect(seen !== undefined && 'identity' in seen).toBe(false);
  });

  // Both shipped transports (fastify's socket.on, memory's array push)
  // are additive when `onMessage` is called more than once — the shim must
  // fan frames out to every registrant, not just the most recent one. A
  // later registrant must not see history it wasn't present for: only the
  // first ever drains a non-empty backlog.
  it('fans a live frame out to every listener, but only replays the backlog to the first', async () => {
    const receivedA: string[] = [];
    const receivedB: string[] = [];
    const { conn, push } = makeConn();

    const inner = async (_r: SubstrateRequest, c: WsConnection): Promise<void> => {
      await Promise.resolve();
      c.onMessage((b) => {
        receivedA.push(b.toString('utf8'));
      });
      c.onMessage((b) => {
        receivedB.push(b.toString('utf8'));
      });
    };

    const running = wrapWsHandler(inner, NO_AUTH)(
      { method: 'GET', path: '/p', headers: {}, query: {}, params: {}, body: null },
      conn
    );
    push(Buffer.from('early', 'utf8')); // arrives before either listener registers
    await running;
    push(Buffer.from('late', 'utf8')); // arrives after both are registered

    expect(receivedA).toEqual(['early', 'late']);
    expect(receivedB).toEqual(['late']);
  });

  // An unauthenticated peer that floods frames before any listener
  // registers (rejected outright, or simply connected to a handler that
  // never calls `onMessage`) must not be able to grow the backlog queue
  // without bound.
  it('closes the socket and drops the backlog once the early-frame queue overflows', async () => {
    const { conn, push, closed } = makeConn();

    const inner = async (_r: SubstrateRequest, c: WsConnection): Promise<void> => {
      await Promise.resolve(); // yield so the overflow can happen first
      c.onMessage(() => {});
    };

    const running = wrapWsHandler(inner, NO_AUTH)(
      { method: 'GET', path: '/p', headers: {}, query: {}, params: {}, body: null },
      conn
    );
    for (let i = 0; i < 70; i++) push(Buffer.from(`frame-${i}`, 'utf8'));
    await running;

    expect(closed).toEqual([1008]);
  });
});
