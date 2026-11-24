/**
 * Every decision about whether a frame entry may run, and as what: the
 * caller's grant on the namespace, the entry's policy, what a walk may reach,
 * and whether the entry reads or writes. `prepareEntry` settles all of it
 * before a resolver is called; the out-of-band policy probes ask the same
 * questions without dispatching.
 */

import {
  forEachWalkHop,
  type TypeRef,
  usesWalkGrammar,
  walkGrammarPath
} from '@mnmal-ai/substrate-filter';
import type {
  AfterTxWork,
  AutoCrudVerb,
  BridgeRegistry,
  Dataset,
  DatasetRegistry,
  EdgesStore,
  FieldDef,
  FilterWriteLimits,
  FrameEntry,
  Identity,
  PackEnvelope,
  PolicyDecision,
  PolicyProbeContext,
  RegistryEntry,
  RequestContext,
  ResolverArgs,
  WriteEvent
} from '@mnmal-ai/substrate-types';
import {
  grantRefusal,
  grantRefusalCode,
  ROW_POLICY_BLOCKS_WALK,
  WALK_UNSUPPORTED_REF,
  WALKS_IN_MUTATION,
  WALKS_UNSUPPORTED_STORE
} from '@mnmal-ai/substrate-types';
import type { WalkResolvers } from '../filter/walk-validator.js';
import { evaluatePolicy } from '../policy-evaluator.js';
import { hopResolver, type WalkedType, walkedTypes } from '../walk-types.js';
import { isSealedCursor, openCursor } from './cursor-seal.js';
import { type FilterGuardDeps, runFilterGuard } from './filter-guard.js';
import {
  addError,
  checkIdentityGrant,
  type MetricFn,
  type NamespaceConfig,
  type ParsedKey,
  toResolverArgs,
  unknownFrameKeyMessage,
  withCanonicalMetadataFilters,
  withNaturalOrder,
  withNestedNaturalOrder
} from './internals.js';
import type { SchemaSubsystem } from './schema.js';
import type { EngineWalks, WalkScan } from './walks.js';

/**
 * The far type of one walk hop from `near`, read from `fieldsOf`: the type an
 * `in` names, or the target of the crossRef an `out` follows. Undefined for
 * anything else.
 */
function hopFarType(
  node: Record<string, unknown>,
  near: TypeRef,
  fieldsOf: (ref: TypeRef) => Record<string, FieldDef> | undefined
): TypeRef | undefined {
  if (typeof node.in === 'string' && node.out === undefined) {
    const m = /^([^/]+)\/([^./]+)\.[^.]+$/.exec(node.in);
    return m?.[1] !== undefined && m[2] !== undefined ? { ns: m[1], type: m[2] } : undefined;
  }
  if (typeof node.out !== 'string' || node.in !== undefined) return undefined;
  const fields = fieldsOf(near);
  const def =
    fields !== undefined && Object.hasOwn(fields, node.out) ? fields[node.out] : undefined;
  return def?.kind === 'crossRef' ? { ns: def.ns, type: def.type } : undefined;
}

/** Everything the entry runner settles before it calls the resolver. */
export interface PreparedEntry {
  registryEntry: RegistryEntry;
  frame: FrameEntry;
  ctx: RequestContext;
  args: ResolverArgs;
  decision: PolicyDecision;
  ns: string;
  name: string;
  isVirtual: boolean;
  dataset: Dataset | undefined;
  walkScan: WalkScan | undefined;
}

export interface EntryGateDeps {
  namespaces: Map<string, NamespaceConfig>;
  tombstoned: ReadonlySet<string>;
  datasets: DatasetRegistry;
  edges: EdgesStore;
  bridges: BridgeRegistry;
  metric: MetricFn;
  schema: SchemaSubsystem;
  walks: EngineWalks;
  filterWriteLimits: FilterWriteLimits;
  isStoredEntry: (entry: RegistryEntry) => boolean;
  isLive: (ns: string) => boolean;
  typeEntry: (ns: string, type: string) => RegistryEntry | undefined;
}

export class EntryGate {
  readonly #namespaces: Map<string, NamespaceConfig>;
  readonly #tombstoned: ReadonlySet<string>;
  readonly #datasets: DatasetRegistry;
  readonly #edges: EdgesStore;
  readonly #bridges: BridgeRegistry;
  readonly #metric: MetricFn;
  readonly #schema: SchemaSubsystem;
  readonly #walks: EngineWalks;
  readonly #filterWriteLimits: FilterWriteLimits;
  readonly #isStoredEntry: (entry: RegistryEntry) => boolean;
  readonly #isLive: (ns: string) => boolean;
  readonly #typeEntry: (ns: string, type: string) => RegistryEntry | undefined;
  /** Built once rather than per entry: every frame entry reaches the filter guard. */
  readonly #guardDeps: FilterGuardDeps = {
    schemaFor: (ns) => this.#schema.schemaFor(ns),
    invalidateSchemaCaches: (ns) => this.#schema.invalidateSchemaCaches(ns),
    metric: (name, payload) => this.#metric(name, payload)
  };

  constructor(deps: EntryGateDeps) {
    this.#namespaces = deps.namespaces;
    this.#tombstoned = deps.tombstoned;
    this.#datasets = deps.datasets;
    this.#edges = deps.edges;
    this.#bridges = deps.bridges;
    this.#metric = deps.metric;
    this.#schema = deps.schema;
    this.#walks = deps.walks;
    this.#filterWriteLimits = deps.filterWriteLimits;
    this.#isStoredEntry = deps.isStoredEntry;
    this.#isLive = deps.isLive;
    this.#typeEntry = deps.typeEntry;
  }

  /**
   * Shared body of the two out-of-band policy probes. Mirrors runEntry's
   * pre-dispatch checks (tombstone, registry lookup, identity-namespace claim)
   * with a synthetic ctx. Fails closed throughout: an out-of-band surface must
   * never be MORE permissive than dispatch.
   */
  evaluateEntryPolicy(
    ns: string,
    type: string,
    identity: Identity | null,
    operation: 'query' | 'mutate',
    probe: PolicyProbeContext | undefined,
    verb?: AutoCrudVerb,
    args?: ResolverArgs
  ): PolicyDecision {
    if (this.#tombstoned.has(ns)) {
      return { allow: false, reason: `namespace '${ns}' was deleted` };
    }
    const nsCfg = this.#namespaces.get(ns);
    if (!nsCfg) {
      return { allow: false, reason: `unknown namespace '${ns}'` };
    }
    const entry = nsCfg.registry.get(type);
    if (entry?.kind !== 'type') {
      return { allow: false, reason: `unknown type '${type}' in namespace '${ns}'` };
    }
    const nsGate = checkIdentityGrant(identity, ns, operation);
    if (!nsGate.ok) {
      return { allow: false, reason: grantRefusal(ns, nsGate) };
    }
    // Where auth is on, the mutate route admits no caller without an identity,
    // whatever the mode; a probe has no route gate in front of it.
    if (operation === 'mutate' && identity === null && probe?.authEnabled === true) {
      return { allow: false, reason: 'a write needs an identity' };
    }
    const ctx: RequestContext = {
      now: probe?.now ?? new Date(),
      headers: probe?.headers ?? {},
      meta: probe?.meta ?? {},
      ...(probe?.clientIp !== undefined ? { clientIp: probe.clientIp } : {}),
      ...(probe?.authEnabled !== undefined ? { authEnabled: probe.authEnabled } : {}),
      identity,
      namespace: ns,
      operation,
      entry: type,
      ...(verb !== undefined ? { verb } : {})
    };
    return evaluatePolicy(entry.policy, ctx, args ?? {});
  }

  /**
   * Whether every namespace the walks of a bridged query entry reach is one
   * `identity` may read. Each hop is resolved from the schema cached for the
   * bridge. A far namespace other than the entry's own counts as readable only
   * when a bridge to the same peer serves it here under its own name and the
   * caller holds `read` on it, so the walk shows nothing a direct read would
   * not. A hop that cannot be resolved is not readable.
   */
  bridgedWalksReadable(
    alias: string,
    type: string,
    entry: FrameEntry,
    identity: RequestContext['identity'] | null | undefined
  ): boolean {
    const frame = entry as Record<string, unknown>;
    const params = frame.params as Record<string, unknown> | null | undefined;
    const groupBy = params?.groupBy;
    // Walked group keys are read from an object `groupBy` only.
    if (groupBy !== undefined && (typeof groupBy !== 'object' || Array.isArray(groupBy)))
      return false;

    const cached = this.#schema.bridgeSchemas(alias);
    const peer = this.#bridges.get(alias)?.baseUrl;
    const fieldsOf = (ref: TypeRef): Record<string, FieldDef> | undefined => {
      const types = cached?.schemas[ref.ns]?.types;
      return types !== undefined && Object.hasOwn(types, ref.type)
        ? types[ref.type]?.fields
        : undefined;
    };
    const readable = (ns: string): boolean =>
      ns === cached?.ns ||
      (!this.#namespaces.has(ns) &&
        !this.#datasets.has(ns) &&
        peer !== undefined &&
        this.#bridges.get(ns)?.baseUrl === peer &&
        this.#schema.bridgeSchemas(ns)?.ns === ns &&
        checkIdentityGrant(identity, ns, 'query').ok);

    let ok = true;
    forEachWalkHop(frame, { ns: cached?.ns ?? alias, type }, (hop, near) => {
      const far = cached === undefined ? undefined : hopFarType(hop.node, near, fieldsOf);
      if (far !== undefined && readable(far.ns)) return far;
      ok = false;
      return undefined;
    });
    return ok;
  }

  /**
   * §5.12 per-frame grant gate (namespace and capability). Records the refusal
   * under `key` and returns true when `identity` may not run `operation` in
   * `ns`. Bridged keys pass through here too, before they are proxied.
   */
  refuseUngranted(
    envelope: PackEnvelope,
    key: string,
    ns: string,
    identity: RequestContext['identity'] | null | undefined,
    operation: 'query' | 'mutate'
  ): boolean {
    const nsGate = checkIdentityGrant(identity, ns, operation);
    if (nsGate.ok) return false;
    addError(envelope, [key], grantRefusal(ns, nsGate), grantRefusalCode(nsGate));
    this.#metric('engine_unauthorized_namespace', { key, ns, reason: nsGate.reason });
    return true;
  }

  /**
   * What lets a walk seeded on the `seed` dataset leave its namespace, for
   * `identity`: its read grant on the far namespace (the same check as every
   * read gate), then a far type that is stored (or bridged, which the store
   * rule then refuses), then a far namespace whose dataset this engine holds,
   * that is not bridged and that shares the seed's store.
   */
  #walkResolvers(
    identity: RequestContext['identity'] | null | undefined,
    seed: Dataset | undefined
  ): WalkResolvers {
    const storeOf = (d: Dataset) => d.walkStoreId ?? d.txScopeId;
    const bridged = (n: string) => !this.#namespaces.has(n) && this.#bridges.has(n);
    return {
      schemaOf: (n) =>
        this.#isLive(n)
          ? this.#schema.schemaFor(n).types
          : bridged(n)
            ? this.#schema.federatedSchema()[n]?.types
            : undefined,
      canRead: (n) => checkIdentityGrant(identity, n, 'query').ok,
      isStoredType: (ref) => {
        if (bridged(ref.ns)) return true;
        const entry = this.#typeEntry(ref.ns, ref.type);
        return entry !== undefined && this.#isStoredEntry(entry);
      },
      walkable: (n) => {
        // Refuses an unregistered namespace only where the registry has no factory: a factory builds one on `get`.
        const far = bridged(n) ? undefined : this.#datasets.get(n);
        return far !== undefined && seed !== undefined && storeOf(far) === storeOf(seed);
      },
      namespaceNames: [...this.#namespaces.keys()]
    };
  }

  /**
   * Fail-closed policy for walk grammar (spec §2, §3). A walk is a read of
   * every type it touches: each walked, aggregated or nested type's read
   * policy runs in that type's own namespace with the walk's own `where`, and
   * a deny refuses the frame. Any obligation, on a walked type or on the seed,
   * is refused too: obligations filter rows after the read, which cannot reach
   * rows a walk counted, aggregated or joined. A walked type in another
   * namespace must be on a store that answers walks. Records the error and
   * returns true on refusal. A frame that passes with a walk into another
   * namespace carries the federated schema version, as a multi-namespace
   * frame does.
   */
  #refuseWalkPolicy(
    envelope: PackEnvelope,
    key: string,
    frame: FrameEntry,
    ns: string,
    seed: string,
    ctx: RequestContext,
    decision: PolicyDecision,
    walk: WalkResolvers | undefined,
    isVirtual: boolean
  ): boolean {
    const seedPath = walkGrammarPath(frame as Record<string, unknown>);
    if (seedPath === null) return false;
    const blocked = (d: PolicyDecision) => (d.obligations?.length ?? 0) > 0;
    const refuse = (path: string[], message: string, code: string) => {
      addError(envelope, [key, ...path], message, code);
      this.#metric('engine_walk_policy_refused', { key, code, path });
      return true;
    };
    if (blocked(decision)) {
      return refuse(
        seedPath,
        `'${ns}/${seed}' is row-filtered for this caller, so it cannot be walked from, counted or aggregated`,
        ROW_POLICY_BLOCKS_WALK
      );
    }
    // A virtual frame holds no walk (refused earlier), and its own params are its resolver's, not walk hops.
    if (isVirtual) return false;
    const types = this.#schema.schemaFor(ns).types;
    let walked: WalkedType[];
    try {
      walked = walkedTypes(
        frame as Record<string, unknown>,
        { ns, type: seed },
        hopResolver(ns, types, walk)
      );
    } catch {
      // Validation already resolved every hop; one that no longer resolves is refused, not skipped.
      return refuse(seedPath, 'a walk in this frame does not resolve', 'policy_denied');
    }
    for (const { ref, where, unfiltered, path } of walked) {
      if (ref.ns !== ns && this.#datasets.get(ref.ns)?.capabilities.walks !== true) {
        return refuse(path, `the '${ref.ns}' store does not answer walks`, WALKS_UNSUPPORTED_STORE);
      }
      const d = this.evaluateEntryPolicy(
        ref.ns,
        ref.type,
        ctx.identity ?? null,
        'query',
        ctx,
        undefined,
        { params: where !== undefined && unfiltered !== true ? { where } : {} }
      );
      if (!d.allow) return refuse(path, d.reason ?? 'policy denied', 'policy_denied');
      if (blocked(d)) {
        return refuse(
          path,
          `'${ref.ns}/${ref.type}' is row-filtered for this caller, so a walk cannot read it`,
          ROW_POLICY_BLOCKS_WALK
        );
      }
    }
    if (walked.some((w) => w.ref.ns !== ns))
      envelope.schemaVersion = this.#schema.federatedSchemaVersion();
    return false;
  }

  /** An unqualified key's refusal, naming the fix when one is evident. */
  unqualifiedMessage(key: string): string {
    if (key === 'params' || key === 'fields' || key === 'where') {
      return `'${key}' is part of a frame, not a frame key: send { "<ns>/<op>": { "params": {...}, "fields": {...} } }`;
    }
    const owners = [...this.#namespaces].filter(([, cfg]) => cfg.registry.get(key) !== undefined);
    const hint = owners.length === 1 ? ` — did you mean '${owners[0]?.[0]}/${key}'?` : '';
    return `unqualified frame key '${key}' — expected '<ns>/<name>'${hint}`;
  }

  /**
   * Everything a frame entry does before its resolver runs: the grant, the
   * lookups, policy, the walk refusals, the filter guard, the cursor and the
   * resolver args. Synchronous. Returns null once it has recorded a refusal.
   */
  prepareEntry(
    envelope: PackEnvelope,
    key: string,
    entry: FrameEntry,
    ctxBase: Omit<RequestContext, 'namespace'>,
    operation: 'query' | 'mutate',
    tx: Dataset | null,
    txEdges: EdgesStore | null,
    parsed: ParsedKey | null,
    onWrite?: (event: WriteEvent) => void,
    signal?: AbortSignal,
    afterTx?: (fn: AfterTxWork) => void,
    txEntries?: number
  ): PreparedEntry | null {
    if (!parsed) {
      addError(envelope, [key], this.unqualifiedMessage(key), 'unqualified_key');
      this.#metric('engine_unqualified_key', key);
      return null;
    }

    const badKeys = unknownFrameKeyMessage(entry);
    if (badKeys !== null) {
      addError(envelope, [key], badKeys, 'unknown_frame_key');
      this.#metric('engine_unknown_frame_key', key);
      return null;
    }

    const { ns, name } = parsed;

    // §5.12 per-frame grant gate (namespace and capability). Per-key failure —
    // other keys in the same payload still resolve.
    if (this.refuseUngranted(envelope, key, ns, ctxBase.identity, operation)) return null;

    if (this.#tombstoned.has(ns)) {
      addError(envelope, [key], `namespace '${ns}' was deleted`, 'namespace_tombstoned');
      this.#metric('engine_namespace_tombstoned_reject', { key, ns });
      return null;
    }

    const nsCfg = this.#namespaces.get(ns);
    if (!nsCfg) {
      addError(envelope, [key], `unknown namespace '${ns}'`, 'unknown_namespace');
      this.#metric('engine_unknown_namespace', ns);
      return null;
    }

    // Virtual namespaces own no storage: skip the dataset
    // requirement and leave args.dataset undefined. A tx from a mixed mutate
    // payload (a virtual key riding inside another ns's dataset tx) is
    // deliberately NOT threaded — virtual mutations are non-transactional with
    // dataset mutations by contract; the resolver computes from params/fields.
    const isVirtual = nsCfg.virtual === true;
    const dataset = isVirtual ? undefined : (tx ?? this.#datasets.get(ns));
    if (!isVirtual && !dataset) {
      // Query path: we didn't pre-resolve. A namespace registered in
      // `namespaces` but missing from `datasets` is a misconfiguration — same
      // error code as "ns not present at all" so callers have one thing to fix.
      addError(envelope, [key], `unknown namespace '${ns}'`, 'unknown_namespace');
      this.#metric('engine_unknown_namespace', ns);
      return null;
    }

    const registryEntry = nsCfg.registry.get(name);
    if (!registryEntry) {
      addError(envelope, [key], `unknown name '${name}' in namespace '${ns}'`, 'unknown_name');
      this.#metric('engine_unknown_name', { ns, name });
      return null;
    }

    // The gate above judged the route's operation; the entry decides what it
    // does. get<T> is registered as a mutation and is the one that only reads.
    const reads = registryEntry.kind !== 'mutation' || registryEntry.verb === 'get';
    if (operation === 'query' && !reads) {
      // A write here would run with no transaction, unseen by subscribers.
      addError(
        envelope,
        [key],
        `cannot query mutation '${key}' — send it to mutate`,
        'mutation_on_query'
      );
      this.#metric('engine_mutation_on_query', { key });
      return null;
    }
    if (
      operation === 'mutate' &&
      reads &&
      this.refuseUngranted(envelope, key, ns, ctxBase.identity, 'query')
    )
      return null;

    // A by-filter mutation's `where` is a query's `where` on its target type.
    const filterTarget = operation === 'mutate' ? registryEntry.filterTarget : undefined;
    // What lets this read's walks leave `ns`, judged for this caller.
    const walk =
      operation === 'query' &&
      registryEntry.kind === 'type' &&
      usesWalkGrammar(entry as Record<string, unknown>)
        ? this.#walkResolvers(ctxBase.identity, dataset)
        : undefined;
    // Metadata spellings the read path returns (`createdBy`, `_metadata`, …)
    // reach policy, validation and the resolver as the canonical columns.
    const frame =
      operation === 'query' && registryEntry.kind === 'type'
        ? withCanonicalMetadataFilters(
            entry,
            registryEntry.fields,
            walk !== undefined ? this.#walks.metadataHop(ns, name, walk) : undefined
          )
        : filterTarget !== undefined
          ? withCanonicalMetadataFilters(entry, nsCfg.registry.get(filterTarget)?.fields ?? {})
          : entry;

    // Thread the entry name + autoCRUD verb so policies can discriminate
    // resolvers (get<T> vs delete<T> otherwise look identical).
    const ctx: RequestContext = {
      ...ctxBase,
      namespace: ns,
      operation,
      entry: name,
      ...(registryEntry.verb !== undefined ? { verb: registryEntry.verb } : {})
    };
    const args = toResolverArgs(
      frame,
      dataset,
      txEdges ?? this.#edges,
      onWrite,
      signal,
      (ns) => this.#datasets.get(ns),
      afterTx,
      txEntries
    );
    const decision = evaluatePolicy(registryEntry.policy, ctx, args);

    if (!decision.allow) {
      addError(envelope, [key], decision.reason ?? 'policy denied', 'policy_denied');
      this.#metric('engine_policy_denied', { key, reason: decision.reason });
      return null;
    }
    // A row filter reads the whole row, so the substrate must not narrow it to
    // the caller's selection; the transport projects the response.
    if ((decision.obligations?.length ?? 0) > 0) delete args.fields;
    if (filterTarget !== undefined) args.filterWriteLimits = this.#filterWriteLimits;

    // Neither path validates walk grammar, so both refuse it whatever the flag:
    // a mutation's returned-row selection, and a virtual resolver's input.
    if (operation === 'mutate') {
      const walkPath = walkGrammarPath({
        fields: frame.fields,
        ...(filterTarget !== undefined ? { params: { where: frame.params?.where } } : {})
      });
      if (walkPath) {
        addError(
          envelope,
          [key, ...walkPath],
          'walks are not available in a mutation',
          WALKS_IN_MUTATION
        );
        return null;
      }
    } else if (isVirtual) {
      // Only where and fields: a virtual resolver's own params may be named
      // count, aggregate, groupBy, having or offset (#1822).
      const walkPath = walkGrammarPath(frame as Record<string, unknown>, { walkParams: false });
      if (walkPath) {
        addError(
          envelope,
          [key, ...walkPath],
          'walks are not available on virtual types',
          WALK_UNSUPPORTED_REF
        );
        return null;
      }
    }

    if (
      operation === 'query' &&
      registryEntry.kind === 'type' &&
      !isVirtual &&
      // Fail closed: no dataset answers no walks.
      dataset?.capabilities.walks !== true
    ) {
      const walkPath = walkGrammarPath(frame as Record<string, unknown>);
      if (walkPath) {
        addError(
          envelope,
          [key, ...walkPath],
          `the '${ns}' store does not answer walks`,
          WALKS_UNSUPPORTED_STORE
        );
        return null;
      }
    }

    // Filter validation (§5.2) lives in `./filter-guard.js` — same contract:
    // `false` means an error was recorded and dispatch must not proceed.
    const guardOk = runFilterGuard(this.#guardDeps, {
      envelope,
      key,
      entry: frame,
      ns,
      name,
      operation,
      entryKind: registryEntry.kind,
      isVirtual,
      dataset,
      ...(filterTarget !== undefined ? { filterTarget } : {}),
      ...(walk !== undefined ? { walk } : {})
    });
    if (!guardOk) return null;

    if (
      operation === 'query' &&
      registryEntry.kind === 'type' &&
      this.#refuseWalkPolicy(envelope, key, frame, ns, name, ctx, decision, walk, isVirtual)
    ) {
      return null;
    }

    // A query reads in the type's natural order unless it names one.
    if (operation === 'query' && !isVirtual) {
      const params = withNaturalOrder(args.params, registryEntry, dataset);
      if (params !== undefined) args.params = params;
    }

    const cursor = args.params?.cursor;
    if (typeof cursor === 'string') {
      // Under a row filter only a sealed cursor is accepted: that is all this
      // entry ever hands out.
      const filtering = (decision.obligations?.length ?? 0) > 0;
      const opened = filtering && !isSealedCursor(cursor) ? null : openCursor(cursor);
      if (opened === null) {
        addError(envelope, [key], 'cursor is not one this server issued', 'invalid_cursor');
        return null;
      }
      args.params = { ...args.params, cursor: opened };
    }

    const walkScan =
      operation === 'query' && registryEntry.kind === 'type' && !isVirtual
        ? this.#walks.walkSitesOf(frame, ns, name, walk)
        : undefined;
    // A nested walk list reads in its far type's natural order unless it names one (#1821),
    // even when the plan's describer gave up; validation resolved every hop, so this does not throw.
    if (
      operation === 'query' &&
      registryEntry.kind === 'type' &&
      !isVirtual &&
      args.fields !== undefined &&
      usesWalkGrammar(frame as Record<string, unknown>)
    ) {
      const tools = walkScan ?? this.#walks.walkTools(ns, walk);
      args.fields = withNestedNaturalOrder(
        args.fields,
        { ns, type: name },
        tools.resolve,
        tools.naturalOrder
      );
    }
    return {
      registryEntry,
      frame,
      ctx,
      args,
      decision,
      ns,
      name,
      isVirtual,
      dataset,
      walkScan
    };
  }
}
