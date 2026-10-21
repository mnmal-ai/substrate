import { describe, expect, it } from 'vitest';
import { AlreadyStartedError, MemorySubstrateServer } from '../src/index.js';

describe('MemorySubstrateServer lifecycle', () => {
  it('start() returns memory:// and port 0', async () => {
    const server = new MemorySubstrateServer();
    const info = await server.start();
    expect(info).toEqual({ address: 'memory://', port: 0 });
  });

  it('throws on a second start() without an intervening stop()', async () => {
    const server = new MemorySubstrateServer();
    await server.start();
    await expect(server.start()).rejects.toBeInstanceOf(AlreadyStartedError);
  });

  it('stop() allows a subsequent start()', async () => {
    const server = new MemorySubstrateServer();
    await server.start();
    await server.stop();
    const info = await server.start();
    expect(info.address).toBe('memory://');
  });

  it('inject() works before start() (no ceremony required)', async () => {
    const server = new MemorySubstrateServer();
    server.route('GET', '/ping', () => ({ status: 200, body: 'ok' }));
    const res = await server.inject({ method: 'GET', path: '/ping' });
    expect(res.status).toBe(200);
    expect(res.body).toBe('ok');
  });

  it('stop({grace}) waits up to grace ms for in-flight injects then returns', async () => {
    const server = new MemorySubstrateServer();
    let release: (() => void) | undefined;
    server.route('GET', '/slow', async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: 200, body: 'done' };
    });
    const inflight = server.inject({ method: 'GET', path: '/slow' });
    // Give the inject a tick to increment the pending counter before we stop.
    await new Promise((r) => setImmediate(r));
    const start = Date.now();
    const stopP = server.stop({ grace: 50 });
    await stopP;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(500);
    release?.();
    await inflight;
  });

  it('stop({grace}) returns immediately when nothing is in flight', async () => {
    const server = new MemorySubstrateServer();
    const start = Date.now();
    await server.stop({ grace: 5000 });
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('attaches a per-inject signal that abortAllRequests fires on demand', async () => {
    const server = new MemorySubstrateServer();
    let observedSignal: AbortSignal | undefined;
    server.route('GET', '/wait', async (req) => {
      observedSignal = req.signal;
      await new Promise<void>((resolve) => {
        req.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { status: 503, body: 'bailed' };
    });
    const inflight = server.inject({ method: 'GET', path: '/wait' });
    await new Promise((r) => setImmediate(r));
    server.abortAllRequests('test_shutdown');
    const res = await inflight;
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBe('test_shutdown');
    expect(res.status).toBe(503);
  });

  it('inject() with caller-supplied signal threads it through without minting a new one', async () => {
    const server = new MemorySubstrateServer();
    const ctrl = new AbortController();
    let observedSignal: AbortSignal | undefined;
    server.route('GET', '/echo-signal', (req) => {
      observedSignal = req.signal;
      return { status: 200, body: 'ok' };
    });
    await server.inject({ method: 'GET', path: '/echo-signal', signal: ctrl.signal });
    expect(observedSignal).toBe(ctrl.signal);
  });

  it('stop({abortInFlight}) aborts in-flight injects before draining', async () => {
    const server = new MemorySubstrateServer();
    let bailedReason: unknown;
    server.route('GET', '/wait', async (req) => {
      await new Promise<void>((resolve) => {
        req.signal?.addEventListener(
          'abort',
          () => {
            bailedReason = req.signal?.reason;
            resolve();
          },
          { once: true }
        );
      });
      return { status: 503, body: 'bailed' };
    });
    const inflight = server.inject({ method: 'GET', path: '/wait' });
    await new Promise((r) => setImmediate(r));
    const start = Date.now();
    await server.stop({ grace: 1000, abortInFlight: true });
    expect(Date.now() - start).toBeLessThan(900);
    expect(bailedReason).toBe('server_shutdown');
    await inflight;
  });
});
