/**
 * The transactions a local mutate runs in: one over a partition's datasets and
 * the edges, and the work queued to run once it has settled.
 */

import type { AfterTxWork, Dataset, EdgesStore } from '@mnmal-ai/substrate-types';
import type { MetricFn } from './internals.js';
import type { LocalTxScopePartition } from './mutate.js';

/** A partition that opens a transaction. */
export type TxPartition = Exclude<LocalTxScopePartition, { kind: 'zero_datasets' }>;

export class LocalTx {
  readonly #edges: EdgesStore;
  readonly #metric: MetricFn;

  constructor(deps: { edges: EdgesStore; metric: MetricFn }) {
    this.#edges = deps.edges;
    this.#metric = deps.metric;
  }

  /**
   * Runs `body` in one transaction over `partition`'s datasets and the edges.
   * `single_dataset` shares that dataset's tx; `coalesced_tx_scope` needs
   * `withScopedTransaction`, and without it resolves the refusal message
   * instead of running `body`.
   */
  async inLocalTx(
    partition: TxPartition,
    body: (txFor: (ns: string) => Dataset | null, txEdges: EdgesStore) => Promise<void>
  ): Promise<string | undefined> {
    if (partition.kind === 'single_dataset') {
      // Virtual keys receive txDs too; runEntry discards it by contract.
      await this.withRowsAndEdgesTx(partition.dataset, partition.entries[0]?.ns, (txDs, txEdges) =>
        body(() => txDs, txEdges)
      );
      return undefined;
    }
    const firstDataset = partition.firstDataset;
    const nsList = Array.from(new Set(partition.entries.map((e) => e.ns)));
    if (firstDataset.withScopedTransaction === undefined) {
      nsList.sort();
      this.#metric('engine_cross_tx_scope_refused', { namespaces: nsList });
      return `mutate cannot coalesce across [${nsList.join(', ')}]: tx scope '${firstDataset.txScopeId ?? 'unknown'}' does not support withScopedTransaction`;
    }
    await firstDataset.withScopedTransaction(nsList, async ({ datasets, edges }) => {
      const txFor = (ns: string): Dataset | null => datasets.get(ns) ?? null;
      if (edges !== null) await body(txFor, edges);
      else await this.#edges.withTransaction((txEdges) => body(txFor, txEdges));
    });
    return undefined;
  }

  /**
   * Run `fn` in one transaction over `dataset`'s rows and the edges. A dataset
   * with `withScopedTransaction` and an enlisted edges store shares one
   * substrate tx (one pg connection); otherwise the edges tx nests inside the
   * dataset tx.
   */
  async withRowsAndEdgesTx(
    dataset: Dataset,
    ns: string | undefined,
    fn: (txDs: Dataset, txEdges: EdgesStore) => Promise<void>
  ): Promise<void> {
    if (dataset.withScopedTransaction !== undefined && ns !== undefined) {
      await dataset.withScopedTransaction([ns], async ({ datasets, edges }) => {
        const txDs = datasets.get(ns) ?? dataset;
        if (edges !== null) await fn(txDs, edges);
        else await this.#edges.withTransaction((txEdges) => fn(txDs, txEdges));
      });
      return;
    }
    await dataset.withTransaction(async (txDs) => {
      await this.#edges.withTransaction((txEdges) => fn(txDs, txEdges));
    });
  }

  /** Runs `afterTx` work; a failure is reported, never allowed to replace the frame's outcome. */
  async runSettled(settled: AfterTxWork[], committed: boolean): Promise<void> {
    for (const fn of settled) {
      try {
        await fn({ committed });
      } catch (err) {
        this.#metric('engine_after_tx_failed', {
          message: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }
}
