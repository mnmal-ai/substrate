import type { Dataset, EdgesStore, EngineHandle, Registry } from '@mnmal-ai/substrate-types';
import { CONTROL_NAMESPACE } from './control-plane.js';
import type { StorageScope } from './engine-write.js';

export interface NamespaceBinding {
  registry: Registry;
  dataset: Dataset;
  edges: EdgesStore;
  /**
   * Callback that drops the engine's cached schema views for this namespace
   * after a `register` / `replace` lands via applyTypeProposal /
   * applyFieldProposal. Wired by the plugin's `onStart`, before the initial
   * reconcile; undefined until then, as the engine does not exist at install.
   */
  invalidateSchemaCaches?: () => void;
  /**
   * Engine handle wired by `onStart` so propose_type / propose_field can route
   * TypeProposal / FieldProposal writes through autoCRUD instead of bypassing
   * it via raw `dataset.write`. Routing through the engine populates
   * `_metadata`, allocates `shortId`, and fires `postWrite` hooks.
   * Undefined during install / pre-onStart — resolver-direct tests that don't
   * boot an engine fall back to `dataset.write`.
   */
  engine?: EngineHandle;
  /** True when the binding was created at runtime by `installHotAddedNamespace`. */
  hotAdded?: boolean;
  /** The propose_namespace attempt that may still undo this binding on rollback. */
  claim?: object;
}

/**
 * Holds a namespace → NamespaceBinding map, bridging compose-time type
 * registration (install()) and runtime apply-proposal + multi-instance
 * reconcile code paths.
 *
 * The plugin stashes each namespace's binding (registry + dataset + edges) at
 * install so mutation resolvers, onStart and reconcile can reach it later.
 */
export class RegistryStore {
  private readonly bindings = new Map<string, NamespaceBinding>();
  readonly #storageAbort = new AbortController();
  /** This plugin instance's background storage work. */
  readonly storage: StorageScope = { signal: this.#storageAbort.signal, pending: new Set() };

  /** Aborts the background storage work (an interrupted build is left INVALID for the next reconcile) and awaits it. */
  async stopStorage(): Promise<void> {
    this.#storageAbort.abort();
    await Promise.all([...this.storage.pending]);
  }

  /**
   * Register a full NamespaceBinding for the given namespace.
   *
   * @throws Error if the namespace already has a binding (duplicate is a bug)
   */
  set(namespace: string, binding: NamespaceBinding): void {
    if (this.bindings.has(namespace)) {
      throw new Error(`RegistryStore: duplicate binding for namespace '${namespace}'`);
    }
    this.bindings.set(namespace, binding);
  }

  /**
   * Retrieve the full NamespaceBinding for the given namespace.
   *
   * @throws Error if the namespace has no binding (lookup is a contract violation)
   */
  getBinding(namespace: string): NamespaceBinding {
    const b = this.bindings.get(namespace);
    if (!b) throw new Error(`RegistryStore: no binding for namespace '${namespace}'`);
    return b;
  }

  /**
   * Back-compat: returns just the registry handle.
   */
  get(namespace: string): Registry {
    return this.getBinding(namespace).registry;
  }

  /** Forget a namespace's binding (its runtime install was taken back). */
  delete(namespace: string): void {
    this.bindings.delete(namespace);
  }

  /**
   * Safe presence check for a namespace in the store.
   */
  has(namespace: string): boolean {
    return this.bindings.has(namespace);
  }

  /**
   * True when `type` is a type registered in a namespace this plugin owns, so
   * a proposed crossRef cannot point into a namespace it does not manage or at
   * a type that does not exist. The control plane is the plugin's own, not a
   * user namespace.
   */
  ownsType(namespace: string, type: string): boolean {
    return (
      this.ownsNamespace(namespace) &&
      this.getBinding(namespace).registry.get(type)?.kind === 'type'
    );
  }

  /** True when `namespace` is a user namespace this plugin owns or hot-added. */
  ownsNamespace(namespace: string): boolean {
    return namespace !== CONTROL_NAMESPACE && this.bindings.has(namespace);
  }

  /**
   * Wire the post-replace schema-cache invalidator for a namespace. Called
   * from the plugin's `onStart` once the engine handle is available. No-op if the namespace has no binding — the binding is
   * registered at install time and onStart runs strictly after install.
   */
  setInvalidator(namespace: string, fn: () => void): void {
    const b = this.bindings.get(namespace);
    if (b !== undefined) b.invalidateSchemaCaches = fn;
  }

  /**
   * Wire the engine handle so propose_type / propose_field resolvers can route
   * TypeProposal / FieldProposal writes through autoCRUD. Called from
   * the plugin's `onStart` alongside `setInvalidator`. Same lifecycle: no-op
   * for unregistered namespaces; binding always pre-exists after install.
   */
  setEngine(namespace: string, engine: EngineHandle): void {
    const b = this.bindings.get(namespace);
    if (b !== undefined) b.engine = engine;
  }
}
