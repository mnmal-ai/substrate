import type { KernelPlugin } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { composeKernelPlugins, KernelMigrationLayoutError } from '../src/kernel.js';

const ctx = {
  sql: null,
  layout: 'tables' as const,
  metric: () => undefined,
  registerKernelRoute: () => undefined,
  registerMcpTool: () => undefined,
  registerFilterOperator: () => undefined,
  applyMigration: async () => undefined,
  getAppliedMigrationIds: async () => new Set<string>()
};

/** What postgres.js throws for DDL on a relation the schema lacks. */
const undefinedTable = (relation: string) =>
  Object.assign(new Error(`relation "${relation}" does not exist`), { code: '42P01' });

const failing = (err: Error): KernelPlugin => ({
  name: 'old-plugin',
  contractVersion: '*',
  migrations: [
    {
      id: '0003_add_rows_column',
      apply: async () => {
        throw err;
      }
    }
  ]
});

describe('KernelMigrationLayoutError', () => {
  it('kernel migration ALTERing rows → KernelMigrationLayoutError naming the plugin', async () => {
    const cause = undefinedTable('rows');
    const err = await composeKernelPlugins([failing(cause)], ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KernelMigrationLayoutError);
    const layoutErr = err as KernelMigrationLayoutError;
    expect(layoutErr.plugin).toBe('old-plugin');
    expect(layoutErr.id).toBe('0003_add_rows_column');
    expect(layoutErr.message).toContain('old-plugin');
    expect(layoutErr.message).toContain('0003_add_rows_column');
    expect(layoutErr.message).toMatch(/upgrade/i);
    expect(layoutErr.cause).toBe(cause);
  });

  it('rethrows any other failure unchanged', async () => {
    for (const cause of [undefinedTable('my_plugin_table'), new Error('boom')]) {
      await expect(composeKernelPlugins([failing(cause)], ctx)).rejects.toBe(cause);
    }
  });
});
