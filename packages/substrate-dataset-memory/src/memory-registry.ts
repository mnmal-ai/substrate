/**
 * MemoryDatasetRegistry — minimal in-memory `DatasetRegistry`.
 * Spec: §4.5, §6.4.
 *
 * Lifecycle: memory-backed namespaces are ephemeral. §6.4 — on disposal (or a
 * substrate restart that drops the map), listeners registered via
 * `onNamespaceLost` fire so the engine can apply declared policy to every
 * inbound edge without waiting for the next sweep cycle.
 *
 * Factory fallback: when constructed with `{ factory }`, a get-miss delegates
 * to the factory, so hot-added namespaces (`engine.addNamespace`) resolve to a
 * dataset on first lookup without the host pre-registering one. See
 * `MemoryDatasetRegistryOptions.factory` for caching.
 */

import type { Dataset, DatasetRegistry } from '@mnmal-ai/substrate-types';

type NamespaceLostListener = (ns: string) => void;

export interface MemoryDatasetRegistryOptions {
  /**
   * Optional fallback invoked on `get(ns)` miss. Returning a dataset caches
   * it via `set(ns, dataset)` so the next get is a direct map hit. Returning
   * undefined leaves the registry empty for that ns and is NOT cached — the
   * next get re-invokes the factory (caller may have provisioned the
   * substrate in between).
   */
  factory?: (ns: string) => Dataset | undefined;
}

export class MemoryDatasetRegistry implements DatasetRegistry {
  private readonly datasets: Map<string, Dataset> = new Map();
  private readonly listeners: Set<NamespaceLostListener> = new Set();
  private readonly factory: ((ns: string) => Dataset | undefined) | undefined;

  constructor(options: MemoryDatasetRegistryOptions = {}) {
    this.factory = options.factory;
  }

  get(ns: string): Dataset | undefined {
    const cached = this.datasets.get(ns);
    if (cached !== undefined) return cached;
    if (this.factory === undefined) return undefined;
    const built = this.factory(ns);
    if (built === undefined) return undefined;
    this.datasets.set(ns, built);
    return built;
  }

  has(ns: string): boolean {
    return this.datasets.has(ns);
  }

  set(ns: string, dataset: Dataset): void {
    this.datasets.set(ns, dataset);
  }

  onNamespaceLost(listener: NamespaceLostListener): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  dispose(ns: string): void {
    // Silent no-op for unknown namespaces — a shutdown handler that replays
    // the list of known namespaces over the registry must not double-fire if
    // an earlier step already removed one.
    if (!this.datasets.delete(ns)) return;
    // Insertion order is the JS Set default. A throwing listener MUST NOT stop
    // the others — §6.4 depends on every subscriber getting the event.
    for (const listener of this.listeners) {
      try {
        listener(ns);
      } catch {
        // Listener errors are the listener's problem. We can't log here
        // without a logger dep; tests inject a listener that asserts and any
        // real-world failure surfaces through the engine's own metric hook.
      }
    }
  }
}
