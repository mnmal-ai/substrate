import type { SweepState } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { runSweepCycle, SweepStageError } from '../src/sweep-cycle.js';

const _EMPTY_STATE: SweepState = { lastSweptCursor: null };
const NEXT_STATE: SweepState = { lastSweptCursor: 'c1' };

describe('runSweepCycle', () => {
  it('returns state + reap when both arms succeed', async () => {
    const result = await runSweepCycle(
      async () => NEXT_STATE,
      async () => ({ deleted: 3 })
    );
    expect(result.state).toEqual(NEXT_STATE);
    expect(result.reap).toEqual({ deleted: 3 });
  });

  it('skips the reap arm when no idempotency fn is supplied', async () => {
    const result = await runSweepCycle(async () => NEXT_STATE, null);
    expect(result.state).toEqual(NEXT_STATE);
    expect(result.reap).toBeUndefined();
  });

  it('tags an edge-sweep failure with stage="edge-sweep"', async () => {
    const boom = new Error('edges store unreachable');
    let thrown: unknown;
    try {
      await runSweepCycle(
        async () => {
          throw boom;
        },
        async () => ({ deleted: 0 })
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SweepStageError);
    expect((thrown as SweepStageError).stage).toBe('edge-sweep');
    expect((thrown as SweepStageError).message).toBe('edges store unreachable');
    expect((thrown as SweepStageError).cause).toBe(boom);
  });

  it('tags an idempotency-reap failure with stage="idempotency-reap"', async () => {
    const boom = new Error('pg idempotency table unreachable');
    let thrown: unknown;
    try {
      await runSweepCycle(
        async () => NEXT_STATE,
        async () => {
          throw boom;
        }
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SweepStageError);
    expect((thrown as SweepStageError).stage).toBe('idempotency-reap');
    expect((thrown as SweepStageError).message).toBe('pg idempotency table unreachable');
    expect((thrown as SweepStageError).cause).toBe(boom);
  });

  it('does NOT call the reap arm when the edge sweep rejects', async () => {
    let reapCalled = false;
    await expect(
      runSweepCycle(
        async () => {
          throw new Error('boom');
        },
        async () => {
          reapCalled = true;
          return null;
        }
      )
    ).rejects.toBeInstanceOf(SweepStageError);
    expect(reapCalled).toBe(false);
  });

  it('wraps non-Error thrown values into a SweepStageError', async () => {
    let thrown: unknown;
    try {
      await runSweepCycle(async () => {
        throw 'string-not-error'; // eslint-disable-line no-throw-literal
      }, null);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SweepStageError);
    expect((thrown as SweepStageError).message).toBe('string-not-error');
    expect((thrown as SweepStageError).stage).toBe('edge-sweep');
  });

  it('returns tombstonePurge counts when the purge arm is supplied', async () => {
    const result = await runSweepCycle(
      async () => NEXT_STATE,
      null,
      async () => ({ rows: 4, edges: 2 })
    );
    expect(result.state).toEqual(NEXT_STATE);
    expect(result.tombstonePurge).toEqual({ rows: 4, edges: 2 });
  });

  it('skips the purge arm when no purge fn is supplied', async () => {
    const result = await runSweepCycle(
      async () => NEXT_STATE,
      async () => ({ deleted: 0 }),
      null
    );
    expect(result.tombstonePurge).toBeUndefined();
  });

  it('tags a tombstone-purge failure with stage="tombstone-purge"', async () => {
    const boom = new Error('rows table unreachable');
    let thrown: unknown;
    try {
      await runSweepCycle(
        async () => NEXT_STATE,
        null,
        async () => {
          throw boom;
        }
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SweepStageError);
    expect((thrown as SweepStageError).stage).toBe('tombstone-purge');
    expect((thrown as SweepStageError).message).toBe('rows table unreachable');
    expect((thrown as SweepStageError).cause).toBe(boom);
  });

  it('does NOT call the purge arm when the reap arm rejects', async () => {
    let purgeCalled = false;
    await expect(
      runSweepCycle(
        async () => NEXT_STATE,
        async () => {
          throw new Error('reap-boom');
        },
        async () => {
          purgeCalled = true;
          return { rows: 0, edges: 0 };
        }
      )
    ).rejects.toBeInstanceOf(SweepStageError);
    expect(purgeCalled).toBe(false);
  });
});

describe('runSweepCycle — embeddings-gc arm', () => {
  it('returns embeddingsGc count when the arm runs', async () => {
    const result = await runSweepCycle(
      async () => NEXT_STATE,
      null,
      null,
      async () => 7
    );
    expect(result.state).toEqual(NEXT_STATE);
    expect(result.embeddingsGc).toBe(7);
  });

  it('omits embeddingsGc when no gc fn is supplied', async () => {
    const result = await runSweepCycle(async () => NEXT_STATE, null, null, null);
    expect(result.embeddingsGc).toBeUndefined();
  });

  it('tags an embeddings-gc failure with stage="embeddings-gc"', async () => {
    const boom = new Error('embeddings unreachable');
    let thrown: unknown;
    try {
      await runSweepCycle(
        async () => NEXT_STATE,
        null,
        null,
        async () => {
          throw boom;
        }
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SweepStageError);
    expect((thrown as SweepStageError).stage).toBe('embeddings-gc');
    expect((thrown as SweepStageError).cause).toBe(boom);
  });

  it('runs after tombstone-purge — both results present on a full four-arm tick', async () => {
    const calls: string[] = [];
    const result = await runSweepCycle(
      async () => {
        calls.push('sweep');
        return NEXT_STATE;
      },
      async () => {
        calls.push('reap');
        return { deleted: 1 };
      },
      async () => {
        calls.push('purge');
        return { rows: 2, edges: 0 };
      },
      async () => {
        calls.push('gc');
        return 5;
      }
    );
    expect(calls).toEqual(['sweep', 'reap', 'purge', 'gc']);
    expect(result.tombstonePurge).toEqual({ rows: 2, edges: 0 });
    expect(result.embeddingsGc).toBe(5);
  });
});
