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
});
