import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type {
  CoordinatorPlugin,
  HttpHandler,
  Identity,
  RequestContext,
  SubstrateRequest,
  SubstrateResponse,
  WsResponseFrame
} from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
import { type AuthConfig, signHs256 } from '../src/auth.js';
import { compose } from '../src/compose.js';
import { createConnectionLimiter } from '../src/routes/connection-limit.js';
import { parseStreamRequest, type RouteGate, registerSseRoutes } from '../src/routes/sse.js';
import { StreamSession } from '../src/routes/stream-session.js';
import {
  hashFrame,
  mintStreamTicket,
  type StreamTicketPayload,
  verifyStreamTicket
} from '../src/routes/stream-ticket.js';

const SECRET = 's3cret';
/** Compose refuses anything shorter than 16 chars once auth is on. */
const COMPOSE_SECRET = 'compose-stream-ticket-secret';
const FRAME = { 'default/Todo': { fields: { id: true } } };
const NOW = 1_800_000_000_000;

describe('parseStreamRequest', () => {
  it('accepts a POST with a body frame and a pre-authenticated identity', () => {
    const r = parseStreamRequest(
      {
        method: 'POST',
        body: Buffer.from(JSON.stringify(FRAME)),
        query: {},
        identity: { id: 'a', grants: {} }
      },
      SECRET,
      NOW
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.frame).toEqual(FRAME);
  });

  it('rejects a GET with no ticket', () => {
    const r = parseStreamRequest(
      { method: 'GET', body: null, query: { frame: JSON.stringify(FRAME) } },
      SECRET,
      NOW
    );
    expect(r).toEqual({ ok: false, status: 401, code: 'ticket_missing' });
  });

  it('accepts a GET with a valid ticket', () => {
    const ticket = mintStreamTicket(
      SECRET,
      { identity: { id: 'a', grants: {} }, capabilities: ['read'], frameHash: hashFrame(FRAME) },
      NOW
    );
    const r = parseStreamRequest(
      { method: 'GET', body: null, query: { frame: JSON.stringify(FRAME), ticket } },
      SECRET,
      NOW + 1_000
    );
    expect(r.ok).toBe(true);
  });

  it('rejects a GET whose ticket was minted for a different frame', () => {
    const ticket = mintStreamTicket(
      SECRET,
      { identity: null, capabilities: ['read'], frameHash: hashFrame(FRAME) },
      NOW
    );
    const r = parseStreamRequest(
      {
        method: 'GET',
        body: null,
        query: { frame: JSON.stringify({ 'default/Other': {} }), ticket }
      },
      SECRET,
      NOW + 1_000
    );
    expect(r).toEqual({ ok: false, status: 401, code: 'ticket_frame_mismatch' });
  });

  it('rejects a malformed frame with 400, not 500', () => {
    const r = parseStreamRequest(
      { method: 'GET', body: null, query: { frame: 'not-json', ticket: 'x.y' } },
      SECRET,
      NOW
    );
    expect(r).toEqual({ ok: false, status: 400, code: 'invalid_frame' });
  });

  it('POST and GET agree on a frame value type — no query-string stringification', () => {
    // The ticket binds to a hash of the PARSED frame, so a ticket minted from a
    // POST body must verify against the same frame arriving via GET. Coercing
    // query values to strings would break that, silently, only in the browser.
    const withNumbers = { 'default/Todo': { params: { limit: 10 } } };
    const ticket = mintStreamTicket(
      SECRET,
      { identity: null, capabilities: ['read'], frameHash: hashFrame(withNumbers) },
      NOW
    );
    const r = parseStreamRequest(
      { method: 'GET', body: null, query: { frame: JSON.stringify(withNumbers), ticket } },
      SECRET,
      NOW + 1_000
    );
    expect(r.ok).toBe(true);
  });

  it('rejects a null frame entry with 400 instead of throwing later', () => {
    // `StreamSession` reads `entry.fields` off every value, so a null entry
    // would throw AFTER the transport (and its heartbeat timer) was created.
    const r = parseStreamRequest(
      { method: 'POST', body: Buffer.from('{"default/Todo":null}'), query: {} },
      SECRET,
      NOW
    );
    expect(r).toEqual({ ok: false, status: 400, code: 'invalid_frame' });
  });

  it('rejects a batched array frame entry with 400 — subscribe/stream are not batched', () => {
    const r = parseStreamRequest(
      { method: 'POST', body: Buffer.from('{"default/Todo":[{"params":{}}]}'), query: {} },
      SECRET,
      NOW
    );
    expect(r).toEqual({ ok: false, status: 400, code: 'invalid_frame' });
  });

  it.each([
    ['missing capabilities', { identity: null, frameHash: hashFrame(FRAME) }],
    [
      'non-array capabilities',
      { identity: null, capabilities: 'read', frameHash: hashFrame(FRAME) }
    ],
    [
      'non-string capability entries',
      { identity: null, capabilities: [1], frameHash: hashFrame(FRAME) }
    ]
  ])('rejects a signed ticket with %s — 401, never a TypeError', (_label, payload) => {
    // A signature-valid ticket can still carry any JSON. Reading
    // `capabilities.includes(...)` off an unvalidated payload would throw out
    // of `parseStreamRequest` and surface as a 500 with internal error text.
    const ticket = mintStreamTicket(SECRET, payload as StreamTicketPayload, NOW);
    const r = parseStreamRequest(
      { method: 'GET', body: null, query: { frame: JSON.stringify(FRAME), ticket } },
      SECRET,
      NOW + 1_000
    );
    expect(r).toEqual({ ok: false, status: 401, code: 'ticket_invalid' });
  });

  it('rejects a validly-signed ticket that lacks the read capability', () => {
    const ticket = mintStreamTicket(
      SECRET,
      { identity: { id: 'a', grants: {} }, capabilities: [], frameHash: hashFrame(FRAME) },
      NOW
    );
    const r = parseStreamRequest(
      { method: 'GET', body: null, query: { frame: JSON.stringify(FRAME), ticket } },
      SECRET,
      NOW + 1_000
    );
    expect(r).toEqual({ ok: false, status: 401, code: 'ticket_missing_capability' });
  });
});

/** Minimal engine double: captures `onFrame` + the dispatch ctx. */
function fakeEngine(opts: { failKeys?: string[] } = {}): {
  engine: never;
  fire: (f: WsResponseFrame) => Promise<void>;
  cancels: string[];
  contexts: Array<Partial<RequestContext>>;
} {
  const cancels: string[] = [];
  const contexts: Array<Partial<RequestContext>> = [];
  let onFrame: ((f: WsResponseFrame) => void | Promise<void>) | undefined;
  const handleFor = (id: string): { id: string; cancel: (r?: string) => void } => ({
    id,
    cancel: (r?: string) => cancels.push(r ?? 'cancel')
  });
  type Dispatch = {
    id: string;
    ctx: Partial<RequestContext>;
    onFrame: (f: WsResponseFrame) => void | Promise<void>;
  };
  const engine = {
    // Registration-time failures emit a lone `error` per key and never an
    // `end` — exactly what `engine.subscribe` does.
    subscribe: async (input: Dispatch) => {
      onFrame = input.onFrame;
      contexts.push(input.ctx);
      for (const key of opts.failKeys ?? []) {
        await input.onFrame({
          id: input.id,
          kind: 'error',
          errors: [{ message: `unknown name in '${key}'`, code: 'unknown_name', path: [key] }]
        });
      }
      return handleFor(input.id);
    },
    stream: (input: Dispatch) => {
      onFrame = input.onFrame;
      contexts.push(input.ctx);
      return handleFor(input.id);
    }
  };
  return {
    engine: engine as never,
    fire: async (f) => {
      await onFrame?.(f);
    },
    cancels,
    contexts
  };
}

const passThroughGate: RouteGate = (handler) => handler;

/** Mimics `withAuth` in `required` mode: no bearer → 401 before the handler. */
const bearerGate: RouteGate =
  (handler: HttpHandler): HttpHandler =>
  async (req: SubstrateRequest): Promise<SubstrateResponse> =>
    req.headers.authorization === undefined
      ? { status: 401, body: JSON.stringify({ errors: [{ code: 'unauthorized' }] }) }
      : handler({ ...req, identity: { id: 'a', grants: { default: ['read'] } } });

function serverWith(engine: never, gate: RouteGate = passThroughGate): MemorySubstrateServer {
  const server = new MemorySubstrateServer();
  registerSseRoutes(server, engine, new Set<string>(), SECRET, gate, () => {});
  return server;
}

const dec = new TextDecoder();

async function drain(body: unknown, limit = 20): Promise<{ text: string; done: boolean }> {
  if (!(body instanceof ReadableStream)) throw new Error('expected a ReadableStream body');
  const reader = body.getReader();
  let text = '';
  let done = false;
  for (let i = 0; i < limit; i++) {
    const chunk = await reader.read();
    if (chunk.done) {
      done = true;
      break;
    }
    text += dec.decode(chunk.value);
  }
  reader.releaseLock();
  return { text, done };
}

function ticketFor(frame: Record<string, unknown>): string {
  return mintStreamTicket(
    SECRET,
    { identity: null, capabilities: ['read'], frameHash: hashFrame(frame) },
    Date.now()
  );
}

describe('SSE routes', () => {
  it('POST /substrate/v1/subscribe opens an event-stream', async () => {
    const { engine, fire } = fakeEngine();
    const server = serverWith(engine);

    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/subscribe',
      body: Buffer.from(JSON.stringify(FRAME))
    });

    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toBe('text/event-stream');
    // Fire without awaiting: a data frame parks on consumer demand (the retry
    // directive alone saturates the queue), so the drain below is what unblocks it.
    const pending = fire({ id: 'x', kind: 'snapshot', data: { 'default/Todo': [] }, shapes: {} });
    const { text } = await drain(res.body, 2);
    await pending;
    expect(text).toContain('retry: ');
    expect(text).toContain('event: snapshot');
  });

  it('rejects a malformed POST body with 400 and no stream', async () => {
    const { engine } = fakeEngine();
    const server = serverWith(engine);

    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/stream',
      body: Buffer.from('not-json')
    });

    expect(res.status).toBe(400);
    expect(res.body instanceof ReadableStream).toBe(false);
  });

  it('rejects a GET with no ticket with 401', async () => {
    const { engine } = fakeEngine();
    const server = serverWith(engine);

    const res = await server.inject({
      method: 'GET',
      path: `/substrate/v1/subscribe?frame=${encodeURIComponent(JSON.stringify(FRAME))}`
    });

    expect(res.status).toBe(401);
  });

  it('accepts a GET carrying a valid ticket even when POST requires a bearer', async () => {
    // The ticket IS the auth for the EventSource path — a browser can set
    // neither a body nor an Authorization header, so gating GET on the bearer
    // would make the whole ticket mechanism unreachable.
    const { engine } = fakeEngine();
    const server = serverWith(engine, bearerGate);

    const get = await server.inject({
      method: 'GET',
      path: `/substrate/v1/subscribe?frame=${encodeURIComponent(JSON.stringify(FRAME))}&ticket=${encodeURIComponent(ticketFor(FRAME))}`
    });
    const post = await server.inject({
      method: 'POST',
      path: '/substrate/v1/subscribe',
      body: Buffer.from(JSON.stringify(FRAME))
    });

    expect(get.status).toBe(200);
    expect(post.status).toBe(401);
  });

  it('cancels the session when the client disconnects mid-stream', async () => {
    const { engine, cancels } = fakeEngine();
    const server = serverWith(engine);

    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/subscribe',
      body: Buffer.from(JSON.stringify(FRAME))
    });
    if (!(res.body instanceof ReadableStream)) throw new Error('expected a stream');
    await res.body.cancel();

    expect(cancels).toEqual(['socket_close']);
  });

  it('tolerates a spurious cancel arriving after the session already ended', async () => {
    // `transport.close()` leaves the stream "closing" while bytes are still
    // queued, so a later consumer `cancel()` still fires the sink's cancel and
    // re-enters `onCancel`. The engine handle must not be cancelled twice.
    const { engine, fire, cancels } = fakeEngine();
    const server = serverWith(engine);

    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/subscribe',
      body: Buffer.from(JSON.stringify(FRAME))
    });
    await fire({ id: 'x', kind: 'end', final: true });
    if (!(res.body instanceof ReadableStream)) throw new Error('expected a stream');
    await res.body.cancel();

    expect(cancels).toEqual([]);
  });

  it('closes the response when EVERY subscribe key fails registration', async () => {
    // Registration failures emit a lone `error` and no `end`, so nothing
    // terminates the session — the HTTP response and its heartbeat would leak.
    const { engine } = fakeEngine({ failKeys: ['default/Todo'] });
    const server = serverWith(engine);

    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/subscribe',
      body: Buffer.from(JSON.stringify(FRAME))
    });

    const { text, done } = await drain(res.body);
    expect(text).toContain('event: error');
    expect(done).toBe(true);
  });

  it('keeps the response open when only SOME subscribe keys fail registration', async () => {
    // A multi-key subscribe continues past a failing key and still holds a
    // live handle for the rest — closing on the first `error` would kill a
    // partially-successful subscription.
    const multi = { 'default/Todo': { fields: { id: true } }, 'default/Nope': {} };
    const { engine, fire } = fakeEngine({ failKeys: ['default/Nope'] });
    const server = serverWith(engine);

    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/subscribe',
      body: Buffer.from(JSON.stringify(multi))
    });
    const pending = fire({
      id: 'x',
      kind: 'add',
      data: { 'default/Todo': { id: '1' } },
      shapes: {}
    });

    const { text, done } = await drain(res.body, 3);
    await pending;
    expect(text).toContain('event: error');
    expect(text).toContain('event: add');
    expect(done).toBe(false);
  });

  it('frees its session slot when the session cannot be created', async () => {
    const { engine } = fakeEngine();
    const server = new MemorySubstrateServer();
    const cap = createConnectionLimiter(1);
    registerSseRoutes(
      server,
      engine,
      new Set<string>(),
      SECRET,
      passThroughGate,
      () => {},
      undefined,
      undefined,
      cap
    );
    const open = () =>
      server.inject({
        method: 'POST',
        path: '/substrate/v1/subscribe',
        peerIp: '203.0.113.7',
        body: Buffer.from(JSON.stringify(FRAME))
      });
    const spy = vi.spyOn(StreamSession, 'create').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect((await open()).status).toBe(500);
    spy.mockRestore();
    expect((await open()).status).toBe(200);
  });

  it('answers a dispatch that THROWS with a clean 500 and no leaked heartbeat', async () => {
    // Defensive: `evaluatePolicy` catches a throwing policy, but any rejection
    // out of `session.start` arrives after the transport is live — heartbeat
    // armed, one enqueue already queued. An unguarded `await` would leak both,
    // once per request.
    vi.useFakeTimers();
    try {
      const engine = {
        subscribe: async () => {
          throw new TypeError("Cannot read properties of null (reading 'capabilities')");
        },
        stream: () => {
          throw new Error('unused');
        }
      } as never;
      const server = serverWith(engine);

      const res = await server.inject({
        method: 'POST',
        path: '/substrate/v1/subscribe',
        body: Buffer.from(JSON.stringify(FRAME))
      });

      expect(res.status).toBe(500);
      expect(res.body instanceof ReadableStream).toBe(false);
      // Internal error text must not reach the wire.
      expect(String(res.body)).not.toContain('TypeError');
      expect(String(res.body)).not.toContain('capabilities');
      // The heartbeat interval is the only timer this route arms.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('mints a ticket that verifies against the same frame', async () => {
    const { engine } = fakeEngine();
    const server = serverWith(engine);

    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/stream/ticket',
      body: Buffer.from(JSON.stringify(FRAME))
    });

    expect(res.status).toBe(200);
    const parsed: { ticket: string; expiresIn: number } = JSON.parse(String(res.body));
    expect(parsed.expiresIn).toBe(60);
    expect(verifyStreamTicket(SECRET, parsed.ticket, FRAME, Date.now()).ok).toBe(true);
  });

  it('refuses to mint a ticket for a malformed frame', async () => {
    const { engine } = fakeEngine();
    const server = serverWith(engine);

    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/stream/ticket',
      body: Buffer.from('[1,2]')
    });

    expect(res.status).toBe(400);
  });

  it('answers a signed-but-malformed ticket with 401 on the wire, not 500', async () => {
    const { engine } = fakeEngine();
    const server = serverWith(engine);
    // Signed with the right key, but the payload omits `capabilities`.
    const ticket = mintStreamTicket(
      SECRET,
      { identity: null, frameHash: hashFrame(FRAME) } as StreamTicketPayload,
      Date.now()
    );

    const res = await server.inject({
      method: 'GET',
      path: `/substrate/v1/subscribe?frame=${encodeURIComponent(JSON.stringify(FRAME))}&ticket=${encodeURIComponent(ticket)}`
    });

    expect(res.status).toBe(401);
    expect(String(res.body)).not.toContain('TypeError');
  });

  it("dispatches with the TICKET's identity, not an anonymous one", async () => {
    // The security claim the whole ungated GET rests on: the identity sealed
    // into the ticket by the gated mint route is what the engine evaluates
    // policy against. If this ever regressed, an ungated GET would run
    // anonymously (or worse, with a caller-supplied identity).
    const minted: Identity = { id: 'minter', grants: { default: ['read'] } };
    const ticket = mintStreamTicket(
      SECRET,
      { identity: minted, capabilities: ['read'], frameHash: hashFrame(FRAME) },
      Date.now()
    );
    const { engine, contexts } = fakeEngine();
    const server = serverWith(engine);

    const res = await server.inject({
      method: 'GET',
      path: `/substrate/v1/subscribe?frame=${encodeURIComponent(JSON.stringify(FRAME))}&ticket=${encodeURIComponent(ticket)}`
    });

    expect(res.status).toBe(200);
    expect(contexts[0]?.identity).toEqual(minted);
  });

  it('does not let a POST body forge an identity — gate owns that', async () => {
    const { engine, contexts } = fakeEngine();
    const server = serverWith(engine, bearerGate);

    await server.inject({
      method: 'POST',
      path: '/substrate/v1/subscribe',
      headers: { authorization: 'Bearer whatever' },
      body: Buffer.from(JSON.stringify(FRAME))
    });

    // `bearerGate` stamps a verified-shaped identity; nothing from the body reaches ctx.
    expect(contexts[0]?.identity).toEqual({ id: 'a', grants: { default: ['read'] } });
  });
});

const HS_SECRET = 'sse-compose-test-secret';
const HS_KID = 'sse-compose';
const authConfig: AuthConfig = {
  keys: [{ kid: HS_KID, alg: 'HS256', publicKey: HS_SECRET }]
};

function bearer(capabilities: string[]): string {
  return signHs256(
    { sub: 'compose-tester', capabilities, exp: Math.floor(Date.now() / 1000) + 300 },
    HS_SECRET,
    { kid: HS_KID }
  );
}

describe('SSE routes through compose (real withAuth)', () => {
  it('refuses to compose when auth is enabled without a stream-ticket secret', async () => {
    // The dev default is a published constant; with an ungated GET whose only
    // auth is that signature, falling back to it is a total auth bypass.
    await expect(
      compose({
        // Auth is off in this harness, so the deployment declares who it writes as.
        systemActor: 'test',
        server: new MemorySubstrateServer(),
        dataset: new MemoryDataset({ namespace: 'default' }),
        auth: authConfig
      })
    ).rejects.toThrow(/streamTicketSecret/);
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
    ['too short', 'short-secret']
  ])('refuses to compose with auth and a %s stream-ticket secret', async (_label, secret) => {
    // Presence is not enough. Node HMACs happily with an empty key, so `''`
    // and `'   '` are a bypass with an even MORE guessable secret; a short
    // key is brute-forceable offline against any observed ticket.
    await expect(
      compose({
        // Auth is off in this harness, so the deployment declares who it writes as.
        systemActor: 'test',
        server: new MemorySubstrateServer(),
        dataset: new MemoryDataset({ namespace: 'default' }),
        auth: authConfig,
        streamTicketSecret: secret
      })
    ).rejects.toThrow(/streamTicketSecret/);
  });

  it('does not honour a ticket forged with an empty secret', async () => {
    const server = new MemorySubstrateServer();
    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      auth: authConfig,
      streamTicketSecret: COMPOSE_SECRET
    });

    for (const forgedKey of ['', '   ']) {
      const forged = mintStreamTicket(
        forgedKey,
        {
          identity: { id: 'attacker', grants: {} },
          capabilities: ['read'],
          frameHash: hashFrame(FRAME)
        },
        Date.now()
      );
      const res = await server.inject({
        method: 'GET',
        path: `/substrate/v1/subscribe?frame=${encodeURIComponent(JSON.stringify(FRAME))}&ticket=${encodeURIComponent(forged)}`
      });
      expect(res.status).toBe(401);
    }

    await composed.stop();
  });

  it('composes without auth and without a secret — nothing to bypass there', async () => {
    const server = new MemorySubstrateServer();
    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'default' })
    });
    const res = await server.inject({
      method: 'GET',
      path: `/substrate/v1/subscribe?frame=${encodeURIComponent(JSON.stringify(FRAME))}`
    });
    expect(res.status).toBe(401); // still ticket-gated, just not auth-gated
    await composed.stop();
  });

  it('gates POST on the real bearer and lets a minted ticket through on GET', async () => {
    const server = new MemorySubstrateServer();
    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      auth: authConfig,
      streamTicketSecret: COMPOSE_SECRET
    });

    const unauthenticatedPost = await server.inject({
      method: 'POST',
      path: '/substrate/v1/subscribe',
      body: Buffer.from(JSON.stringify(FRAME))
    });
    expect(unauthenticatedPost.status).toBe(401);

    const mint = await server.inject({
      method: 'POST',
      path: '/substrate/v1/stream/ticket',
      headers: { authorization: `Bearer ${bearer(['read'])}` },
      body: Buffer.from(JSON.stringify(FRAME))
    });
    expect(mint.status).toBe(200);
    const { ticket }: { ticket: string } = JSON.parse(String(mint.body));

    const streamed = await server.inject({
      method: 'GET',
      path: `/substrate/v1/subscribe?frame=${encodeURIComponent(JSON.stringify(FRAME))}&ticket=${encodeURIComponent(ticket)}`
    });
    expect(streamed.status).toBe(200);

    // A ticket forged against the published dev constant must NOT be accepted.
    const forged = mintStreamTicket(
      'substrate-dev-insecure-stream-secret',
      {
        identity: { id: 'attacker', grants: {} },
        capabilities: ['read'],
        frameHash: hashFrame(FRAME)
      },
      Date.now()
    );
    const bypass = await server.inject({
      method: 'GET',
      path: `/substrate/v1/subscribe?frame=${encodeURIComponent(JSON.stringify(FRAME))}&ticket=${encodeURIComponent(forged)}`
    });
    expect(bypass.status).toBe(401);

    await composed.stop();
  });

  it('refuses to mint a ticket for a caller without the read capability', async () => {
    const server = new MemorySubstrateServer();
    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      auth: authConfig,
      streamTicketSecret: COMPOSE_SECRET
    });

    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/stream/ticket',
      headers: { authorization: `Bearer ${bearer(['mutate'])}` },
      body: Buffer.from(JSON.stringify(FRAME))
    });

    expect(res.status).toBe(403);
    await composed.stop();
  });
});

/**
 * Graceful shutdown, transport-independent half (the Fastify half needs a
 * real socket and lives in apps/substrate/test/sse-teardown-contract.test.ts):
 * the route registers a shutdown hook, flushes the terminal frame WS clients
 * already get, and deregisters a response that ended on its own so a later
 * shutdown neither writes to it nor re-attributes it.
 */
describe('SSE graceful shutdown', () => {
  const todoNamespace = defineNamespace('default', {
    Todo: {
      fields: { id: field.string(), title: field.string() },
      autoCrud: true
    }
  });
  const todoPlugin: CoordinatorPlugin = {
    name: 'sse-shutdown-fixture',
    contractVersion: '*',
    namespaces: [todoNamespace]
  };

  interface SseEvent {
    event: string;
    data: Record<string, unknown>;
  }

  async function readEvents(body: ReadableStream<Uint8Array>, sink: SseEvent[]): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      let at = buffered.indexOf('\n\n');
      while (at !== -1) {
        const block = buffered.slice(0, at);
        buffered = buffered.slice(at + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (event !== undefined && data !== undefined) {
          sink.push({ event, data: JSON.parse(data) as Record<string, unknown> });
        }
        at = buffered.indexOf('\n\n');
      }
    }
  }

  /**
   * Returns the body UNREAD — reading locks the stream, and one of these tests
   * needs to cancel it instead.
   */
  async function openSubscribe(server: MemorySubstrateServer): Promise<ReadableStream<Uint8Array>> {
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/subscribe',
      body: Buffer.from(JSON.stringify(FRAME))
    });
    expect(res.status).toBe(200);
    // `inject()` hands the handler's response back untouched, so the body is
    // the transport's live ReadableStream — no socket needed.
    return res.body as ReadableStream<Uint8Array>;
  }

  it('flushes end{reason} and ends the response when the server stops', async () => {
    const server = new MemorySubstrateServer();
    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      coordinators: [todoPlugin]
    });
    const events: SseEvent[] = [];
    const drained = readEvents(await openSubscribe(server), events);

    await composed.stop();
    await drained;

    // Same terminal-cause token the WS route emits — one vocabulary, both
    // transports.
    expect(events.at(-1)).toEqual({ event: 'end', data: { reason: 'server_restart' } });
    expect(composed.stats.snapshot().events.engine_subscription_closed_shutdown ?? 0).toBe(1);
    expect(composed.engine.activeSubscriptionCount()).toBe(0);
  });

  it('refuses to open a new stream once the shutdown notice has fired', async () => {
    const server = new MemorySubstrateServer();
    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      coordinators: [todoPlugin]
    });

    await composed.stop();

    // A request that lands after the notice would be in no registry, so
    // nothing would ever tell its stream to end — and the drain would wait on
    // it forever. Refuse it pre-stream, where an HTTP status still works.
    const res = await server.inject({
      method: 'POST',
      path: '/substrate/v1/subscribe',
      body: Buffer.from(JSON.stringify(FRAME))
    });
    expect(res.status).toBe(503);
    expect(String(res.body)).toContain('server_shutting_down');
  });

  it('leaves a client-disconnected response alone at shutdown', async () => {
    const server = new MemorySubstrateServer();
    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      coordinators: [todoPlugin]
    });
    const body = await openSubscribe(server);

    // Cancelling the consumer IS the disconnect for SSE.
    await body.cancel();
    await composed.stop();

    // Deregistered on disconnect, so the shutdown walk never saw it: the
    // teardown stays attributed to the disconnect rather than being
    // re-attributed — and, had the registry leaked, the walk would have
    // written a frame into a response that was already gone.
    const events = composed.stats.snapshot().events;
    expect(events.engine_subscription_closed_socket_close ?? 0).toBe(1);
    expect(events.engine_subscription_closed_shutdown ?? 0).toBe(0);
  });
});
