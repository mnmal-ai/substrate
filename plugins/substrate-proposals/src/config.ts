/**
 * @mnmal-ai/substrate-proposals plugin configuration and PubSub injection seam,
 * the pluggable transport for multi-instance deployments.
 */

import type { Dataset } from '@mnmal-ai/substrate-types';

/**
 * Multi-instance invalidation transport used by the plugin to broadcast
 * TypeProposal and FieldProposal application across instances.
 *
 * `createNoopPubSub()` serves tests and single-instance deployments; no
 * multi-instance (e.g. pg LISTEN/NOTIFY) implementation ships in this package.
 */
export interface PubSub {
  /**
   * Subscribe to `channel`. Handler is invoked with the raw NOTIFY payload
   * (a string, typically a proposal id). Implementations MAY reconnect and
   * re-invoke subscriptions; handlers must be idempotent.
   */
  listen(channel: string, handler: (payload: string) => void | Promise<void>): Promise<void>;

  /**
   * Emit `payload` on `channel`. Best-effort; pg's transactional NOTIFY is
   * preferred (emit inside the row-insert tx) but fire-and-forget post-commit
   * is acceptable given reconcile-on-restart is the correctness floor.
   */
  notify(channel: string, payload: string): Promise<void>;
}

export interface ProposalsPluginConfig {
  /**
   * Namespaces this plugin owns. Propose mutations outside this list are
   * rejected at resolver entry. A proposed crossRef must target a type in an
   * owned (or hot-added) namespace.
   */
  ownedNamespaces: string[];

  /**
   * Multi-instance invalidation transport. Required: pass a no-op stub in
   * single-instance deployments (e.g. `createNoopPubSub()`).
   */
  pubsub: PubSub;

  /**
   * Capability name required to invoke propose_* mutations. Defaults to
   * `'substrate.propose'`. Override only when a deployment needs to partition
   * propose authority under a differently-named cap.
   */
  proposeCapability?: string;

  /**
   * Capability name required to invoke `propose_index`, in the namespace whose
   * indexes it changes. Defaults to `'substrate.index'`: separate from the
   * propose capability, so only the operator or a designated reviewer changes
   * indexes.
   */
  indexCapability?: string;

  /**
   * Lookup function the `propose_namespace` resolver uses to find the dataset
   * for a hot-added namespace. The host (typically the substrate binary) wires
   * this to its dataset registry. Returning `undefined` causes the resolver
   * to throw `dataset_not_provisioned` — substrate selection is the host's
   * responsibility, so the host MUST register the dataset before calling
   * `propose_namespace`.
   */
  datasetFor?: (ns: string) => Dataset | undefined;
}

/**
 * Convenience stub for tests and single-instance deployments where multi-
 * instance invalidation is not needed.
 */
export function createNoopPubSub(): PubSub {
  return {
    async listen(): Promise<void> {},
    async notify(): Promise<void> {}
  };
}
