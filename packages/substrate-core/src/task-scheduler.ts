/**
 * TaskScheduler. Spec: §5.11 (scheduled tasks on coordinator plugins).
 *
 * Runs every plugin's `ScheduledTask`s on one shared set of `.unref()`-d
 * intervals. `start()` arms them (idempotent); `stop()` clears them and awaits
 * in-flight handlers.
 *
 * - `register()` throws `RangeError` when `intervalMs < 100`.
 * - A handler throw emits `scheduled_task_error`; the interval continues.
 * - A tick that lands while the previous run is still going is skipped with
 *   `scheduled_task_overlapped`, not queued. `runOnStart` and `runNow()` go
 *   through the same guard.
 */

import type { EngineHandle, ScheduledTask } from '@mnmal-ai/substrate-types';

export type SchedulerMetricFn = (name: string, payload?: unknown) => void;

export interface TaskSchedulerOptions {
  engine: EngineHandle;
  metric?: SchedulerMetricFn;
}

const MIN_INTERVAL_MS = 100;

interface RegisteredTask {
  pluginName: string;
  task: ScheduledTask;
  timer: NodeJS.Timeout | null;
  running: Promise<void> | null;
}

export class TaskScheduler {
  readonly #engine: EngineHandle;
  readonly #metric: SchedulerMetricFn;
  readonly #tasks: RegisteredTask[] = [];
  #started = false;

  constructor(opts: TaskSchedulerOptions) {
    this.#engine = opts.engine;
    this.#metric = opts.metric ?? ((): void => undefined);
  }

  register(pluginName: string, tasks: ScheduledTask[]): void {
    for (const task of tasks) {
      if (task.intervalMs < MIN_INTERVAL_MS) {
        throw new RangeError(
          `TaskScheduler: task '${pluginName}/${task.name}' intervalMs=${task.intervalMs} is below minimum ${MIN_INTERVAL_MS}`
        );
      }
      this.#tasks.push({ pluginName, task, timer: null, running: null });
    }
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    for (const entry of this.#tasks) {
      if (entry.task.runOnStart === true) {
        // Fire-and-forget — the invocation path tracks completion on the
        // entry, so a subsequent interval tick that lands while this is
        // still running hits the reentrancy guard.
        void this.#invoke(entry);
      }
      entry.timer = setInterval(() => {
        void this.#invoke(entry);
      }, entry.task.intervalMs);
      entry.timer.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    const inFlight: Array<Promise<void>> = [];
    for (const entry of this.#tasks) {
      if (entry.timer !== null) {
        clearInterval(entry.timer);
        entry.timer = null;
      }
      if (entry.running !== null) {
        inFlight.push(entry.running);
      }
    }
    await Promise.all(inFlight);
  }

  /**
   * Invoke `pluginName/taskName` once. Intended for tests that advance the
   * scheduler without waiting on wall-clock timers. Participates in the
   * reentrancy guard — a parallel `runNow()` while a previous invocation is
   * still running emits `scheduled_task_overlapped` and resolves without
   * firing the handler again.
   */
  async runNow(pluginName: string, taskName: string): Promise<void> {
    const entry = this.#tasks.find((e) => e.pluginName === pluginName && e.task.name === taskName);
    if (entry === undefined) {
      throw new Error(`TaskScheduler: no task registered as '${pluginName}/${taskName}'`);
    }
    await this.#invoke(entry);
  }

  async #invoke(entry: RegisteredTask): Promise<void> {
    if (entry.running !== null) {
      this.#metric('scheduled_task_overlapped', {
        pluginName: entry.pluginName,
        taskName: entry.task.name
      });
      return;
    }
    const run = (async (): Promise<void> => {
      try {
        await entry.task.handler({
          pluginName: entry.pluginName,
          engine: this.#engine,
          metric: this.#metric
        });
      } catch (err) {
        this.#metric('scheduled_task_error', {
          pluginName: entry.pluginName,
          taskName: entry.task.name,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    })();
    entry.running = run;
    try {
      await run;
    } finally {
      entry.running = null;
    }
  }
}
