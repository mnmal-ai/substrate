/**
 * Schema-federation subsystem.
 *
 * Owns the per-namespace published-schema cache, the federated-schema and
 * version caches, and the per-bridge schema cache, plus the methods that
 * read, refresh and invalidate them. `Engine`'s schema methods delegate
 * here. Never imports `Engine` (that would be a circular type); its
 * engine slice arrives via `SchemaSubsystemDeps`.
 */

import type { BridgeRegistry, NamespaceConfig, Schema } from '@mnmal-ai/substrate-types';
import { canonicalize } from '../canonicalize.js';
import { publishSchema, sha256Short } from '../schema-publisher.js';

export interface SchemaSubsystemDeps {
  /** Live namespace map (shared by reference with the engine). */
  namespaces: Map<string, NamespaceConfig>;
  /** Bridge registry (shared by reference with the engine). */
  bridges: BridgeRegistry;
  /**
   * Liveness predicate — `true` when the ns is registered and not tombstoned.
   * A callback so the engine owns the registered-vs-tombstoned semantics.
   */
  isLive: (ns: string) => boolean;
  /** Tombstone predicate — refuses schema reads against a tombstoned ns. */
  isTombstoned: (ns: string) => boolean;
}

export class SchemaSubsystem {
  readonly #namespaces: Map<string, NamespaceConfig>;
  readonly #bridges: BridgeRegistry;
  readonly #isLive: (ns: string) => boolean;
  readonly #isTombstoned: (ns: string) => boolean;

  // Per-ns published schema, cached against the registry's mutation epoch.
  // Registries can change at runtime (proposed types), so the epoch, not an
  // explicit invalidation call, decides staleness. `invalidateSchemaCaches`
  // remains for the bridge caches, which have no epoch.
  readonly #schemaCache: Map<string, { epoch: number | undefined; schema: Schema }> = new Map();
  // Lazy caches of `federatedSchema()` and `federatedSchemaVersion()`. Both
  // are dropped by `schemaFor` when a namespace's epoch moves; the federated
  // map is also dropped on bridge refresh.
  #federatedSchemaCache: Record<string, Schema> | undefined;
  #federatedSchemaVersionCache: string | undefined;
  /**
   * Per-bridge schema cache keyed by the local alias. Populated by
   * `refreshBridgeSchemas()` (opt-in) and surfaced through `federatedSchema()`
   * so multi-ns agents can see bridged types without a second round-trip.
   */
  readonly #bridgeSchemaCache: Map<string, Record<string, Schema>> = new Map();

  constructor(deps: SchemaSubsystemDeps) {
    this.#namespaces = deps.namespaces;
    this.#bridges = deps.bridges;
    this.#isLive = deps.isLive;
    this.#isTombstoned = deps.isTombstoned;
  }

  schemaFor(ns: string): Schema {
    if (this.#isTombstoned(ns)) throw new Error(`unknown namespace '${ns}'`);
    const cfg = this.#namespaces.get(ns);
    if (!cfg) throw new Error(`unknown namespace '${ns}'`);
    // `epoch` is optional on the Registry contract; a decorating registry must
    // forward it by hand. When it is absent, rebuild on every call rather than
    // cache: a missing epoch must cost performance, never serve a stale schema.
    const epoch = cfg.registry.epoch;
    const cached = epoch === undefined ? undefined : this.#schemaCache.get(ns);
    if (cached !== undefined && cached.epoch === epoch) return cached.schema;
    const schema = publishSchema(cfg.registry);
    const withVirtual: Schema = cfg.virtual === true ? { ...schema, virtual: true } : schema;
    // Annotations ride beside the hash, like `virtual`: `publishSchema` hashes
    // only types + mutations, so an annotations change never moves schemaVersion.
    const out: Schema =
      cfg.annotations !== undefined
        ? { ...withVirtual, annotations: cfg.annotations }
        : withVirtual;
    if (epoch !== undefined) this.#schemaCache.set(ns, { epoch, schema: out });
    // A registry that moved invalidates everything derived from it, not just
    // its own entry — the federated map and the version hash both fold in this
    // namespace's schema.
    if (cached !== undefined || epoch === undefined) {
      this.#federatedSchemaCache = undefined;
      this.#federatedSchemaVersionCache = undefined;
    }
    return out;
  }

  federatedSchema(): Record<string, Schema> {
    // Refresh every live namespace FIRST: schemaFor drops the federated caches
    // when it finds a moved epoch, so this both rebuilds the stale entries and
    // decides whether the federated cache below is still usable. Reading the
    // cache before this loop would return a map assembled from schemas that
    // have since been superseded.
    const fresh: Record<string, Schema> = {};
    for (const ns of this.#namespaces.keys()) {
      if (!this.#isLive(ns)) continue;
      fresh[ns] = this.schemaFor(ns);
    }
    if (this.#federatedSchemaCache !== undefined) return this.#federatedSchemaCache;

    const out: Record<string, Schema> = { ...fresh };
    // §5.8: merge cached bridged schemas under their local alias. The bridge
    // alias is the key callers address in frames; the remote's internal ns
    // names are opaque here. If the merge encounters a single bridged remote
    // exposing its own `<alias>` namespace, the local alias wins.
    for (const [alias, bridge] of this.#bridges.entries()) {
      // A bridge never shadows a namespace this server hosts.
      if (this.#namespaces.has(alias)) continue;
      const cached = this.#bridgeSchemaCache.get(alias);
      if (cached === undefined) continue;
      const local = cached[alias];
      if (local !== undefined) {
        out[alias] = local;
      } else {
        const firstRemote = Object.values(cached)[0];
        if (firstRemote !== undefined) out[alias] = firstRemote;
      }
      // Silence unused-binding lint without renaming the iteration pair: the
      // `bridge` reference is used by the refresh surface below.
      void bridge;
    }
    this.#federatedSchemaCache = out;
    return out;
  }

  /**
   * Invalidate the cached federated-schema map and version, plus the per-ns
   * schema cache entry when `ns` is supplied. For external mutators that
   * change a namespace's registered types after construction.
   */
  invalidateSchemaCaches(ns?: string): void {
    this.#federatedSchemaCache = undefined;
    this.#federatedSchemaVersionCache = undefined;
    if (ns !== undefined) this.#schemaCache.delete(ns);
  }

  /**
   * Refresh the cached schemas for every registered bridge. Callers invoke
   * this at composition-root wire-up time to populate `federatedSchema()`'s
   * bridge merge; subsequent drift (schemaVersion change) triggers an auto-
   * refetch via the envelope decoder (§7.1), not this API.
   *
   * Unreachable bridges are skipped silently — reachability is owed to the
   * per-bridge probe, not this surface.
   */
  async refreshBridgeSchemas(): Promise<void> {
    const fetches: Array<Promise<{ alias: string; schema: Record<string, Schema> } | null>> = [];
    for (const [alias, bridge] of this.#bridges.entries()) {
      if (this.#bridges.isUnreachable(alias)) continue;
      fetches.push(
        bridge.federatedSchema().then(
          (schema) => ({ alias, schema }),
          // Best-effort — a bridge that fails to fetch a schema keeps whatever
          // prior cache it had; the next refresh attempt will retry.
          () => null
        )
      );
    }
    const results = await Promise.all(fetches);
    let mutated = false;
    for (const result of results) {
      if (result === null) continue;
      this.#bridgeSchemaCache.set(result.alias, result.schema);
      mutated = true;
    }
    // Invalidate the federated-schema cache so the next caller sees the
    // refreshed bridge entries. The version cache only reads local
    // namespace schemas, so it doesn't need invalidation here.
    if (mutated) this.#federatedSchemaCache = undefined;
  }

  federatedSchemaVersion(): string {
    // Same ordering as federatedSchema: collect first (which refreshes any
    // moved namespace and drops this cache), then read.
    const versions: Record<string, string> = {};
    for (const ns of this.#namespaces.keys()) {
      if (!this.#isLive(ns)) continue;
      versions[ns] = this.schemaFor(ns).schemaVersion;
    }
    if (this.#federatedSchemaVersionCache !== undefined) {
      return this.#federatedSchemaVersionCache;
    }
    const canonical = JSON.stringify(canonicalize(versions));
    const hash = sha256Short(canonical);
    this.#federatedSchemaVersionCache = hash;
    return hash;
  }
}
