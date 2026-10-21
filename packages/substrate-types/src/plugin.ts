/**
 * Coordinator plugin primitives. Spec: §5.11.
 *
 * A coordinator plugin is the deployment unit for application-level types. It
 * bundles one or more namespaces (each contributing types, mutations, and
 * resolvers) behind a single name, and declares lifecycle hooks the hosting
 * binary invokes after registration completes.
 *
 * This module is declaration-only. The loader + registry-walk live in
 * `@mnmal-ai/substrate-core`; composition roots (e.g. `apps/substrate`) wire concrete
 * datasets + edges stores into each plugin's `install()` context.
 *
 * `Registry` is the structural contract for a per-namespace type registry;
 * the concrete `Registry` class in `@mnmal-ai/substrate-core` implements it.
 */

import type { Row } from './core.js';
import type { Dataset, ReadResult } from './dataset.js';
import type { EdgesStore } from './edge.js';
import type {
  AutoCrudVerb,
  Identity,
  Policy,
  PolicyDecision,
  PolicyProbeContext,
  RequestContext,
  ResolverArgs
} from './policy.js';
import type { FieldDef, PackEnvelope, Schema } from './schema.js';
import type { HttpHandler, HttpMethod, PluginRouter } from './server.js';

/** Whether a registry entry is a top-level addressable type or a mutation. */
export type RegistryEntryKind = 'type' | 'mutation';

/**
 * postWrite hook signature. Receives the written row and request context;
 * may perform side-effects (e.g. embedding, index updates). Returned promise
 * is awaited before the engine acks the write to the caller.
 */
export type PostWriteHook = (row: Row, ctx: RequestContext) => Promise<void>;

/**
 * Resolver signature stored in a `RegistryEntry`. Identical to the canonical
 * engine-facing `Resolver` in `./policy.ts`; redeclared inline here to keep
 * the registry surface self-describing for the types package. Importers that
 * want the canonical alias should import `Resolver` from this package.
 */
export type RegistryEntryResolver = (
  ctx: RequestContext,
  args: ResolverArgs
) => Promise<Row | Row[] | ReadResult | AsyncIterable<Row> | null> | AsyncIterable<Row>;

/** Input shape for `Registry.register` / `Registry.replace`. */
export interface RegistryEntryInput {
  resolver: RegistryEntryResolver;
  policy?: Policy;
  fields?: Record<string, FieldDef>;
  kind?: RegistryEntryKind;
  params?: Record<string, FieldDef>;
  returns?: FieldDef;
  /**
   * Semantic verb for autoCRUD-registered mutations. The engine
   * threads this into `RequestContext.verb` at dispatch so type-/plugin-level
   * policies can discriminate get/create/update/delete without entry-name
   * string matching. Omit for type entries and custom mutations.
   */
  verb?: AutoCrudVerb;
}

/**
 * Stored shape returned by `Registry.get` and `Registry.all`. Mirrors the
 * concrete `RegistryEntry` in `@mnmal-ai/substrate-core` — the engine reads
 * `policy`, `kind`, `resolver`, `fields`, `params`, and `returns` off this
 * shape on every dispatch.
 */
export interface RegistryEntry {
  resolver: RegistryEntryResolver;
  policy: Policy;
  fields: Record<string, FieldDef>;
  kind: RegistryEntryKind;
  /** Always present — `{}` for `kind: 'type'` entries where the concept doesn't apply. */
  params: Record<string, FieldDef>;
  /** Present only for `kind: 'mutation'` entries that declared a return shape. */
  returns?: FieldDef;
  /** Mirrors `RegistryEntryInput.verb` — present when the registrant stamped one. */
  verb?: AutoCrudVerb;
}

/**
 * Canonical per-namespace registry surface, implemented by the concrete
 * `Registry` class in `@mnmal-ai/substrate-core`.
 */
export interface Registry {
  register(key: string | { readonly name: string }, input: RegistryEntryInput): void;
  replace(key: string | { readonly name: string }, input: RegistryEntryInput): void;
  /**
   * Read back a registered entry. Returns undefined when the entry is absent.
   * The full `RegistryEntry` shape (resolver, policy, kind, fields, params,
   * returns) is exposed because the engine reads every field on dispatch.
   */
  get(key: string | { readonly name: string }): RegistryEntry | undefined;
  /** Presence check. Returns true iff `key` is registered. */
  has(key: string | { readonly name: string }): boolean;
  /** Iterate every `[name, entry]` pair. Used by the schema publisher. */
  all(): IterableIterator<[string, RegistryEntry]>;
  /**
   * Remove an entry. Optional: only a registry that can take back a live
   * apply (a schema proposal rolled back with its transaction) offers it.
   */
  unregister?(key: string | { readonly name: string }): void;
  /**
   * Monotonic mutation counter — incremented by every `register` / `replace` / `unregister`.
   * Lets a consumer cache anything derived from the registry (the published
   * schema, above all) and detect staleness from the data, without relying on
   * every registrant remembering to call `engine.invalidateSchemaCaches`.
   *
   * Optional so third-party `Registry` implementations remain valid; consumers
   * fall back to callback-driven invalidation when it is absent.
   */
  readonly epoch?: number | undefined;
}

/**
 * Base class binding the `epoch` bookkeeping so an implementation cannot forget
 * it. Subclasses supply storage via `performRegister` / `performReplace` and
 * never implement `register` / `replace` themselves, so the counter is advanced
 * by construction rather than by discipline.
 *
 * A throw from `performRegister` leaves the epoch untouched, which is correct:
 * a rejected registration changed nothing.
 *
 * Decorators cannot extend this — they wrap an instance rather than subclass it
 * — so a wrapping registry must forward `epoch` from the wrapped instance. See
 * `substrate-compose`'s `_system` install for the worked example.
 */
export abstract class RegistryBase implements Registry {
  #epoch = 0;

  get epoch(): number {
    return this.#epoch;
  }

  register(key: string | { readonly name: string }, input: RegistryEntryInput): void {
    this.performRegister(key, input);
    this.#epoch++;
  }

  replace(key: string | { readonly name: string }, input: RegistryEntryInput): void {
    this.performReplace(key, input);
    this.#epoch++;
  }

  unregister(key: string | { readonly name: string }): void {
    this.performUnregister(key);
    this.#epoch++;
  }

  /** Store a new entry. Throw to reject; the epoch will not advance. */
  protected abstract performRegister(
    key: string | { readonly name: string },
    input: RegistryEntryInput
  ): void;

  /** Overwrite an existing entry. Throw to reject; the epoch will not advance. */
  protected abstract performReplace(
    key: string | { readonly name: string },
    input: RegistryEntryInput
  ): void;

  /** Remove an entry. Not abstract, so existing subclasses stay valid; they refuse. */
  protected performUnregister(key: string | { readonly name: string }): void {
    throw new Error(
      `unregister is not supported by this registry ('${typeof key === 'string' ? key : key.name}')`
    );
  }

  abstract get(key: string | { readonly name: string }): RegistryEntry | undefined;
  abstract has(key: string | { readonly name: string }): boolean;
  abstract all(): IterableIterator<[string, RegistryEntry]>;
}

/** See `EngineHandle.addDropParticipant`. */
export interface DropParticipant {
  /** Namespaces whose datasets `onDrop` writes, opened in the drop's transaction. */
  readonly namespaces: readonly string[];
  /** `datasetFor` returns the transaction-bound dataset of one of `namespaces`. */
  onDrop(ns: string, datasetFor: (ns: string) => Dataset): Promise<void>;
}

export interface NamespaceInstallContext {
  registry: Registry;
  dataset: Dataset;
  edges: EdgesStore;
  /**
   * Plugin-global policy composed from the owning plugin's `policies` array
   * (undefined when the plugin declares none). Namespace install
   * implementations SHOULD compose this with any namespace-scoped or per-type
   * policies via `and()` so plugin-level invariants apply across every
   * resolver the namespace contributes. `defineNamespace` in
   * `@mnmal-ai/substrate-sdk` does this automatically.
   */
  pluginPolicy?: Policy;
  /**
   * Substrate-plugin contributions to per-type postWrite chains. Map
   * `typeName → PostWriteHook[]`. Engine populates by walking each
   * composed substrate plugin's `contributePostWrites(namespace)` and
   * merging results. Hooks run AFTER the type's inline postWrite in
   * declaration order. Empty map / undefined = no contributions.
   */
  postWriteContributions?: Record<string, PostWriteHook[]>;
}

/**
 * Read-side context passed to `NamespaceTypeDef.embed.source` when the
 * substrate composing the embedding (e.g. substrate-recall) has a dataset
 * resolver wired. Lets the source function pull related-entity context
 * via crossRefs (e.g. inline a linked Concept's name into the embedded
 * text so semantic recall surfaces relevant rows).
 *
 * Minimal by design — `read` is the only method, and it returns the
 * first matching row or `null`. Source functions that don't need
 * crossRef enrichment ignore the parameter.
 */
export interface EmbedSourceContext {
  read: (namespace: string, type: string, params: { id: string }) => Promise<Row | null>;
}

/**
 * Structural shape of a type definition, mirroring `TypeInput` from
 * @mnmal-ai/substrate-sdk (redeclared to avoid a substrate-types → substrate-sdk import
 * cycle). Substrate plugins read it structurally; slots not named here pass
 * through opaquely.
 */
export interface NamespaceTypeDef {
  fields: Record<string, FieldDef>;
  postWrite?: (row: Row, ctx: RequestContext) => Promise<void>;
  embed?: {
    /**
     * Produce the source text fed to the embedder for this row, or `null` /
     * `undefined` to declare the row un-indexable.
     *
     * The null sentinel is a RETRIEVAL POLICY, not an absence of text: it
     * means "this row exists and must be referenceable, but must never enter
     * the recall candidate set". The composing substrate both declines to
     * index the row AND removes any embedding it already has, so a row that
     * flips to un-indexable after being written stops being recallable
     * without being deleted.
     *
     * `''` is NOT the sentinel — an empty string embeds normally. Returning
     * `''` to mean "skip" indexes every such row at the same point in the
     * vector space.
     *
     * `ctx` is optional — when the composing substrate has a dataset
     * resolver wired, source functions may call `ctx.read(ns, type,
     * { id })` to inline related-entity context. When `ctx` is undefined,
     * the source must work from `row` alone. Async return is supported
     * so source functions can await crossRef reads.
     */
    source: (
      row: Row,
      ctx?: EmbedSourceContext
    ) => string | null | undefined | Promise<string | null | undefined>;
  };
  /**
   * Produce the text fed to the LEXICAL (keyword) index for this row, with the
   * same `null` / `undefined` un-indexable sentinel as `embed.source`.
   *
   * A sibling of `embed` rather than a flag on it, because the two indexes
   * want different text: `embed.source` conventionally takes a short handle
   * (`synopsis || body`), which drops proper nouns a keyword index needs.
   * `lexical.source` is where the long form goes.
   *
   * A type may declare either, both, or neither. Both is the expected shape for
   * a store whose handle is shorter than its content.
   */
  lexical?: {
    source: (row: Row) => string | null | undefined | Promise<string | null | undefined>;
  };
  // [key: string]: unknown absorbs slots NamespaceTypeDef doesn't name
  // (policy, autoCrud, purgeable, adminCapability, etc.).
  [key: string]: unknown;
}

export interface NamespaceDefinition {
  namespace: string;
  /**
   * Type definitions registered under this namespace, keyed by type name.
   * Read-only metadata exposed for substrate plugins that need to walk
   * the type surface at coordinator-namespace install time (e.g.
   * substrate-recall reads `types[T].embed?.source` to contribute embedding
   * postWrite hooks). Populated by `defineNamespace`; absent on hand-crafted
   * `NamespaceDefinition` objects that bypass the SDK helper.
   */
  types?: Readonly<Record<string, NamespaceTypeDef>>;
  /**
   * Opaque per-consumer metadata, keyed by consumer (e.g. `nl`). Core never
   * interprets it; it is passed through to the namespace schema unchanged.
   */
  annotations?: Readonly<Record<string, unknown>>;
  /**
   * Body keys a SQL dataset mirrors into dedicated `rows` columns, so filters
   * and sorts on them hit an index. The declaring plugin creates the columns in
   * its kernel migrations; the engine creates none. `column` is a bare
   * identifier.
   */
  promotedColumns?: Readonly<Record<string, { column: string; kind: 'boolean' | 'text' }>>;
  /**
   * Install types + mutations + policies into the registry. Invoked once at
   * registration time, BEFORE the engine is constructed. The plugin owns the
   * dataset handle it uses for resolver closures; wiring datasets into the
   * engine's `DatasetRegistry` is the app composition root's job.
   */
  install(ctx: NamespaceInstallContext): void | Promise<void>;
}

export interface PluginLifecycleContext {
  /**
   * Tagged-union discriminant. Differentiates this context from
   * the structurally-similar `KernelLifecycleContext` so a coordinator's
   * `onStart` handler is type-incompatible with a substrate's
   * `onKernelReady` handler — the composition root sets this, and plugins
   * can also branch on it at runtime if a single helper handles both
   * lifecycle stages.
   */
  readonly lifecycle: 'coordinator';
  /**
   * Structured metric/log sink — the hosting binary picks the concrete surface
   * (stdout JSON, Prometheus counter, OpenTelemetry span, …). Plugins MUST NOT
   * assume the sink is synchronous or observable; the contract is fire-and-
   * forget per call.
   */
  metric(name: string, payload?: unknown): void;
  /**
   * Engine handle threaded into `onStart` so plugins that mutate their
   * registry post-construction (e.g. substrate-proposals' applyType /
   * applyField paths) can wire `engine.invalidateSchemaCaches(ns)` into
   * their replace flow. Engine construction completes before `onStart`
   * fires, so the handle is always live here.
   */
  engine: EngineHandle;
}

/**
 * Engine-facing input shape for `query` / `mutate` / `subscribe` / `stream`.
 * Declared here (rather than in substrate-core) so plugin surfaces can reference
 * the engine's call shape as a type without importing the engine package —
 * substrate-types stays zero-runtime.
 */
export interface FrameEntry {
  params?: Record<string, unknown>;
  fields?: Record<string, unknown>;
  /**
   * §5.13 dedup key. Present on a mutate frame entry opts the whole frame
   * into the engine's idempotency store; a repeat call with the same key
   * inside the TTL returns the cached envelope verbatim.
   */
  idempotencyKey?: string;
}

/**
 * Qualified frame (§4.7). Keys are `<ns>/<name>`. `<name>` is the type entry
 * name for query, or the mutation name for mutate.
 *
 * Batched mutate (§5.13): a mutate op-key MAY carry an array of `FrameEntry`
 * values. All frames under one op-key run serially inside the SAME
 * transaction — all-or-nothing per op-key, committed independently of other
 * op-keys. Single-frame op-keys share one transaction when they share a
 * substrate and are refused (`cross_tx_scope_refused`) when they do not.
 * Query / subscribe / stream op-keys reject array values.
 */
export type QualifiedFrame = Record<string, FrameEntry | Array<FrameEntry>>;

export interface EngineInput {
  frame: QualifiedFrame;
  ctx: Partial<RequestContext>;
  /**
   * §5.13 cancellation. Threaded into each resolver via `args.signal` so
   * resolvers observe cancel by polling `signal.aborted` or registering an
   * `abort` listener.
   */
  signal?: AbortSignal;
  /**
   * Page bounds for list reads, set by a transport serving remote callers:
   * a type read with no `limit` gets `defaultLimit`, one above `maxLimit` is
   * refused. Absent for in-process callers, which read what they ask for.
   */
  pageLimits?: { readonly defaultLimit: number; readonly maxLimit: number };
}

/**
 * Per-namespace engine configuration. substrate-core imports this type rather
 * than redeclaring it.
 */
export interface NamespaceConfig {
  registry: Registry;
  /**
   * Marks a substrate-contributed namespace. Virtual namespaces
   * have NO dataset: the engine skips the dataset-presence check on
   * dispatch and leaves `args.dataset` undefined — resolvers compute from
   * `params`/`fields` and MUST NOT reach for a dataset handle. They are
   * structurally incapable of autoCRUD/storage — coordinators own data,
   * substrate surfaces own computation. Subscribe refuses these namespaces
   * with `subscription_unsupported_frame`.
   */
  virtual?: boolean;
  /** From `NamespaceDefinition.annotations`; surfaced on the schema, never hashed. */
  annotations?: Readonly<Record<string, unknown>>;
}

/**
 * Narrow engine handle threaded into scheduled-task / plugin-route contexts.
 * The concrete `Engine` class in `@mnmal-ai/substrate-core` satisfies this
 * structurally; plugin code binds against this handle without importing the
 * engine package.
 */
export interface EngineHandle {
  query(input: EngineInput): Promise<PackEnvelope>;
  mutate(input: EngineInput): Promise<PackEnvelope>;
  /**
   * Evaluate the read policy for a type entry without dispatching it.
   * Out-of-band read surfaces (kernel routes returning row data
   * outside frame dispatch — e.g. /substrate/v1/recall) call this so the same
   * composed policies that gate `query` gate them too. Fails closed on
   * unknown namespace/type and tombstoned namespaces.
   */
  evaluateReadPolicy(
    ns: string,
    type: string,
    identity: Identity | null,
    probe?: PolicyProbeContext
  ): PolicyDecision;
  /**
   * Invalidate cached schema outputs after an out-of-band registry mutation
   * (e.g. `applyTypeProposal` / `applyFieldProposal` calling
   * `Registry.replace`). Without this hook, `federatedSchema()` and
   * `schemaFor(ns)` keep returning pre-mutation views. Optional `ns` argument also drops the per-namespace `schemaFor` cache;
   * omit to invalidate only the federated outputs.
   */
  invalidateSchemaCaches(ns?: string): void;
  /**
   * Register a new namespace at runtime. Throws on collision or on a
   * tombstoned name. Used by substrate-proposals' propose_namespace verb to provision
   * per-user / per-tenant namespaces without binary restart. Caller (typically
   * the resolver) is responsible for FPP semantics; this method is the
   * mechanical primitive.
   */
  addNamespace(ns: string, config: NamespaceConfig): void;
  /**
   * Mark a namespace as tombstoned. After this call:
   *   - schemaFor(ns) throws `unknown namespace`
   *   - federatedSchema() omits the ns
   *   - query / mutate / subscribe against the ns return a per-key
   *     `namespace_tombstoned` error
   *   - existing live subscriptions on the ns are closed with a
   *     `namespace_tombstoned` error frame
   *
   * Idempotent. The underlying NamespaceConfig stays in `#namespaces` for
   * concurrency safety (in-flight ops keep their references) — full physical
   * reclaim happens at engine restart, gated by whatever persistence layer
   * the host uses to decide which namespaces to re-install at boot. Tombstone
   * state itself is in-memory; restart wipes it.
   */
  tombstoneNamespace(ns: string): void;
  /**
   * Be told, after the fact, each time a namespace is tombstoned (a drop), so
   * a plugin that installed it can retire what it owns. A listener's throw is
   * reported as a metric and does not reach the dropper. Returns a disposer.
   */
  onNamespaceTombstoned(listener: (ns: string) => void): () => void;
  /**
   * Take part in every namespace drop's transaction: the drop route opens
   * `participant.namespaces` in its transaction too and runs `onDrop` after
   * the rows are gone and before it commits, so a throw rolls the drop back.
   * Returns a disposer.
   */
  addDropParticipant(participant: DropParticipant): () => void;
  /** The participants `addDropParticipant` registered, for the drop route. */
  dropParticipants(): readonly DropParticipant[];
  /**
   * Take a namespace off the engine and free its name for `addNamespace`.
   * Subscriptions on it close, its schema disappears, new ops answer
   * `unknown_namespace`; in-flight ops keep their resolved config. Undoes a
   * runtime add, e.g. a rolled-back propose_namespace. Idempotent.
   */
  removeNamespace(ns: string): void;
  /** Whether `ns` is on the engine, and if so whether it is still served. */
  namespaceState(ns: string): 'absent' | 'live' | 'tombstoned';
  /**
   * Construct a fresh empty Registry that the engine can accept via
   * `addNamespace`. Plugins call this to provision new namespaces at runtime
   * without taking a runtime dep on the concrete Registry class in substrate-core.
   */
  createRegistry(): Registry;
  /**
   * Look up the host-registered dataset for a namespace, or `undefined` if the
   * host has not provisioned one. Thin pass-through to the engine's
   * `DatasetRegistry.get`, surfaced on the handle so plugins running on
   * dynamically-added namespaces can resolve datasets without the host having
   * to plumb a `datasetFor` lookup through plugin config.
   *
   * Substrate selection remains the host's responsibility — this method only
   * exposes the lookup. Plugins that hot-add namespaces (substrate-proposals'
   * `propose_namespace`) MUST require the host to register the dataset before
   * the call; this method returns `undefined` for unregistered namespaces.
   */
  datasetFor(namespace: string): Dataset | undefined;
}

/**
 * Engine surface needed by substrate-pack-aware route helpers — extends the
 * dispatch handle with the two methods compose's `serializeEnvelope` /
 * `mutateRoute` need to drive positional encoding. The concrete
 * `Engine` class satisfies this structurally; tests + alt
 * implementations can satisfy it without depending on the engine package.
 */
export interface EncodeContext extends EngineHandle {
  /** Federated schema map (per-namespace Schema) for substrate-pack encoding. */
  federatedSchema(): Record<string, Schema>;
  /**
   * Look up a namespace's mutation-return registry view. Returns undefined
   * when the namespace isn't registered. The mutate route uses this to
   * resolve each frame key's `returns` FieldDef for positional encoding.
   */
  registryFor(
    namespace: string
  ): { get(name: string): { returns?: FieldDef } | undefined } | undefined;
}

/**
 * Context threaded into every `ScheduledTask.handler` call.
 */
export interface ScheduledTaskContext {
  /** The owning plugin's `name`. */
  pluginName: string;
  /** Engine handle for read/write work performed by the task. */
  engine: EngineHandle;
  /** Structured metric sink — fire-and-forget. */
  metric(name: string, payload?: unknown): void;
}

export interface ScheduledTask {
  /** Unique identifier within the plugin. Used in metric labels. */
  name: string;
  /** Fire interval in milliseconds. Minimum 100ms — smaller throws at register. */
  intervalMs: number;
  /** Fire once at registration in addition to the interval ticks. Default false. */
  runOnStart?: boolean;
  /** Handler — receives a context with engine access for read/write work. */
  handler(ctx: ScheduledTaskContext): void | Promise<void>;
}

/**
 * Context threaded into `CoordinatorPlugin.routes()` calls.
 */
export interface PluginRouteContext {
  /** The owning plugin's `name`. */
  pluginName: string;
  /** Engine handle for plugin-scoped routes that need to dispatch back through the engine. */
  engine: EngineHandle;
  /** Structured metric sink — fire-and-forget. */
  metric(name: string, payload?: unknown): void;
}

export interface CoordinatorPlugin {
  name: string;
  namespaces: NamespaceDefinition[];
  /**
   * Plugin's bound contract version: a semver RANGE over the binary version,
   * e.g. `'>=4.1.0 <6.0.0'`.
   *
   * The ceiling tracks actual compatibility, not the next major: it moves
   * only when a major genuinely breaks the plugin-facing interface. A ceiling
   * that admits a major which did break lets the plugin load and misbehave
   * silently — if you cannot say whether the last major broke the plugin
   * interface, do not widen it.
   *
   * Enforced at boot: a plugin whose range excludes the running binary is
   * refused.
   */
  contractVersion: string;
  /**
   * Plugin-global policies applied to every resolver in every namespace the
   * plugin contributes. Composed by the loader via `and(...)` — the combined
   * policy must allow. Useful for cross-cutting concerns (audit logging,
   * rate limits, identity enrichment) that span multiple namespaces in the
   * same plugin. The composed result is surfaced through
   * `NamespaceInstallContext.pluginPolicy`.
   */
  policies?: Policy[];
  /**
   * Post-register lifecycle hook. Fires after every plugin's `install()`
   * resolves — use this for resource priming that needs the full namespace
   * map (e.g. cross-plugin edge warmup).
   */
  onStart?(ctx: PluginLifecycleContext): void | Promise<void>;
  /**
   * Pre-shutdown lifecycle hook. Fires when the host calls `compose()`'s
   * returned `stop()` (which the binary's SIGTERM handler invokes inside
   * the `SUBSTRATE_SHUTDOWN_GRACE_MS` window). Hooks run in REVERSE
   * registration order so plugins tear down in the inverse of the order
   * they came up — late-loading plugins that depended on earlier ones get
   * to release their handles first.
   *
   * Use for resources the OS won't reap on process exit:
   *   - subprocess children that should receive SIGTERM cleanly
   *   - long-lived `setInterval` timers (`.unref()` keeps them from
   *     blocking exit, but explicit teardown is still cleaner for tests)
   *   - WebSocket subscriptions / outbound connections that should close
   *     cooperatively rather than dropping mid-request
   *
   * Errors are caught + logged via the lifecycle metric sink under
   * `plugin_on_stop_error` — one plugin's failed teardown does NOT abort
   * other plugins' teardown. The engine + pg pool are still live during
   * onStop calls, so plugins can do final writes (e.g. an audit row
   * recording the shutdown). After all onStop hooks resolve, the server
   * stops accepting connections and the substrate's `closeStore()` runs.
   *
   * Symmetric to `onStart`. Skipped (no-op) when omitted.
   */
  onStop?(ctx: PluginLifecycleContext): void | Promise<void>;
  /**
   * Scheduled tasks — the binary ticks these on `.unref()`'d intervals.
   * Registered with the shared `TaskScheduler` at compose time and started
   * after the server's `start()` resolves.
   */
  schedule?: ScheduledTask[];
  /**
   * Mount plugin-scoped HTTP/WS routes. Called once at compose-time with a
   * `PluginRouter` pre-prefixed `/substrate/v1/plugins/<name>` by the server impl. The
   * router surface matches `PluginRouter` in `./server.ts`.
   *
   * With auth on, HTTP routes require `read` for GET and `mutate` otherwise,
   * granted in one of this plugin's `namespaces`; a plugin with no namespaces
   * accepts the capability granted in any namespace.
   */
  routes?(router: PluginRouter, ctx: PluginRouteContext): void | Promise<void>;
  /**
   * Optional onboarding contribution. When set, the hosting binary's
   * `GET /substrate/v1/onboard` aggregates this record under
   * `instructions.plugins.<name>` and enumerates the plugin's conventional
   * `/substrate/v1/plugins/<name>/onboard` route under `instructions.pluginRoutes`. Use
   * this to teach agents about the plugin's types, write flows, or any
   * plugin-specific grammar a cold-start agent would otherwise have to
   * discover per endpoint. The shape is free-form — the binary round-trips
   * it verbatim.
   */
  onboardInstructions?: Record<string, unknown>;
}

/**
 * Substrate-tier plugin. Augments the kernel rather than the agent-facing
 * surface. Composes BEFORE coordinator plugins so coordinators can rely on
 * substrate registrations being live.
 *
 * SubstratePlugins do NOT own data namespaces — that's a CoordinatorPlugin
 * concern (a substrate may claim a virtual `kernelNamespace`).
 */
export interface KernelPlugin {
  /** Unique plugin name. Used in metric labels + collision detection. */
  name: string;

  /**
   * Plugin's bound contract version: a semver RANGE over the binary version,
   * e.g. `'>=4.1.0 <6.0.0'`. Required on substrate plugins. Checked by
   * `composeFromManifests` and REFUSED at boot on mismatch; the
   * ceiling tracks actual compatibility rather than the next major boundary.
   * See the note on `CoordinatorPlugin.contractVersion` for both.
   */
  contractVersion: string;

  /**
   * Schema migrations the plugin contributes. Applied in declared order
   * on first install AND on every binary boot (idempotently, gated by
   * the migrations tracking table seeded by the first KernelPlugin
   * to populate this slot).
   */
  migrations?: KernelMigration[];

  /**
   * Filter operators contributed to the where-clause grammar. Each entry
   * registers a custom operator (e.g. `embeddingSimilar`) the engine's
   * query validator + substrate executor can dispatch to.
   */
  filterOperators?: Record<string, FilterOperatorDef>;

  /**
   * Top-level kernel route claims. Plugin reserves a path under /substrate/v1/.
   * First-claim wins; collision = boot refusal with actionable error.
   */
  kernelRoutes?: KernelRouteClaim[];

  /**
   * Top-level MCP tool registrations. Tool name registers globally with
   * the MCP server (no /plugins/ prefix on MCP — tools are flat).
   */
  mcpTools?: McpToolRegistration[];

  /**
   * Frame-surface contribution. Claims one namespace in the engine registry
   * carrying resolver-backed query types + mutations — no dataset, no
   * autoCRUD. Dispatch/policy/idempotency/pack/schema/NL/MCP all inherit from
   * the normal frame path.
   */
  kernelNamespace?: KernelNamespaceContribution;

  /**
   * Post-register lifecycle hook. Fires after every KernelPlugin's
   * migrations + registrations resolve, BEFORE any coordinator plugin
   * composes. Use for resource priming the kernel needs before
   * coordinators arrive.
   */
  onKernelReady?(ctx: KernelLifecycleContext): void | Promise<void>;

  /**
   * Contribute postWrite hooks for a coordinator namespace at install time.
   * Called by the engine ONCE per registered coordinator namespace, AFTER
   * substrate composition completes. Returned hooks are merged into the
   * type's effective postWrite chain alongside the type's own inline
   * `postWrite` (if any). Substrate-supplied hooks run AFTER the type's
   * inline hook in chain order.
   *
   * Use this to inspect `namespace.types[T].embed` and emit embedding
   * hooks per type without coupling the binary to plugin internals.
   *
   * Returns: a record mapping type names to PostWriteHook contributions.
   * Type names not in the record receive no contribution.
   */
  contributePostWrites?: (namespace: NamespaceDefinition) => Record<string, PostWriteHook>;
}

/** Single migration unit. */
export interface KernelMigration {
  /** Unique id within the plugin. Stored in migrations tracking table. */
  id: string;
  /** Apply migration. Called only when this migration's id is absent from the migrations table. */
  apply(ctx: KernelMigrationContext): Promise<void>;
  /** Inverse — drops what apply created. */
  rollback?(ctx: KernelMigrationContext): Promise<void>;
}

export interface KernelMigrationContext {
  /**
   * Direct SQL handle for postgres-backed deployments; null when the
   * binary is running against the in-memory dataset.
   */
  sql: unknown | null;
  metric(name: string, payload?: unknown): void;
}

/**
 * Where-clause operator extension.
 *
 * The operator's name is the Record key it's registered under in
 * `KernelPlugin.filterOperators`.
 *
 * `execute` is awaited by the pre-resolve pass (`@mnmal-ai/substrate-filter`'s
 * `preResolveExtensionOperatorsDetailed`) and must resolve to an ordered,
 * scored `{ hits: [{ id: string; score: number; vector?: number[] }, ...] }`
 * envelope; any other shape throws `ExtensionOperatorResultError`. Relevance
 * order is preserved in the rewritten `id IN`, and score/vector are surfaced
 * via the pre-pass meta side-channel for the datasets to stitch onto rows.
 */
export interface FilterOperatorDef {
  validate(value: unknown): { ok: true; value: unknown } | { ok: false; reason: string };
  execute(value: unknown, context: unknown): Promise<unknown>;
  /**
   * Computed projection field names the operator contributes per hit (e.g.
   * `['_score', '_vector']`). The engine refuses a projection of one of these
   * fields unless its operator is in the where-clause.
   */
  computedFields?: string[];
}

/**
 * Query-only virtual type contributed by a substrate plugin.
 * `fields` reuses the FieldDef DSL so schema publication + client typing
 * work unchanged. The resolver receives the standard (ctx, args) pair; the
 * engine leaves `args.dataset` undefined for virtual namespaces — resolvers
 * compute from `params`/`fields` and MUST NOT reach for a dataset handle.
 */
export interface VirtualTypeDef {
  fields: Record<string, FieldDef>;
  resolver: RegistryEntryResolver;
}

/** Mutation contributed by a substrate plugin under its virtual namespace. */
export interface VirtualMutationDef {
  resolver: RegistryEntryResolver;
  /** Optional params schema published into the namespace schema. */
  params?: Record<string, FieldDef>;
}

/**
 * A substrate plugin's claimed frame surface.
 * Registered into the engine's namespaces map as `{ registry, virtual: true }`.
 * Collision posture mirrors KernelRouteClaim: second claim = boot refusal.
 */
export interface KernelNamespaceContribution {
  namespace: string;
  // VirtualTypeDef and VirtualMutationDef are distinguished by container key (types vs mutations), not by shape — do not flatten these into one collection.
  types?: Record<string, VirtualTypeDef>;
  mutations?: Record<string, VirtualMutationDef>;
}

/** Top-level kernel route reservation. */
export interface KernelRouteClaim {
  path: string;
  method: HttpMethod;
  handler: HttpHandler;
  /**
   * Capability the host must check before dispatching, when auth is enabled.
   * REQUIRED — `'public'` is how a route opts out, so opting out is a
   * declaration rather than an omission.
   *
   * Do not make this optional: kernel routes mount via the host's raw
   * `server.route`, which applies no gate of its own, so a route with no
   * capability would get no auth wrapper at all.
   */
  capability: 'read' | 'mutate' | 'admin' | 'public';
}

/** Top-level MCP tool registration. */
export interface McpToolRegistration {
  name: string;
  description: string;
  inputSchema: unknown;
  handler(input: unknown): Promise<unknown>;
}

export interface KernelLifecycleContext {
  /**
   * Tagged-union discriminant. Differentiates this context from the
   * structurally-similar `PluginLifecycleContext`, which would otherwise be
   * interchangeable under structural typing.
   */
  readonly lifecycle: 'kernel';
  /**
   * Direct SQL handle; null when the binary runs against the in-memory
   * dataset. Same shape and same null semantics as
   * `KernelMigrationContext.sql`.
   *
   * For convergent, run-every-boot reconciliation: a migration runs only once
   * per `id`, so it cannot re-scope objects it already created.
   */
  sql: unknown | null;
  /**
   * Namespaces DECLARED by the coordinator plugins this binary loaded, in
   * load order. Empty when none are configured.
   *
   * Declared, not installed: coordinators compose AFTER substrate, so the
   * engine has not yet registered them.
   *
   * Read these rather than adding a namespace knob to substrate config, which
   * could silently disagree with what the coordinator uses.
   */
  coordinatorNamespaces: readonly string[];
  /**
   * The same namespaces, attributed to the coordinator that declared each.
   * Declaration order preserved within a plugin.
   *
   * The two absent cases differ and consumers must branch on them:
   *   - `undefined` — this host does not supply attribution (e.g. an older
   *     binary); do not treat it as an empty list
   *   - `[]` — attribution supplied, and there are no coordinators
   *
   * Filtering on `plugin === 'some-name'` makes the coordinator's `name` a
   * contract term: hold it in one constant shared with the coordinator and pin
   * it with a test, or a rename makes the filter silently match nothing.
   */
  coordinatorNamespacesByPlugin?: readonly { plugin: string; namespace: string }[];
  metric(name: string, payload?: unknown): void;
}
