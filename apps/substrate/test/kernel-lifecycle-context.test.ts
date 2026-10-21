/**
 * `onKernelReady` receives a usable context: the migrations' `sql` handle
 * and the declared coordinator namespaces.
 *
 * This is the seam for CONVERGENT reconciliation. A migration's `apply` runs
 * only when its `id` is absent, so it cannot re-scope something like a
 * namespace literal baked into a CHECK constraint after a namespace rename.
 */

import type { KernelLifecycleContext, KernelPlugin } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import { composeKernelPlugins, type KernelComposeContext } from '../src/_kernel.js';

const baseCtx = (over: Partial<KernelComposeContext> = {}): KernelComposeContext => ({
  sql: null,
  metric: () => undefined,
  registerKernelRoute: () => undefined,
  registerMcpTool: () => undefined,
  registerFilterOperator: () => undefined,
  applyMigration: async () => undefined,
  getAppliedMigrationIds: async () => new Set<string>(),
  ...over
});

/** Captures whatever `onKernelReady` was handed. */
const capturing = (): { plugin: KernelPlugin; seen: KernelLifecycleContext[] } => {
  const seen: KernelLifecycleContext[] = [];
  return {
    seen,
    plugin: {
      name: 'capturer',
      contractVersion: '*',
      onKernelReady: (ctx) => {
        seen.push(ctx);
      }
    }
  };
};

describe('onKernelReady context', () => {
  it('receives the same sql handle migrations get', async () => {
    const sql = { marker: 'the-handle' };
    const { plugin, seen } = capturing();
    await composeKernelPlugins([plugin], baseCtx({ sql }));
    // Identity, not shape: a reconciler issuing DDL must be on the same
    // connection the migrations used, not a lookalike.
    expect(seen[0]?.sql).toBe(sql);
  });

  it('passes sql through as null on a memory-backed deployment', async () => {
    const { plugin, seen } = capturing();
    await composeKernelPlugins([plugin], baseCtx({ sql: null }));
    expect(seen[0]?.sql).toBeNull();
  });

  it('receives the declared coordinator namespaces', async () => {
    const { plugin, seen } = capturing();
    await composeKernelPlugins(
      [plugin],
      baseCtx({ coordinatorNamespaces: ['cortext', 'architecture'] })
    );
    expect(seen[0]?.coordinatorNamespaces).toEqual(['cortext', 'architecture']);
  });

  /**
   * Absent must mean "none", not `undefined` — a reconciler iterating the list
   * should no-op on a binary with no coordinators rather than throw.
   */
  it('defaults coordinator namespaces to empty rather than undefined', async () => {
    const { plugin, seen } = capturing();
    await composeKernelPlugins([plugin], baseCtx());
    expect(seen[0]?.coordinatorNamespaces).toEqual([]);
  });

  it('still tags the context as the kernel stage', async () => {
    const { plugin, seen } = capturing();
    await composeKernelPlugins([plugin], baseCtx());
    expect(seen[0]?.lifecycle).toBe('kernel');
  });

  /**
   * The ordering the namespace list depends on: coordinators are LOADED before
   * substrate composes but INSTALL after it, which is why declared names are
   * available here at all. A reordering would silently hand every reconciler
   * an empty list, indistinguishable from "no coordinators configured".
   */
  it('fires after every kernel plugin has registered', async () => {
    const order: string[] = [];
    const mk = (name: string): KernelPlugin => ({
      name,
      contractVersion: '*',
      filterOperators: {
        [`op_${name}`]: { evaluate: () => true } as never
      },
      onKernelReady: () => {
        order.push(`ready:${name}`);
      }
    });
    await composeKernelPlugins(
      [mk('a'), mk('b')],
      baseCtx({ registerFilterOperator: (n) => order.push(`register:${n}`) })
    );
    expect(order).toEqual(['register:op_a', 'register:op_b', 'ready:a', 'ready:b']);
  });
});

/**
 * Attribution. The flat `coordinatorNamespaces` list makes a renamed
 * namespace DETECTABLE but not TARGETABLE: a substrate sees its scope literal
 * is gone and cannot say which of the remaining names replaced it.
 */
describe('onKernelReady coordinator attribution', () => {
  it('attributes each namespace to the coordinator that declared it', async () => {
    const { plugin, seen } = capturing();
    await composeKernelPlugins(
      [plugin],
      baseCtx({
        coordinatorNamespacesByPlugin: [
          { plugin: '@mnmal-ai/cortext', namespace: 'cortext' },
          { plugin: '@mnmal-ai/cortext', namespace: 'architecture' },
          { plugin: '@mnmal-ai/substrate-proposals', namespace: 'sandbox' }
        ]
      })
    );
    // The whole point: filter to one plugin and get its namespaces, no heuristic.
    expect(
      (seen[0]?.coordinatorNamespacesByPlugin ?? [])
        .filter((e) => e.plugin === '@mnmal-ai/cortext')
        .map((e) => e.namespace)
    ).toEqual(['cortext', 'architecture']);
  });

  /**
   * `undefined` and `[]` must stay distinguishable. Flattening the first to
   * the second would make "this host is too old to attribute" read identically
   * to "attribution supplied, no coordinators".
   */
  it('leaves attribution undefined when the host does not supply it — not []', async () => {
    const { plugin, seen } = capturing();
    await composeKernelPlugins([plugin], baseCtx());
    expect(seen[0]?.coordinatorNamespacesByPlugin).toBeUndefined();
  });

  it('distinguishes that from an explicit empty list', async () => {
    const { plugin, seen } = capturing();
    await composeKernelPlugins([plugin], baseCtx({ coordinatorNamespacesByPlugin: [] }));
    expect(seen[0]?.coordinatorNamespacesByPlugin).toEqual([]);
  });
});
