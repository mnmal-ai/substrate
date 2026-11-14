import http2 from 'node:http2';
import { describe, expect, it } from 'vitest';
import { createH2Fetch } from '../../substrate-client/src/transport/h2-fetch.js';
import { FastifySubstrateServer } from '../src/index.js';

// The server speaks HTTP/2 only; the platform fetch speaks HTTP/1.1.
const h2fetch = createH2Fetch();

/**
 * Resolves once `signal` aborts: the server's req.raw 'close' lands after an
 * unbounded number of loop turns, so a fixed sleep flakes under load. A signal
 * that never aborts fails on the test timeout.
 */
const aborted = (signal: AbortSignal | undefined): Promise<void> =>
  signal === undefined || signal.aborted
    ? Promise.resolve()
    : new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));

describe('FastifySubstrateServer abort fan-out', () => {
  it('attaches a per-request signal and aborts it on client disconnect', async () => {
    const server = new FastifySubstrateServer();
    const handlerEntered = new Promise<AbortSignal | undefined>((resolveEntered) => {
      server.route('GET', '/long', async (req) => {
        resolveEntered(req.signal);
        await new Promise<void>((resolve) => {
          if (req.signal === undefined) {
            resolve();
            return;
          }
          req.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { status: 200, body: 'late' };
      });
    });

    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    try {
      // A raw session, so the test can drop the connection itself.
      const session = http2.connect(`http://127.0.0.1:${port}`);
      session.on('error', () => {});
      const clientReq = session.request({ ':path': '/long' });
      clientReq.on('error', () => {});
      clientReq.end();
      const observedSignal = await handlerEntered;
      expect(observedSignal).toBeDefined();
      session.destroy();
      await aborted(observedSignal);
      expect(observedSignal?.aborted).toBe(true);
      expect(observedSignal?.reason).toBe('client_disconnect');
    } finally {
      await server.stop();
    }
  });

  it('abortAllRequests fires every in-flight signal with the supplied reason', async () => {
    const server = new FastifySubstrateServer();
    const reasons: Array<unknown> = [];
    // abortAllRequests only aborts AbortControllers currently in the inFlight
    // set, and a controller is added to that set inside the route handler.
    // Under parallel test load a fetch may not have reached the handler when
    // we'd otherwise call abortAllRequests, so its controller is created
    // *after* the snapshot — never aborted, never resolved, the handler hangs
    // forever. Pre-allocate one deferred per expected request and only
    // proceed once every handler has signalled entry.
    const requestCount = 3;
    const enteredResolvers: Array<() => void> = [];
    const enteredPromises = Array.from(
      { length: requestCount },
      () => new Promise<void>((r) => enteredResolvers.push(r))
    );
    server.route('GET', '/wait/:id', async (req) => {
      enteredResolvers.shift()?.();
      return new Promise<{ status: number; body: string }>((resolve) => {
        if (req.signal === undefined) {
          resolve({ status: 200, body: 'no signal' });
          return;
        }
        req.signal.addEventListener(
          'abort',
          () => {
            reasons.push(req.signal?.reason);
            resolve({ status: 499, body: 'aborted' });
          },
          { once: true }
        );
      });
    });

    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    try {
      const requests = Array.from({ length: requestCount }, (_, i) =>
        h2fetch(`http://127.0.0.1:${port}/wait/${i + 1}`).then((r) => r.text())
      );
      await Promise.all(enteredPromises);
      server.abortAllRequests('test_shutdown');
      const results = await Promise.all(requests);
      expect(results).toEqual(['aborted', 'aborted', 'aborted']);
      expect(reasons).toHaveLength(3);
      expect(new Set(reasons)).toEqual(new Set(['test_shutdown']));
    } finally {
      await server.stop();
    }
  });

  it('stop({ abortInFlight: true }) aborts in-flight requests before draining', async () => {
    const server = new FastifySubstrateServer();
    let aborted = false;
    let resolveEntered!: () => void;
    const entered = new Promise<void>((r) => {
      resolveEntered = r;
    });
    server.route('GET', '/wait', async (req) => {
      resolveEntered();
      return new Promise<{ status: number; body: string }>((resolve) => {
        if (req.signal === undefined) {
          resolve({ status: 200, body: 'ok' });
          return;
        }
        req.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve({ status: 503, body: 'shutdown' });
          },
          { once: true }
        );
      });
    });

    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    const fetchPromise = h2fetch(`http://127.0.0.1:${port}/wait`).then((r) => r.text());
    await entered;

    const start = Date.now();
    await server.stop({ grace: 1000, abortInFlight: true });
    const elapsed = Date.now() - start;

    // Resolver bailed cooperatively, so stop() should resolve well under grace.
    expect(elapsed).toBeLessThan(900);
    expect(aborted).toBe(true);
    // The body is buffered so the response still lands, even though the
    // client request comes in a degraded state. We don't assert the body —
    // what matters is that the resolver was told to bail.
    await fetchPromise.catch(() => null);
  });

  it('stop() without abortInFlight waits for natural drain (no signal fan-out)', async () => {
    const server = new FastifySubstrateServer();
    let aborted = false;
    let resolveEntered!: () => void;
    const entered = new Promise<void>((r) => {
      resolveEntered = r;
    });
    server.route('GET', '/quick', async (req) => {
      resolveEntered();
      req.signal?.addEventListener(
        'abort',
        () => {
          aborted = true;
        },
        { once: true }
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { status: 200, body: 'done' };
    });

    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    const fetchPromise = h2fetch(`http://127.0.0.1:${port}/quick`).then((r) => r.text());
    await entered;
    await server.stop({ grace: 200 });
    await fetchPromise;
    expect(aborted).toBe(false);
  });

  it('does NOT abort a POST-with-body request when the handler yields before reading the signal', async () => {
    // Regression: a POST body is fully consumed by the body parser before the
    // handler runs, so the request stream ends — which a req.raw 'close'
    // binding misreads as 'client_disconnect'. After an async hop such as
    // `await verifyBearerToken(...)`, that would abort a live request. The
    // connection is still open, so the signal MUST NOT be aborted here.
    const server = new FastifySubstrateServer();
    server.route('POST', '/deferred', async (req) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          aborted: req.signal?.aborted === true,
          reason: String(req.signal?.reason ?? '')
        })
      };
    });

    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    try {
      const res = await h2fetch(`http://127.0.0.1:${port}/deferred`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hello: 'world' })
      });
      const payload = (await res.json()) as { aborted: boolean; reason: string };
      expect(payload.aborted).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it('still aborts a POST request when the client disconnects mid-flight', async () => {
    // Guard against over-correcting the fix above: real client disconnects on
    // a POST (response not yet sent) must still abort the in-flight signal.
    const server = new FastifySubstrateServer();
    const handlerEntered = new Promise<AbortSignal | undefined>((resolveEntered) => {
      server.route('POST', '/long-post', async (req) => {
        resolveEntered(req.signal);
        await new Promise<void>((resolve) => {
          if (req.signal === undefined) {
            resolve();
            return;
          }
          req.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { status: 200, body: 'late' };
      });
    });

    const { port } = await server.start({ host: '127.0.0.1', port: 0 });
    try {
      const session = http2.connect(`http://127.0.0.1:${port}`);
      session.on('error', () => {});
      const clientReq = session.request({
        ':method': 'POST',
        ':path': '/long-post',
        'content-type': 'application/json'
      });
      clientReq.on('error', () => {});
      clientReq.end(JSON.stringify({ hello: 'world' }));
      const observedSignal = await handlerEntered;
      expect(observedSignal).toBeDefined();
      session.destroy();
      await aborted(observedSignal);
      expect(observedSignal?.aborted).toBe(true);
      expect(observedSignal?.reason).toBe('client_disconnect');
    } finally {
      await server.stop();
    }
  });
});
