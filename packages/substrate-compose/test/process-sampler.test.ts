import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compose } from '../src/compose.js';
import { createProcessSampler } from '../src/process-sampler.js';

const disables: Array<ReturnType<typeof vi.fn>> = [];
const resets: Array<ReturnType<typeof vi.fn>> = [];
vi.mock('node:perf_hooks', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:perf_hooks')>();
  return {
    ...real,
    monitorEventLoopDelay: (o?: Parameters<typeof real.monitorEventLoopDelay>[0]) => {
      const h = real.monitorEventLoopDelay(o);
      const d = vi.fn(h.disable.bind(h));
      const r = vi.fn(h.reset.bind(h));
      h.disable = d as unknown as typeof h.disable;
      h.reset = r as unknown as typeof h.reset;
      disables.push(d);
      resets.push(r);
      return h;
    }
  };
});

afterEach(() => {
  vi.useRealTimers();
  disables.length = 0;
  resets.length = 0;
});

describe('createProcessSampler', () => {
  it('returns an immediate initial reading', () => {
    const s = createProcessSampler();
    const v = s.sample();
    expect(v.rssMB).toBeGreaterThan(0);
    expect(Number.isFinite(v.eventLoopLagP99Ms)).toBe(true);
    s.stop();
  });

  it('readers never reset the monitor; only the timer tick does', () => {
    vi.useFakeTimers();
    const s = createProcessSampler({ intervalMs: 1000 });
    const before = resets[0]?.mock.calls.length ?? 0;
    for (let i = 0; i < 50; i++) s.sample();
    expect(resets[0]?.mock.calls.length ?? 0).toBe(before);
    vi.advanceTimersByTime(1000);
    expect(resets[0]?.mock.calls.length ?? 0).toBeGreaterThan(before);
    s.stop();
  });

  it('a tick refreshes the cached sample', () => {
    vi.useFakeTimers();
    const s = createProcessSampler({ intervalMs: 1000 });
    const first = s.sample();
    expect(s.sample()).toBe(first);
    vi.advanceTimersByTime(1000);
    expect(s.sample()).not.toBe(first);
    s.stop();
  });

  it('stop() clears the timer and disables the monitor', () => {
    vi.useFakeTimers();
    const s = createProcessSampler({ intervalMs: 1000 });
    s.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(disables[0]).toHaveBeenCalledTimes(1);
  });
});

describe('compose stop() disables the event-loop monitor', () => {
  it('calls histogram.disable() on teardown', async () => {
    const composed = await compose({
      systemActor: 'test',
      server: new MemorySubstrateServer(),
      dataset: new MemoryDataset({ namespace: 'default' })
    });
    expect(disables).toHaveLength(1);
    expect(disables[0]).not.toHaveBeenCalled();
    await composed.stop();
    expect(disables[0]).toHaveBeenCalledTimes(1);
  });
});
