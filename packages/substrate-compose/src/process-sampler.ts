import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { ProcessStat } from '@mnmal-ai/substrate-types';

const MB = 1024 * 1024;

export interface ProcessSamplerOpts {
  /** How often the background tick refreshes the cached sample. Default 5000. */
  intervalMs?: number;
}

/**
 * Samples on its own unref'd timer so that readers of `/substrate/v1/metrics` can
 * neither reset the event-loop histogram nor trigger work: `sample()` returns
 * the cached last reading.
 */
export function createProcessSampler(opts: ProcessSamplerOpts = {}): {
  sample(): Omit<ProcessStat, 'inFlight'>;
  stop(): void;
} {
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const take = (): Omit<ProcessStat, 'inFlight'> => {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const lagP99Ms = Number.isFinite(loop.percentile(99)) ? loop.percentile(99) / 1e6 : 0;
    loop.reset();
    return {
      rssMB: Math.round(mem.rss / MB),
      heapUsedMB: Math.round(mem.heapUsed / MB),
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSystemMs: Math.round(cpu.system / 1000),
      eventLoopLagP99Ms: Math.round(lagP99Ms * 100) / 100
    };
  };
  let last = take();
  const timer = setInterval(() => {
    last = take();
  }, opts.intervalMs ?? 5000);
  timer.unref();
  return {
    sample() {
      return last;
    },
    stop() {
      clearInterval(timer);
      loop.disable();
    }
  };
}
