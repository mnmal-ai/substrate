import type {
  Dataset,
  EngineHandle,
  EngineInput,
  NamespaceConfig,
  PackEnvelope,
  Registry
} from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { TaskScheduler } from '../src/task-scheduler.js';

function stubEngine(): EngineHandle {
  const empty = async (_input: EngineInput): Promise<PackEnvelope> => ({
    schemaVersion: 'test',
    data: {},
    shapes: {}
  });
  return {
    query: empty,
    mutate: empty,
    invalidateSchemaCaches: (): void => {},
    addNamespace: (_ns: string, _config: NamespaceConfig): void => {
      throw new Error('test fake: addNamespace not supported');
    },
    tombstoneNamespace: (_ns: string): void => {},
    removeNamespace: () => {},
    namespaceState: () => 'absent' as const,
    onNamespaceTombstoned: () => () => {},
    addDropParticipant: () => () => {},
    dropParticipants: () => [],
    evaluateReadPolicy: () => ({ allow: true }),
    createRegistry: (): Registry => {
      throw new Error('test fake: createRegistry not supported');
    },
    datasetFor: (_ns: string): Dataset | undefined => undefined
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('TaskScheduler', () => {
  it('throws on intervalMs < 100 at register() time', () => {
    const sched = new TaskScheduler({ engine: stubEngine() });
    expect(() =>
      sched.register('p', [
        {
          name: 't',
          intervalMs: 50,
          handler: async (): Promise<void> => {}
        }
      ])
    ).toThrow(RangeError);
  });

  it('runNow fires the handler with plugin context and resolves on completion', async () => {
    const sched = new TaskScheduler({ engine: stubEngine() });
    let seenPlugin: string | null = null;
    sched.register('calendar', [
      {
        name: 'sync',
        intervalMs: 1000,
        handler: async (ctx): Promise<void> => {
          seenPlugin = ctx.pluginName;
        }
      }
    ]);
    await sched.runNow('calendar', 'sync');
    expect(seenPlugin).toBe('calendar');
  });

  it('runNow throws when the task is not registered', async () => {
    const sched = new TaskScheduler({ engine: stubEngine() });
    await expect(sched.runNow('missing', 'task')).rejects.toThrow(/missing\/task/);
  });

  it('start() fires runOnStart: true tasks once immediately', async () => {
    const sched = new TaskScheduler({ engine: stubEngine() });
    const { promise, resolve } = deferred();
    sched.register('p', [
      {
        name: 't',
        intervalMs: 300_000,
        runOnStart: true,
        handler: async (): Promise<void> => {
          resolve();
        }
      }
    ]);
    sched.start();
    await promise;
    await sched.stop();
  });

  it('interval ticks the handler after intervalMs', async () => {
    const sched = new TaskScheduler({ engine: stubEngine() });
    let count = 0;
    sched.register('p', [
      {
        name: 't',
        intervalMs: 100,
        handler: async (): Promise<void> => {
          count++;
        }
      }
    ]);
    sched.start();
    await new Promise((r) => setTimeout(r, 250));
    await sched.stop();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('handler throw → metric emitted with task details, timer continues firing', async () => {
    const metricCalls: Array<{ name: string; payload: unknown }> = [];
    const sched = new TaskScheduler({
      engine: stubEngine(),
      metric: (name, payload): void => {
        metricCalls.push({ name, payload });
      }
    });
    let count = 0;
    sched.register('p', [
      {
        name: 'boom',
        intervalMs: 100,
        handler: async (): Promise<void> => {
          count++;
          throw new Error('nope');
        }
      }
    ]);
    sched.start();
    await new Promise((r) => setTimeout(r, 350));
    await sched.stop();
    expect(count).toBeGreaterThanOrEqual(2);
    const errors = metricCalls.filter((m) => m.name === 'scheduled_task_error');
    expect(errors.length).toBeGreaterThanOrEqual(2);
    const firstErr = errors[0]?.payload as { pluginName: string; taskName: string; error: string };
    expect(firstErr.pluginName).toBe('p');
    expect(firstErr.taskName).toBe('boom');
    expect(firstErr.error).toBe('nope');
  });

  it('reentrancy guard skips overlapping ticks and emits scheduled_task_overlapped', async () => {
    const metricCalls: Array<{ name: string; payload: unknown }> = [];
    const sched = new TaskScheduler({
      engine: stubEngine(),
      metric: (name, payload): void => {
        metricCalls.push({ name, payload });
      }
    });
    const { promise: gate, resolve: openGate } = deferred();
    let starts = 0;
    sched.register('p', [
      {
        name: 'slow',
        intervalMs: 100,
        runOnStart: true,
        handler: async (): Promise<void> => {
          starts++;
          await gate;
        }
      }
    ]);
    sched.start();
    // Wait long enough for the interval to fire a couple of times while
    // the runOnStart invocation is still awaiting `gate`.
    await new Promise((r) => setTimeout(r, 350));
    expect(starts).toBe(1);
    const overlaps = metricCalls.filter((m) => m.name === 'scheduled_task_overlapped');
    expect(overlaps.length).toBeGreaterThanOrEqual(1);
    const first = overlaps[0]?.payload as { pluginName: string; taskName: string };
    expect(first.pluginName).toBe('p');
    expect(first.taskName).toBe('slow');
    openGate();
    await sched.stop();
  });

  it('stop() clears timers + awaits any in-flight handler', async () => {
    const sched = new TaskScheduler({ engine: stubEngine() });
    let finished = false;
    const { promise: gate, resolve: openGate } = deferred();
    sched.register('p', [
      {
        name: 't',
        intervalMs: 100,
        runOnStart: true,
        handler: async (): Promise<void> => {
          await gate;
          finished = true;
        }
      }
    ]);
    sched.start();
    // Let the runOnStart invocation begin.
    await new Promise((r) => setImmediate(r));
    const stopPromise = sched.stop();
    // stop() must await the in-flight handler, so it cannot resolve before
    // we release the gate.
    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(stopped).toBe(false);
    expect(finished).toBe(false);
    openGate();
    await stopPromise;
    expect(finished).toBe(true);
  });

  it('start() is idempotent — second call does not double-register timers', async () => {
    const sched = new TaskScheduler({ engine: stubEngine() });
    let runs = 0;
    sched.register('p', [
      {
        name: 't',
        intervalMs: 100,
        handler: async (): Promise<void> => {
          runs++;
        }
      }
    ]);
    sched.start();
    sched.start();
    await new Promise((r) => setTimeout(r, 250));
    await sched.stop();
    // One-timer-worth of runs: two ticks in 250ms, not four.
    expect(runs).toBeLessThanOrEqual(3);
  });
});
