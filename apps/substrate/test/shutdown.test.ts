import { afterEach, describe, expect, it, vi } from 'vitest';
import { installShutdown } from '../src/serve/shutdown.js';

describe('installShutdown', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });

  it('exits once the grace has passed even when closing the store never settles', async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    installShutdown({
      config: { shutdownGraceMs: 1000 },
      sweepTimer: setInterval(() => {}, 1e6),
      inviteSweepTimer: null,
      sentinelClient: null,
      disposeBridges: () => {},
      stop: async () => {},
      closeStore: () => new Promise<void>(() => {})
    });

    process.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1001);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('stops the index builds, and waits for them, before closing the store', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const order: string[] = [];
    let finishBuilds = (): void => {};
    installShutdown({
      config: { shutdownGraceMs: 1000 },
      sweepTimer: setInterval(() => {}, 1e6),
      inviteSweepTimer: null,
      sentinelClient: null,
      disposeBridges: () => {},
      stop: async () => {},
      closeStore: async () => {
        order.push('closeStore');
      },
      stopIndexBuilds: () => {
        order.push('stopIndexBuilds');
        return new Promise<void>((resolve) => {
          finishBuilds = () => {
            order.push('builds stopped');
            resolve();
          };
        });
      }
    });

    process.emit('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['stopIndexBuilds']);
    finishBuilds();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(order).toEqual(['stopIndexBuilds', 'builds stopped', 'closeStore']);
  });

  it('abandons index builds that do not stop within their bound, well inside the grace', async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    installShutdown({
      config: { shutdownGraceMs: 30_000 },
      sweepTimer: setInterval(() => {}, 1e6),
      inviteSweepTimer: null,
      sentinelClient: null,
      disposeBridges: () => {},
      stop: async () => {},
      closeStore: async () => {},
      stopIndexBuilds: () => new Promise<void>(() => {})
    });

    process.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(1999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(exit).toHaveBeenCalledWith(0);
    expect(stderr).toHaveBeenCalledWith(
      'index builds did not stop within 2000ms; abandoning them\n'
    );
  });
});
