import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClusterWorkerRequest } from '../src/run-clusterer.js';

/**
 * `spawn-cluster-worker.ts`'s whole job is `worker_threads` lifecycle
 * bookkeeping — single-settle, always-terminate, message/error/exit
 * routing. Faking `node:worker_threads` doesn't test the fake; it drives
 * those four paths through the real module's logic and asserts what that
 * logic does with them.
 *
 * `vi.hoisted` because `vi.mock`'s factory runs when `node:worker_threads`
 * is first imported — while this file's own top-level imports are still
 * resolving, before a later `class` statement in this file would
 * otherwise have run.
 */
const { FakeWorker, instances, setNextPostMessageThrow } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  const instances: InstanceType<typeof FakeWorker>[] = [];
  let nextPostMessageThrow: Error | null = null;

  class FakeWorker {
    url: string;
    terminateCalls = 0;
    private listeners: Record<string, Listener[]> = {};

    constructor(url: URL | string) {
      this.url = String(url);
      instances.push(this);
    }

    on(event: string, cb: Listener): this {
      if (this.listeners[event] === undefined) this.listeners[event] = [];
      this.listeners[event].push(cb);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const cb of this.listeners[event] ?? []) cb(...args);
    }

    postMessage(_data: unknown, _transferList?: unknown[]): void {
      if (nextPostMessageThrow) {
        const err = nextPostMessageThrow;
        nextPostMessageThrow = null;
        throw err;
      }
    }

    terminate(): Promise<number> {
      this.terminateCalls++;
      return Promise.resolve(0);
    }
  }

  return {
    FakeWorker,
    instances,
    setNextPostMessageThrow: (err: Error | null) => {
      nextPostMessageThrow = err;
    }
  };
});

vi.mock('node:worker_threads', () => ({ Worker: FakeWorker }));

const { spawnClusterWorker, createSpawnClusterWorker } = await import(
  '../src/spawn-cluster-worker.js'
);
const { createCrystalliseGuard } = await import('../src/crystallise-guard.js');
const { runClusterer } = await import('../src/run-clusterer.js');

function payload(): ClusterWorkerRequest {
  const flat = new Float32Array([1, 2, 3, 4]);
  return {
    flat,
    rows: 2,
    dims: 2,
    params: { nComponents: 0, nNeighbors: 15, minClusterSize: 5, seed: 42 }
  };
}

function lastInstance(): InstanceType<typeof FakeWorker> {
  const worker = instances.at(-1);
  if (worker === undefined) throw new Error('no FakeWorker was constructed');
  return worker;
}

beforeEach(() => {
  instances.length = 0;
  setNextPostMessageThrow(null);
});

describe('spawnClusterWorker', () => {
  it('resolves with the assignments from a successful reply and terminates the worker', async () => {
    const pending = spawnClusterWorker(payload());
    const assignments = new Int32Array([0, 1]);
    lastInstance().emit('message', { ok: true, assignments });

    await expect(pending).resolves.toEqual(assignments);
    expect(lastInstance().terminateCalls).toBe(1);
  });

  it('rejects with the worker message on an { ok: false } reply, not a generic one', async () => {
    const pending = spawnClusterWorker(payload());
    lastInstance().emit('message', { ok: false, message: 'clusterer blew up: bad seed' });

    await expect(pending).rejects.toThrow('clusterer blew up: bad seed');
    expect(lastInstance().terminateCalls).toBe(1);
  });

  it('rejects and terminates on a worker error event', async () => {
    const pending = spawnClusterWorker(payload());
    const boom = new Error('worker crashed');
    lastInstance().emit('error', boom);

    await expect(pending).rejects.toThrow('worker crashed');
    expect(lastInstance().terminateCalls).toBe(1);
  });

  it('rejects naming the exit code on an early exit, and ignores a stray later message', async () => {
    const pending = spawnClusterWorker(payload());
    const worker = lastInstance();
    worker.emit('exit', 17);

    await expect(pending).rejects.toThrow(/exited with code 17 before replying/);
    expect(worker.terminateCalls).toBe(1);

    // A message that arrives after the promise already settled must not
    // re-settle it or call terminate() a second time — the single-settle
    // guard (`settled`) is exactly what this asserts.
    worker.emit('message', { ok: true, assignments: new Int32Array([0]) });
    expect(worker.terminateCalls).toBe(1);
  });

  // A worker that fires none of message/error/exit would leave the promise —
  // and so `CrystalliseGuard.runExclusive` — pending forever, wedging
  // crystallisation. `createSpawnClusterWorker`'s wall-clock ceiling must fire,
  // terminate the worker, and reject rather than hang.
  it('rejects and terminates a worker that never replies, once the timeout elapses', async () => {
    const spawn = createSpawnClusterWorker({ timeoutMs: 20 });
    const pending = spawn(payload());
    // Deliberately no `emit(...)` — this worker never replies.
    await expect(pending).rejects.toThrow(/exceeded 20ms/);
    expect(lastInstance().terminateCalls).toBe(1);
  });

  it('a timed-out worker releases a shared CrystalliseGuard for the next pass', async () => {
    const guard = createCrystalliseGuard();
    const spawn = createSpawnClusterWorker({ timeoutMs: 20 });
    const vectors = [new Float32Array([1, 0]), new Float32Array([0, 1])];
    const params = { nComponents: 0, nNeighbors: 15, minClusterSize: 5, seed: 42 };

    // The wedge scenario end to end: a hung worker, reached through the same
    // `runClusterer` seam `crystallise-core` uses, wrapped in the same guard
    // both transports share. Without the
    // timeout this `runExclusive` call never settles and the second one below
    // would 409 forever.
    await expect(
      guard.runExclusive(() => runClusterer(vectors, params, { spawn }))
    ).rejects.toThrow(/without replying/);

    await expect(guard.runExclusive(async () => 'released')).resolves.toBe('released');
  });

  it('rejects and terminates when postMessage throws synchronously', async () => {
    // Regression: a synchronous throw from postMessage (e.g. a clone/transfer
    // failure) must terminate the worker, not just reject. The rejection
    // happens either way, so `terminateCalls` is the discriminating assertion.
    setNextPostMessageThrow(new Error('DataCloneError: could not transfer'));
    const pending = spawnClusterWorker(payload());

    await expect(pending).rejects.toThrow('DataCloneError: could not transfer');
    expect(lastInstance().terminateCalls).toBe(1);
  });
});
