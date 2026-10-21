/**
 * Sweep reconciler types. Spec: §6.3, §5.8.
 */

import type { BridgeClient } from './bridge.js';
import type { DatasetRegistry } from './dataset.js';
import type { EdgeRef, EdgesStore } from './edge.js';

export type TargetState = 'EXISTS' | 'DELETED' | 'MISSING';

/**
 * Registry of bridged namespaces. §5.8.
 *
 * Keys are local namespace aliases: the string a caller puts on a frame key
 * (`<alias>/<type>`) resolves to the bridge client responsible for proxying
 * to the remote. Aliasing happens at registration; the remote's internal
 * namespace names are opaque to this registry.
 */
export interface BridgeRegistry {
  /** True iff `ns` is bridged (registered under that alias). */
  has(ns: string): boolean;
  /** Return the bridge client for `ns` or undefined. */
  get(ns: string): BridgeClient | undefined;
  /** Fast-path reachability. True iff the bridge for `ns` is currently unreachable. */
  isUnreachable(ns: string): boolean;
  /** Iterate every (ns, bridge) pair. Used by the engine's schema merge at init. */
  entries(): Array<[string, BridgeClient]>;
}

export interface SweepDeps {
  datasets: DatasetRegistry;
  bridges: BridgeRegistry;
  edges: EdgesStore;
  now(): Date;
  metric(name: string, payload?: unknown): void;
}

export interface SweepState {
  lastSweptCursor: string | null;
}

export type ResolveTarget = (ref: EdgeRef, deps: SweepDeps) => Promise<TargetState>;
