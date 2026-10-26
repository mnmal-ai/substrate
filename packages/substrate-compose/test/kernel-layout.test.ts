import type { KernelPlugin } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { composeKernelPlugins } from '../src/kernel.js';

describe('kernel migration layout', () => {
  it('passes the store layout to kernel migrations', async () => {
    for (const layout of ['legacy', 'partitioned', null] as const) {
      const seen: unknown[] = [];
      const plugin: KernelPlugin = {
        name: 'stub',
        contractVersion: '*',
        migrations: [{ id: '0001', apply: async (ctx) => void seen.push(ctx.layout) }]
      };
      await composeKernelPlugins([plugin], {
        sql: null,
        layout,
        metric: () => undefined,
        registerKernelRoute: () => undefined,
        registerMcpTool: () => undefined,
        registerFilterOperator: () => undefined,
        applyMigration: async () => undefined,
        getAppliedMigrationIds: async () => new Set<string>()
      });
      expect(seen).toEqual([layout]);
    }
  });
});
