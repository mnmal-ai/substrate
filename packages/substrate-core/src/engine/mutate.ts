/**
 * Mutate-partition helpers.
 *
 * Three pure routing passes run before any resolver: by route (local vs
 * bridged), by shape (single-frame vs non-empty array), and by substrate (G1
 * cross-substrate refusal + coalescing, §5.3). `Engine.mutate` feeds the
 * substrate result into `#dispatchSingleFrameLocal`.
 */

import type {
  BridgeRegistry,
  Dataset,
  DatasetRegistry,
  PackEnvelope,
  QualifiedFrame
} from '@mnmal-ai/substrate-types';
import { addError, type MetricFn, type ParsedKey } from './internals.js';

/** The engine slice the route pass needs (registries + metric sink). */
export interface MutatePartitionDeps {
  datasets: DatasetRegistry;
  bridges: BridgeRegistry;
  /**
   * True iff `ns` is registered locally (the engine's `#namespaces` map).
   * Virtual namespaces own no dataset, so the dataset-absence check alone can't
   * tell them apart from a genuinely-bridged ns — this guards the local claim.
   */
  hasLocalNamespace(ns: string): boolean;
  /** Records a grant refusal for `key` and returns true when the caller may not mutate `ns`. */
  refuseUngranted(key: string, ns: string): boolean;
  metric: MetricFn;
}

/** Result of the substrate partition pass (#partitionMutateByTxScope). */
export type MutateTxScopePartition =
  | { kind: 'cross_tx_scope_refused'; message: string; namespaces: string[] }
  | { kind: 'zero_datasets'; entries: Array<{ key: string; ns: string }> }
  | { kind: 'single_dataset'; dataset: Dataset; entries: Array<{ key: string; ns: string }> }
  | {
      kind: 'coalesced_tx_scope';
      firstDataset: Dataset;
      entries: Array<{ key: string; ns: string }>;
    };

/**
 * The dispatchable subset — every variant except `cross_tx_scope_refused`
 * (which the caller handles + short-circuits before dispatch). This is the
 * `partition` param type of `Engine.#dispatchSingleFrameLocal`.
 */
export type LocalTxScopePartition = Exclude<
  MutateTxScopePartition,
  { kind: 'cross_tx_scope_refused' }
>;

/**
 * Mutate partition pass 1: route keys to bridged vs local buckets.
 *
 * Bridges do NOT yet support forwarding an array of frames per op-key. If a
 * caller addresses a bridged ns with an array value, emit a per-key
 * `bridge_array_not_supported` error and drop the array from the bridge
 * bucket — the rest of the request still proceeds.
 *
 * Unqualified keys (parsed === null) and keys whose ns is unknown to both
 * the dataset and bridge registries fall into `localKeys` so the downstream
 * dispatch surfaces a per-key `unqualified_key`/`unknown_namespace` error
 * via the zero-dataset fallback in `#dispatchSingleFrameLocal`.
 */
export function partitionMutateByRoute(
  frame: QualifiedFrame,
  parsedByKey: Map<string, ParsedKey | null>,
  envelope: PackEnvelope,
  deps: MutatePartitionDeps
): { bridgeBuckets: Map<string, QualifiedFrame>; localKeys: string[] } {
  const bridgeBuckets = new Map<string, QualifiedFrame>();
  const localKeys: string[] = [];
  for (const [key, parsed] of parsedByKey) {
    // Locally-registered namespaces win over bridges. Virtual namespaces have no
    // dataset, so without the local-namespace check a bridge registered at
    // runtime (after boot-time collision checks) under the same alias would
    // silently shadow the local virtual surface.
    if (
      parsed &&
      !deps.datasets.has(parsed.ns) &&
      !deps.hasLocalNamespace(parsed.ns) &&
      deps.bridges.has(parsed.ns)
    ) {
      if (deps.refuseUngranted(key, parsed.ns)) continue;
      const entry = frame[key];
      if (Array.isArray(entry)) {
        addError(
          envelope,
          [key],
          `batched frame arrays are not supported across bridges (namespace '${parsed.ns}')`,
          'bridge_array_not_supported'
        );
        deps.metric('engine_bridge_array_not_supported', { ns: parsed.ns, key });
        continue;
      }
      let bucket = bridgeBuckets.get(parsed.ns);
      if (bucket === undefined) {
        bucket = {};
        bridgeBuckets.set(parsed.ns, bucket);
      }
      if (entry !== undefined) bucket[key] = entry;
      continue;
    }
    localKeys.push(key);
  }
  return { bridgeBuckets, localKeys };
}

/**
 * Mutate partition pass 2: split local keys into single-frame (G1: one
 * shared tx) and non-empty array (one isolated tx per op-key) buckets.
 *
 * Empty-array op-keys (`[]`) are an ambiguous caller bug, not a no-op.
 * They surface as a dedicated `empty_frame_array` error and are dropped
 * from both output buckets so downstream code never sees them.
 */
export function partitionMutateByShape(
  frame: QualifiedFrame,
  localKeys: string[],
  envelope: PackEnvelope,
  metric: MetricFn
): { singleFrameKeys: string[]; nonEmptyArrayKeys: string[] } {
  const singleFrameKeys: string[] = [];
  const nonEmptyArrayKeys: string[] = [];
  for (const key of localKeys) {
    const entry = frame[key];
    if (Array.isArray(entry)) {
      if (entry.length === 0) {
        addError(
          envelope,
          [key],
          `empty frame array at '${key}' — batched mutate requires at least one frame`,
          'empty_frame_array'
        );
        metric('engine_empty_frame_array', { key });
        continue;
      }
      nonEmptyArrayKeys.push(key);
    } else {
      singleFrameKeys.push(key);
    }
  }
  return { singleFrameKeys, nonEmptyArrayKeys };
}

/**
 * Mutate partition pass 3: bucket single-frame entries by `dataset.txScopeId`
 * and decide G1 dispatch shape (§5.3).
 *
 * Returns one of:
 *   - `kind: 'cross_tx_scope_refused'` — the single-frame bucket spans more
 *     than one substrate. Caller emits the top-level error and short-circuits.
 *   - `kind: 'zero_datasets'` — no key resolved to a dataset (every entry is
 *     unqualified, has an unknown ns, or names a virtual namespace).
 *     Caller dispatches via the per-key fallback so each `#runEntry` invocation
 *     either surfaces its own error code (unresolvable keys) or dispatches the
 *     virtual resolver with no tx.
 *   - `kind: 'single_dataset'` — exactly one distinct dataset under one
 *     substrate. Caller dispatches every entry inside that dataset's tx.
 *   - `kind: 'coalesced_tx_scope'` — N>1 datasets under one substrate.
 *     Caller dispatches via `withScopedTransaction` if available, else
 *     surfaces `cross_tx_scope_refused` (the substrate advertised a shared
 *     id but the implementation omits the coalescing method).
 *
 * Substrate coalescing (§5.3 / cross-ns batched mutate): grouping is by
 * `dataset.txScopeId`, not by dataset identity. Two datasets (different
 * namespaces) sharing a substrate coalesce into one pg tx.
 */
export function partitionMutateByTxScope(
  singleFrameKeys: string[],
  parsedByKey: Map<string, ParsedKey | null>,
  datasets: DatasetRegistry
): MutateTxScopePartition {
  // Single pass: build substrate buckets and per-bucket ns sets together.
  const txScopeBuckets = new Map<
    string,
    {
      datasets: Set<Dataset>;
      keys: Array<{ key: string; ns: string }>;
      nsSet: Set<string>;
    }
  >();
  for (const key of singleFrameKeys) {
    const parsed = parsedByKey.get(key);
    if (!parsed) continue;
    const ds = datasets.get(parsed.ns);
    if (!ds) continue;
    const bucket = txScopeBuckets.get(ds.txScopeId) ?? {
      datasets: new Set<Dataset>(),
      keys: [],
      nsSet: new Set<string>()
    };
    bucket.datasets.add(ds);
    bucket.keys.push({ key, ns: parsed.ns });
    bucket.nsSet.add(parsed.ns);
    txScopeBuckets.set(ds.txScopeId, bucket);
  }

  if (txScopeBuckets.size > 1) {
    const allNs = new Set<string>();
    const splitHintParts: string[] = [];
    for (const [sid, b] of txScopeBuckets) {
      for (const ns of b.nsSet) allNs.add(ns);
      const nss = Array.from(b.nsSet).sort();
      splitHintParts.push(`${sid}: [${nss.join(', ')}]`);
    }
    const nsList = Array.from(allNs).sort();
    return {
      kind: 'cross_tx_scope_refused',
      message: `mutate cannot span tx scopes; frame references datasets in namespaces [${nsList.join(', ')}]. Split by tx scope: ${splitHintParts.join('; ')}.`,
      namespaces: nsList
    };
  }

  if (txScopeBuckets.size === 0) {
    return { kind: 'zero_datasets', entries: [] };
  }

  const bucket = txScopeBuckets.values().next().value as {
    datasets: Set<Dataset>;
    keys: Array<{ key: string; ns: string }>;
  };
  if (bucket.datasets.size === 1) {
    const [dataset] = bucket.datasets;
    return {
      kind: 'single_dataset',
      dataset: dataset as Dataset,
      entries: bucket.keys
    };
  }
  const [firstDataset] = bucket.datasets;
  return {
    kind: 'coalesced_tx_scope',
    firstDataset: firstDataset as Dataset,
    entries: bucket.keys
  };
}
