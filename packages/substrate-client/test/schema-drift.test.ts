import { describe, expect, it, vi } from 'vitest';
import { SchemaDriftError } from '../src/errors.js';
import { SchemaDriftHandler } from '../src/wire/schema-drift.js';

describe('SchemaDriftHandler', () => {
  it('passes through when versions match', async () => {
    const refetch = vi.fn();
    const handler = new SchemaDriftHandler({ refetch });
    handler.setCachedVersion('v1');
    await handler.verify('v1');
    expect(refetch).not.toHaveBeenCalled();
  });

  it('refetches on version mismatch; passes if new cached version matches', async () => {
    const handler = new SchemaDriftHandler({
      refetch: async () => {
        handler.setCachedVersion('v2');
      }
    });
    handler.setCachedVersion('v1');
    await handler.verify('v2');
    // No error thrown — refetch updated the cached version to match
  });

  it('throws SchemaDriftError on persistent mismatch after refetch', async () => {
    const handler = new SchemaDriftHandler({
      refetch: async () => {
        handler.setCachedVersion('v1'); // stale refetch returns same version
      }
    });
    handler.setCachedVersion('v1');
    await expect(handler.verify('v3')).rejects.toBeInstanceOf(SchemaDriftError);
  });

  it('concurrent verify calls share one refetch', async () => {
    let refetchCount = 0;
    let resolveRefetch!: () => void;
    const handler = new SchemaDriftHandler({
      refetch: async () => {
        refetchCount++;
        await new Promise<void>((r) => {
          resolveRefetch = r;
        });
        handler.setCachedVersion('v2');
      }
    });
    handler.setCachedVersion('v1');
    const p1 = handler.verify('v2');
    const p2 = handler.verify('v2');
    // Let the first refetch begin, then resolve it
    await new Promise((r) => setImmediate(r));
    resolveRefetch();
    await Promise.all([p1, p2]);
    expect(refetchCount).toBe(1);
  });

  it('getCachedVersion returns the current version', () => {
    const handler = new SchemaDriftHandler({ refetch: async () => {} });
    expect(handler.getCachedVersion()).toBe(null);
    handler.setCachedVersion('v5');
    expect(handler.getCachedVersion()).toBe('v5');
  });

  it('rejects concurrent verify calls with the refetch error when refetch throws', async () => {
    const refetchErr = new Error('network unreachable');
    const handler = new SchemaDriftHandler({
      refetch: async () => {
        throw refetchErr;
      }
    });
    handler.setCachedVersion('v1');
    const p1 = handler.verify('v2');
    const p2 = handler.verify('v2');
    await expect(p1).rejects.toBe(refetchErr);
    await expect(p2).rejects.toBe(refetchErr);
  });

  it('reattempts refetch on next verify after a prior refetch threw', async () => {
    let callCount = 0;
    const handler = new SchemaDriftHandler({
      refetch: async () => {
        callCount++;
        if (callCount === 1) throw new Error('transient');
        handler.setCachedVersion('v2');
      }
    });
    handler.setCachedVersion('v1');
    await expect(handler.verify('v2')).rejects.toThrow(/transient/);
    // Second verify call: refetch should run again (not stuck on the first inflight), succeed, and pass.
    await handler.verify('v2');
    expect(callCount).toBe(2);
  });
});
