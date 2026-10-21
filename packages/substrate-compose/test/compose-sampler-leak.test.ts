import { MemoryDataset } from '@mnmal-ai/substrate-dataset-memory';
import { MemorySubstrateServer } from '@mnmal-ai/substrate-server-memory';
import { describe, expect, it, vi } from 'vitest';

const stop = vi.fn();
vi.mock('../src/process-sampler.js', () => ({
  createProcessSampler: () => ({
    sample: () => ({
      rssMB: 0,
      heapUsedMB: 0,
      cpuUserMs: 0,
      cpuSystemMs: 0,
      eventLoopLagP99Ms: 0
    }),
    stop
  })
}));

const { compose } = await import('../src/compose.js');

describe('compose failure path', () => {
  it('stops the process sampler when compose throws after creating it', async () => {
    const server = new MemorySubstrateServer();
    server.route = () => {
      throw new Error('route registration failed');
    };
    await expect(
      compose({
        systemActor: 'test',
        server,
        dataset: new MemoryDataset({ namespace: 'default' })
      })
    ).rejects.toThrow('route registration failed');
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
