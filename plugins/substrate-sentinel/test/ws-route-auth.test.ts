import type { SubstrateRequest, WsConnection } from '@mnmal-ai/substrate/sdk';
import { describe, expect, it } from 'vitest';
import { registerSentinelWsRoute } from '../src/ws-route.js';

function harness() {
  let handler: ((req: SubstrateRequest, conn: WsConnection) => void) | undefined;
  const router = {
    websocket: (_p: string, h: typeof handler) => {
      handler = h;
    }
  };
  const sent: unknown[] = [];
  let onMsg: ((b: Buffer) => void) | undefined;
  const conn: WsConnection = {
    id: 'c1',
    send: (f) => {
      sent.push(JSON.parse(String(f)));
    },
    onMessage: (cb) => {
      onMsg = cb;
    },
    onClose: () => {},
    close: () => {}
  };
  const registry = {
    addWatcher: () => {},
    removeWatcher: () => {},
    addCoordinator: () => {},
    removeCoordinator: () => undefined,
    markAlive: () => {},
    broadcastEvent: () => {}
  };
  const ctx = { pluginName: 'substrate-sentinel', engine: {}, metric: () => {} };
  return {
    sent,
    start: (req: SubstrateRequest) => {
      registerSentinelWsRoute(router as never, ctx as never, 'sentinel', registry as never);
      handler?.(req, conn);
    },
    fire: (frame: unknown) => onMsg?.(Buffer.from(JSON.stringify(frame), 'utf8'))
  };
}

const anonReq: SubstrateRequest = {
  method: 'GET',
  path: '/substrate/v1/plugins/substrate-sentinel/ws',
  headers: {},
  query: {},
  params: {},
  body: null
};
const authedReq: SubstrateRequest = {
  ...anonReq,
  identity: { kind: 'agent', id: 'peer@host', grants: { sentinel: ['read', 'mutate'] } }
};

function reqWithCaps(capabilities: string[]): SubstrateRequest {
  return {
    ...anonReq,
    identity: { kind: 'agent', id: 'peer@host', grants: { sentinel: capabilities } }
  };
}

describe('sentinel privileged frames require identity', () => {
  it('rejects watch from an anonymous caller', () => {
    const h = harness();
    h.start(anonReq);
    h.fire({ type: 'watch' });
    expect(h.sent).toEqual([{ error: 'unauthorized' }]);
  });

  it('rejects register from an anonymous caller', () => {
    const h = harness();
    h.start(anonReq);
    h.fire({ type: 'register', name: 'x', url: 'https://x.test' });
    expect(h.sent).toEqual([{ error: 'unauthorized' }]);
  });

  it('admits watch from an identified caller', () => {
    const h = harness();
    h.start(authedReq);
    h.fire({ type: 'watch' });
    expect(h.sent).toEqual([{ ok: true, watching: true }]);
  });

  it('still accepts pong from an anonymous caller', () => {
    const h = harness();
    h.start(anonReq);
    h.fire({ type: 'pong' });
    expect(h.sent).toEqual([]); // liveness is not privileged
  });

  // An identity that is present but under-scoped must be distinguishable
  // from a wholly anonymous one — 'forbidden', not 'unauthorized'.
  it('rejects watch from an identified caller lacking the read capability', () => {
    const h = harness();
    h.start(reqWithCaps(['mutate']));
    h.fire({ type: 'watch' });
    expect(h.sent).toEqual([{ error: 'forbidden' }]);
  });

  it('rejects register from an identified caller lacking the mutate capability', () => {
    const h = harness();
    h.start(reqWithCaps(['read']));
    h.fire({ type: 'register', name: 'x', url: 'https://x.test' });
    expect(h.sent).toEqual([{ error: 'forbidden' }]);
  });

  it('rejects both frames from an identified caller with no capabilities at all', () => {
    const h = harness();
    h.start(reqWithCaps([]));
    h.fire({ type: 'watch' });
    h.fire({ type: 'register', name: 'x', url: 'https://x.test' });
    expect(h.sent).toEqual([{ error: 'forbidden' }, { error: 'forbidden' }]);
  });
});

describe('sentinel register attribution', () => {
  it('refuses an identity that cannot be recorded as a creator, before writing', async () => {
    const h = harness();
    h.start(authedReq);
    h.fire({ type: 'register', name: 'x', url: 'https://x.test' });
    await new Promise((r) => setImmediate(r));
    expect(String((h.sent[0] as { error?: unknown }).error)).toMatch(/attributable identity/);
  });
});
