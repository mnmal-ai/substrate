import { getExtensionOperator } from '@mnmal-ai/substrate-core';
import type { KernelPlugin } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { composeKernel, type KernelSql } from '../src/kernel.js';

/** Just enough of kernel_migrations to exercise tracking without postgres. */
function fakeSql(): KernelSql & { applied: Set<string>; created: boolean } {
  const state = { applied: new Set<string>(), created: false };
  return Object.assign(state, {
    async unsafe(query: string, params: unknown[] = []) {
      if (/CREATE TABLE IF NOT EXISTS kernel_migrations/.test(query)) {
        state.created = true;
        return [];
      }
      if (/^\s*SELECT migration_id/.test(query)) {
        return [...state.applied]
          .filter((k) => k.startsWith(`${params[0]}:`))
          .map((k) => ({ migration_id: k.split(':')[1] }));
      }
      if (/INSERT INTO kernel_migrations/.test(query)) {
        state.applied.add(`${params[0]}:${params[1]}`);
        return [];
      }
      throw new Error(`unexpected SQL: ${query}`);
    }
  });
}

function plugin(name: string, calls: string[], extra: Partial<KernelPlugin> = {}) {
  return {
    name,
    contractVersion: '>=1.0.0-alpha.0 <2.0.0',
    migrations: [
      { id: '0001', apply: async () => void calls.push(`${name}:0001`) },
      { id: '0002', apply: async () => void calls.push(`${name}:0002`) }
    ],
    onKernelReady: async () => void calls.push(`${name}:ready`),
    ...extra
  } as KernelPlugin;
}

describe('composeKernel: the binary’s kernel tier, for any host', () => {
  it('creates tracking, applies each migration once, and runs onKernelReady after ALL plugins', async () => {
    const sql = fakeSql();
    const calls: string[] = [];
    await composeKernel([plugin('a', calls), plugin('b', calls)], { sql });
    expect(sql.created).toBe(true);
    expect(calls).toEqual(['a:0001', 'a:0002', 'b:0001', 'b:0002', 'a:ready', 'b:ready']);

    // Second boot: migrations are recorded, so only the readiness hooks run.
    calls.length = 0;
    await composeKernel([plugin('a', calls), plugin('b', calls)], { sql });
    expect(calls).toEqual(['a:ready', 'b:ready']);
  });

  it('registers filter operators into the shared registry the engine validates against', async () => {
    const name = `testOp_${Date.now()}`;
    const op = {
      validate: () => ({ ok: true as const, value: {} }),
      resolve: async () => ({ hits: [] })
    };
    await composeKernel([plugin('f', [], { filterOperators: { [name]: op as never } })], {
      sql: null
    });
    expect(getExtensionOperator(name)).toBeDefined();
  });

  it('refuses a kernel route it has nowhere to mount, rather than dropping it', async () => {
    const claim = { path: 'recall', method: 'POST', capability: 'read', handler: async () => ({}) };
    await expect(
      composeKernel([plugin('k', [], { kernelRoutes: [claim as never] })], { sql: null })
    ).rejects.toThrow(/no registerKernelRoute/);
  });

  it('passes coordinator namespaces and the metric sink through to onKernelReady', async () => {
    const seen: unknown[] = [];
    const metrics: string[] = [];
    await composeKernel(
      [
        {
          name: 'r',
          contractVersion: '>=1.0.0-alpha.0 <2.0.0',
          onKernelReady: async (ctx) => {
            seen.push(ctx.coordinatorNamespaces);
            ctx.metric('hello');
          }
        } as KernelPlugin
      ],
      { sql: null, coordinatorNamespaces: ['journal'], metric: (n) => void metrics.push(n) }
    );
    expect(seen).toEqual([['journal']]);
    expect(metrics).toEqual(['hello']);
  });
});
