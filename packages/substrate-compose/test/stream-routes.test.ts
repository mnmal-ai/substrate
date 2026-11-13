import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { decodeStreamFrames, FRAMES_JSON_MIME } from '@mnmal-ai/substrate-pack';
import { defineNamespace, field } from '@mnmal-ai/substrate-sdk';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import type {
  CoordinatorPlugin,
  HttpHandler,
  RequestContext,
  SubstrateRequest,
  SubstrateResponse,
  WsResponseFrame
} from '@mnmal-ai/substrate-types';
import { describe, expect, it, vi } from 'vitest';
import { type AuthConfig, signHs256 } from '../src/auth.js';
import { compose } from '../src/compose.js';
import { createConnectionLimiter } from '../src/routes/connection-limit.js';
import { type RouteGate, registerStreamRoutes } from '../src/routes/stream-routes.js';
import { StreamSession } from '../src/routes/stream-session.js';

const FRAME = { 'default/Todo': { fields: { id: true } } };

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
  registerStreamRoutes(server, engine, new Set<string>(), gate, () => {});
  return server;
}

/** POST a frame body to a stream route, asking for frames+json unless told otherwise. */
function open(
  server: MemorySubstrateServer,
  path = '/substrate/v1/subscribe',
  init: { body?: string; headers?: Record<string, string>; peerIp?: string } = {}
): Promise<SubstrateResponse> {
  return server.inject({
    method: 'POST',
    path,
    headers: { accept: FRAMES_JSON_MIME, ...init.headers },
    body: Buffer.from(init.body ?? JSON.stringify(FRAME)),
    ...(init.peerIp !== undefined ? { peerIp: init.peerIp } : {})
  });
}

/** The frames+json frames of a body, decoded one at a time. */
async function* framesOf(body: unknown): AsyncGenerator<WsResponseFrame> {
  if (!(body instanceof ReadableStream)) throw new Error('expected a ReadableStream body');
  for await (const payload of decodeStreamFrames(body as ReadableStream<Uint8Array>)) {
    yield JSON.parse(new TextDecoder().decode(payload)) as WsResponseFrame;
  }
}

async function next(frames: AsyncGenerator<WsResponseFrame>): Promise<WsResponseFrame> {
  const { value, done } = await frames.next();
  if (done === true) throw new Error('stream ended early');
  return value;
}

describe('stream routes', () => {
  it('POST /substrate/v1/subscribe opens a frames stream', async () => {
    const { engine, fire } = fakeEngine();
    const server = serverWith(engine);

    const res = await open(server);

    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toBe(FRAMES_JSON_MIME);
    const frames = framesOf(res.body);
    // Fire without awaiting: a data frame parks on consumer demand, so the read below unblocks it.
    const pending = fire({ id: 'x', kind: 'snapshot', data: { 'default/Todo': [] }, shapes: {} });
    expect(await next(frames)).toMatchObject({ kind: 'snapshot', data: { 'default/Todo': [] } });
    await pending;
    await frames.return(undefined);
  });

  it('text/event-stream accept is refused 406 naming the frames media types', async () => {
    const { engine, contexts } = fakeEngine();
    const server = serverWith(engine);

    const res = await open(server, '/substrate/v1/stream', {
      headers: { accept: 'text/event-stream' }
    });

    expect(res.status).toBe(406);
    expect(res.body instanceof ReadableStream).toBe(false);
    const { errors } = JSON.parse(String(res.body)) as {
      errors: Array<{ code: string; message: string }>;
    };
    expect(errors[0]?.code).toBe('not_acceptable');
    expect(errors[0]?.message).toContain('application/vnd.substrate.frames+json');
    expect(errors[0]?.message).toContain('application/vnd.substrate.frames+pack');
    expect(contexts).toEqual([]);
  });

  it('GET /substrate/v1/subscribe is no longer a route', async () => {
    const { engine, contexts } = fakeEngine();
    const server = serverWith(engine);

    const res = await server.inject({
      method: 'GET',
      path: `/substrate/v1/subscribe?frame=${encodeURIComponent(JSON.stringify(FRAME))}`,
      headers: { accept: FRAMES_JSON_MIME }
    });

    expect(res.status).toBe(404);
    expect(contexts).toEqual([]);
  });

  it.each([
    ['a malformed body', 'not-json'],
    ['a non-object body', '[1,2]'],
    // `StreamSession` reads `entry.fields` off every value, so a null entry
    // would throw AFTER the transport (and its heartbeat timer) was created.
    ['a null frame entry', '{"default/Todo":null}'],
    // Streams cannot carry the batched-mutate shape; refuse it pre-stream.
    ['a batched array frame entry', '{"default/Todo":[{"params":{}}]}']
  ])('rejects %s with 400 invalid_frame and no stream', async (_label, body) => {
    const { engine, contexts } = fakeEngine();
    const server = serverWith(engine);

    const res = await open(server, '/substrate/v1/stream', { body });

    expect(res.status).toBe(400);
    expect(res.body instanceof ReadableStream).toBe(false);
    expect(String(res.body)).toContain('invalid_frame');
    expect(contexts).toEqual([]);
  });

  it('cancels the session when the client disconnects mid-stream', async () => {
    const { engine, cancels } = fakeEngine();
    const server = serverWith(engine);

    const res = await open(server);
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

    const res = await open(server);
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

    const res = await open(server);

    const got: WsResponseFrame[] = [];
    // Completes only because the body closes.
    for await (const f of framesOf(res.body)) got.push(f);
    expect(got.map((f) => f.kind)).toEqual(['error']);
  });

  it('keeps the response open when only SOME subscribe keys fail registration', async () => {
    // A multi-key subscribe continues past a failing key and still holds a
    // live handle for the rest — closing on the first `error` would kill a
    // partially-successful subscription.
    const multi = { 'default/Todo': { fields: { id: true } }, 'default/Nope': {} };
    const { engine, fire, cancels } = fakeEngine({ failKeys: ['default/Nope'] });
    const server = serverWith(engine);

    const res = await open(server, '/substrate/v1/subscribe', { body: JSON.stringify(multi) });
    const frames = framesOf(res.body);
    expect(await next(frames)).toMatchObject({ kind: 'error' });

    // Two live frames in a row: a closed session would drop them and end the body.
    for (const id of ['1', '2']) {
      const pending = fire({ id: 'x', kind: 'add', data: { 'default/Todo': { id } }, shapes: {} });
      expect(await next(frames)).toMatchObject({ kind: 'add', data: { 'default/Todo': { id } } });
      await pending;
    }
    expect(cancels).toEqual([]);
    await frames.return(undefined);
  });

  it('frees its session slot when the session cannot be created', async () => {
    const { engine } = fakeEngine();
    const server = new MemorySubstrateServer();
    const metrics: string[] = [];
    registerStreamRoutes(
      server,
      engine,
      new Set<string>(),
      passThroughGate,
      (name) => metrics.push(name),
      undefined,
      createConnectionLimiter(1)
    );
    const spy = vi.spyOn(StreamSession, 'create').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect((await open(server, undefined, { peerIp: '203.0.113.7' })).status).toBe(500);
    spy.mockRestore();
    expect(metrics).toEqual(['stream_start_failed']);
    expect((await open(server, undefined, { peerIp: '203.0.113.7' })).status).toBe(200);
  });

  it('answers a dispatch that THROWS with a clean 500 and no leaked heartbeat', async () => {
    // Defensive: `evaluatePolicy` catches a throwing policy, but any rejection
    // out of `session.start` arrives after the transport is live — heartbeat
    // armed. An unguarded `await` would leak it, once per request.
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

      const res = await open(server);

      expect(res.status).toBe(500);
      expect(res.body instanceof ReadableStream).toBe(false);
      expect(String(res.body)).toContain('stream_start_failed');
      // Internal error text must not reach the wire.
      expect(String(res.body)).not.toContain('TypeError');
      expect(String(res.body)).not.toContain('capabilities');
      // The heartbeat interval is the only timer this route arms.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a POST body forge an identity — gate owns that', async () => {
    const { engine, contexts } = fakeEngine();
    const server = serverWith(engine, bearerGate);

    await open(server, '/substrate/v1/subscribe', {
      headers: { authorization: 'Bearer whatever' },
      body: JSON.stringify({ ...FRAME, identity: { id: 'forged', grants: { '*': ['admin'] } } })
    });

    // `bearerGate` stamps a verified-shaped identity; nothing from the body reaches ctx.
    expect(contexts[0]?.identity).toEqual({ id: 'a', grants: { default: ['read'] } });
  });
});

const HS_SECRET = 'stream-compose-test-secret';
const HS_KID = 'stream-compose';
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

describe('stream routes through compose (real withAuth)', () => {
  it('gates POST on the real bearer', async () => {
    const server = new MemorySubstrateServer();
    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      auth: authConfig
    });

    expect((await open(server)).status).toBe(401);

    const authed = await open(server, '/substrate/v1/subscribe', {
      headers: { authorization: `Bearer ${bearer(['read'])}` }
    });
    expect(authed.status).toBe(200);
    await (authed.body as ReadableStream<Uint8Array>).cancel();

    await composed.stop();
  });
});

/**
 * Graceful shutdown, transport-independent half: the route registers a
 * shutdown hook, flushes the terminal frame, and deregisters a response that
 * ended on its own so a later shutdown neither writes to it nor re-attributes it.
 */
describe('stream graceful shutdown', () => {
  const todoPlugin: CoordinatorPlugin = {
    name: 'stream-shutdown-fixture',
    contractVersion: '*',
    namespaces: [
      defineNamespace('default', {
        Todo: { fields: { id: field.string(), title: field.string() }, autoCrud: true }
      })
    ]
  };

  async function composeTodos() {
    const server = new MemorySubstrateServer();
    const composed = await compose({
      // Auth is off in this harness, so the deployment declares who it writes as.
      systemActor: 'test',
      server,
      dataset: new MemoryDataset({ namespace: 'default' }),
      coordinators: [todoPlugin]
    });
    return { server, composed };
  }

  it('flushes end{reason} and ends the response when the server stops', async () => {
    const { server, composed } = await composeTodos();
    const res = await open(server);
    expect(res.status).toBe(200);
    const got: WsResponseFrame[] = [];
    const drained = (async () => {
      for await (const f of framesOf(res.body)) got.push(f);
    })();

    await composed.stop();
    await drained;

    // Same terminal-cause token every transport uses.
    expect(got.at(-1)).toMatchObject({ kind: 'end', reason: 'server_restart', final: true });
    expect(composed.stats.snapshot().events.engine_subscription_closed_shutdown ?? 0).toBe(1);
    expect(composed.engine.activeSubscriptionCount()).toBe(0);
  });

  it('refuses to open a new stream once the shutdown notice has fired', async () => {
    const { server, composed } = await composeTodos();

    await composed.stop();

    // A request that lands after the notice would be in no registry, so
    // nothing would ever tell its stream to end — and the drain would wait on
    // it forever. Refuse it pre-stream, where an HTTP status still works.
    const res = await open(server);
    expect(res.status).toBe(503);
    expect(String(res.body)).toContain('server_shutting_down');
  });

  it('leaves a client-disconnected response alone at shutdown', async () => {
    const { server, composed } = await composeTodos();
    const res = await open(server);
    expect(res.status).toBe(200);

    // Cancelling the consumer IS the disconnect.
    await (res.body as ReadableStream<Uint8Array>).cancel();
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
