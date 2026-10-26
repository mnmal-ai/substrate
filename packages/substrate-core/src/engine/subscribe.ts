/**
 * SubscribeSubsystem — owns the live subscription bus and WriteEvent fanout
 * (§5.4, §5.13). Mutate feeds it through `dispatchWrite(event)`.
 */

import { evaluateWhere, whereContainsExtensionOperator } from '@mnmal-ai/substrate-filter';
import type {
  DatasetRegistry,
  EdgesStore,
  FieldInput,
  FrameEntry,
  OrderByClause,
  ReadResult,
  RequestContext,
  Row,
  RowFilterObligation,
  Schema,
  WhereClause,
  WriteEvent,
  WsResponseFrame
} from '@mnmal-ai/substrate-types';
import {
  isResolverFrameError,
  normaliseVocabWhere,
  WS_CODE_SUBSCRIPTION_UNSUPPORTED_FRAME,
  WS_REASON_SUBSCRIPTION_OVERLOADED
} from '@mnmal-ai/substrate-types';
import { FilterValidationError, validateFilter } from '../filter/validator.js';
import { applyObligations, evaluatePolicy } from '../policy-evaluator.js';
import {
  checkIdentityGrant,
  clientErrorMessage,
  deliverFrame,
  isAsyncIterable,
  type MetricFn,
  type NamespaceConfig,
  normaliseToRows,
  obligationsPermitRow,
  parseQualifiedKey,
  type SubscribeInput,
  type SubscriptionCancelReason,
  type SubscriptionEntry,
  type SubscriptionEntryStat,
  type SubscriptionHandle,
  type SubscriptionStatsSnapshot,
  toResolverArgs,
  withCanonicalMetadataFilters,
  withNaturalOrder
} from './internals.js';

/**
 * Documented top-level params keys for a subscribe frame. Anything else is
 * rejected with `unknown_param` rather than silently dropped, so a typo like
 * `order` for `orderBy` is caught.
 */
const MAX_SNAPSHOT_PAGES = 100;
/** A row-filtered snapshot reads at most this many snapshot-sized reads' worth of rows. */
const SNAPSHOT_SCAN_FACTOR = 10;

/** The read's next-page cursor, when it says more rows follow. */
function nextCursorOf(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const page = result as Partial<ReadResult>;
  return page.hasMore === true && typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
}

function asRows(
  result: Row | Row[] | ReadResult | AsyncIterable<Row> | null
): Row | Row[] | ReadResult | null {
  return isAsyncIterable<Row>(result) ? null : result;
}

const KNOWN_SUBSCRIBE_PARAMS: ReadonlySet<string> = new Set([
  'where',
  'orderBy',
  '_allowTableScan'
]);

export interface SubscribeSubsystemDeps {
  namespaces: Map<string, NamespaceConfig>;
  datasets: DatasetRegistry;
  edges: EdgesStore;
  metric: MetricFn;
  subscriptionQueueLimit: number;
  /** Most rows a type snapshot may hold; unset is unbounded. */
  snapshotLimit?: number;
  /** Schema accessor; a callback because importing Engine would be circular. */
  schemaFor: (ns: string) => Schema;
  /** Tombstone accessor; a subscription to a tombstoned ns is refused upfront. */
  isTombstoned: (ns: string) => boolean;
}

export class SubscribeSubsystem {
  readonly #namespaces: Map<string, NamespaceConfig>;
  readonly #datasets: DatasetRegistry;
  readonly #edges: EdgesStore;
  readonly #metric: MetricFn;
  readonly #subscriptionQueueLimit: number;
  readonly #snapshotLimit: number | undefined;
  readonly #schemaFor: (ns: string) => Schema;
  readonly #isTombstoned: (ns: string) => boolean;
  /**
   * Live subscription bus (§5.4). Keyed by `"<ns>/<type>"` so the mutate
   * fanout can match (ns, type) in O(1) against incoming `WriteEvent`s without
   * walking every registered subscription.
   */
  readonly #subscriptions: Map<string, Set<SubscriptionEntry>> = new Map();
  /**
   * Reverse index: `subscribe()` call (its entries' `group`) → all entries it
   * registered across every (ns, type) bucket. A single `subscribe()` call can
   * register entries in multiple namespaces (one per frame key); this map
   * lets `closeForNamespace` reach and tear down the **whole** logical
   * subscription when any one of its namespaces is tombstoned — preventing
   * sibling entries in other namespaces from being orphaned.
   *
   * Maintained in lock-step with `#subscriptions`:
   *   register → push into both maps
   *   cancel   → remove from both maps
   *   close    → remove from both maps
   *   overload → remove from both maps
   */
  readonly #entriesByGroup: Map<object, Set<SubscriptionEntry>> = new Map();

  constructor(deps: SubscribeSubsystemDeps) {
    this.#namespaces = deps.namespaces;
    this.#datasets = deps.datasets;
    this.#edges = deps.edges;
    this.#metric = deps.metric;
    this.#subscriptionQueueLimit = deps.subscriptionQueueLimit;
    this.#snapshotLimit = deps.snapshotLimit;
    this.#schemaFor = deps.schemaFor;
    this.#isTombstoned = deps.isTombstoned;
  }

  /**
   * Live count of registered subscription entries across every (ns, type)
   * bucket. A single logical subscribe() spanning N namespaces counts as N
   * entries — this is the entry-level gauge, the same granularity the
   * back-pressure + teardown paths operate on. Maintained in lock-step with
   * register/cancel/close/overload, so it is always current.
   */
  subscriptionCount(): number {
    let n = 0;
    for (const bucket of this.#subscriptions.values()) n += bucket.size;
    return n;
  }

  /**
   * Snapshot of per-entry queue depths. Consumed by the runtime-stats superset
   * so `GET /substrate/v1/metrics` can expose queue back-pressure without polling the
   * subscription map directly.
   */
  subscriptionStats(): SubscriptionStatsSnapshot {
    const entries: SubscriptionEntryStat[] = [];
    let maxQueueDepth = 0;
    for (const bucket of this.#subscriptions.values()) {
      for (const entry of bucket) {
        entries.push({
          id: entry.id,
          ns: entry.ns,
          type: entry.type,
          queueLength: entry.queue.length
        });
        if (entry.queue.length > maxQueueDepth) maxQueueDepth = entry.queue.length;
      }
    }
    return { count: entries.length, maxQueueDepth, entries };
  }

  /**
   * Tear down every logical subscription that has at least one entry on `ns`,
   * emitting one error frame per logical id. Idempotent.
   *
   * Tears down ALL of the id's entries, across every namespace: the client
   * treats any `error` frame as terminal for the whole subscription, so
   * sibling entries left behind would leak against a dead `onFrame`.
   */
  closeForNamespace(ns: string, code: string): void {
    const prefix = `${ns}/`;

    // Collect the logical subscriptions with at least one entry on this ns,
    // each once even if it spans several types within the namespace.
    const affected = new Set<object>();
    for (const [busKey, bucket] of this.#subscriptions) {
      if (!busKey.startsWith(prefix)) continue;
      for (const entry of bucket) {
        if (!entry.closed) affected.add(entry.group);
      }
    }

    // For each affected logical subscription: emit one error frame, then tear
    // down every entry it registered (across all namespaces).
    for (const group of affected) {
      const allEntries = this.#entriesByGroup.get(group);
      if (!allEntries) continue;

      // Emit one consolidated error frame for the logical subscription.
      // Use the first non-closed entry's onFrame (all share the same
      // onFrame since they came from the same subscribe() call).
      const representative = [...allEntries].find((e) => !e.closed);
      const frameId = representative?.id ?? '';
      if (representative) {
        try {
          deliverFrame(
            representative.onFrame,
            {
              id: frameId,
              kind: 'error',
              errors: [{ message: `namespace '${ns}' was deleted`, code, path: [`${ns}/`] }]
            },
            this.#metric
          );
        } catch (err) {
          // onFrame is consumer-supplied; a throw must not abort teardown.
          this.#metric('subscribe_close_frame_throw', {
            frameId,
            ns,
            code,
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }

      // Tear down ALL entries for this logical id, regardless of namespace.
      for (const entry of allEntries) {
        entry.closed = true;
        const busKey = `${entry.ns}/${entry.type}`;
        const bucket = this.#subscriptions.get(busKey);
        if (bucket) {
          bucket.delete(entry);
          if (bucket.size === 0) this.#subscriptions.delete(busKey);
        }
      }
      this.#entriesByGroup.delete(group);
      // Emit once per logical subscription id after full teardown.
      this.#metric('engine_subscription_closed_namespace_tombstoned', { id: frameId, ns });
    }
  }

  async subscribe(input: SubscribeInput): Promise<SubscriptionHandle> {
    const entries: SubscriptionEntry[] = [];
    const ctxBase = this.#buildSubscribeContext(input.ctx);
    const group = {};

    try {
      await this.#registerFrame(input, ctxBase, group, entries);
    } catch (err) {
      // No handle reaches the caller, so nothing could ever cancel these. The
      // group also holds an entry whose own snapshot emit threw.
      for (const entry of [...(this.#entriesByGroup.get(group) ?? [])]) {
        entry.closed = true;
        this.#unregisterEntry(entry);
      }
      throw err;
    }

    return {
      id: input.id,
      cancel: (reason: SubscriptionCancelReason = 'cancel'): void => {
        // Guard double-cancel: only emit the metric if at least one entry was
        // still open. A second call on an already-torn-down handle must not
        // double-count the metric.
        let anyOpen = false;
        for (const entry of entries) {
          if (!entry.closed) anyOpen = true;
          entry.closed = true;
          this.#unregisterEntry(entry);
        }
        // Emit exactly ONE metric per logical teardown, only on first cancel.
        if (anyOpen) {
          this.#metric(`engine_subscription_closed_${reason}`, { id: input.id });
        }
      }
    };
  }

  async #registerFrame(
    input: SubscribeInput,
    ctxBase: Omit<RequestContext, 'namespace'>,
    group: object,
    entries: SubscriptionEntry[]
  ): Promise<void> {
    for (const [key, frameEntry] of Object.entries(input.frame)) {
      // §5.13 batched mutate is mutate-only. Array values on a subscribe
      // surface are rejected up-front with a dedicated error code.
      if (Array.isArray(frameEntry)) {
        deliverFrame(
          input.onFrame,
          {
            id: input.id,
            kind: 'error',
            errors: [
              {
                message: `batched frame arrays are not supported on subscribe (op-key '${key}')`,
                code: 'batched_not_supported',
                path: [key]
              }
            ]
          },
          this.#metric
        );
        this.#metric('engine_batched_not_supported', { op: 'subscribe', key });
        continue;
      }
      const registered = await this.#registerSubscriptionEntry(
        input,
        key,
        frameEntry,
        ctxBase,
        group
      );
      if (registered !== null) entries.push(registered);
    }
  }

  /**
   * Fan-out step called once per `WriteEvent` emitted during a successful
   * `engine.mutate`. For every subscription targeting the event's (ns, type):
   *   - `delete` → emit `remove` if the id was previously matching;
   *   - `create` / `update` with a matching row → emit `add` (new id) or
   *     `update` (known id);
   *   - `create` / `update` with a non-matching row → emit `remove` if the id
   *     was previously matching; otherwise nothing.
   *
   * Row-filter obligations apply to live pushes symmetrically with the
   * snapshot path. A row the policy would have redacted at query time is also
   * withheld from pushes.
   *
   * §5.13 back-pressure: frame delivery is enqueue-per-entry with a lazy
   * drain task serialising `onFrame`. A slow consumer cannot stall
   * `engine.mutate` — the mutate caller just enqueues and returns. When the
   * enqueue would push the queue beyond the engine's `queueLimit`, the entry
   * is torn down and dropped from the bus.
   */
  dispatchWrite(event: WriteEvent): void {
    const busKey = `${event.ns}/${event.type}`;
    const bucket = this.#subscriptions.get(busKey);
    if (!bucket || bucket.size === 0) return;

    for (const entry of bucket) {
      if (entry.closed) continue;
      this.#emitToSubscription(entry, event);
    }
  }

  #buildSubscribeContext(caller: Partial<RequestContext>): Omit<RequestContext, 'namespace'> {
    const base: Omit<RequestContext, 'namespace'> = {
      identity: caller.identity ?? null,
      operation: 'subscribe',
      now: caller.now ?? new Date(),
      headers: caller.headers ?? {},
      meta: caller.meta ?? {}
    };
    if (caller.clientIp !== undefined) base.clientIp = caller.clientIp;
    return base;
  }

  /**
   * Register one (ns, type) subscription and emit its initial snapshot via
   * `input.onFrame`. Returns the entry on success; returns null when
   * validation, policy, or resolver issues prevent registration (an error
   * frame has already been emitted in those cases).
   */
  async #registerSubscriptionEntry(
    input: SubscribeInput,
    key: string,
    frameEntry: FrameEntry,
    ctxBase: Omit<RequestContext, 'namespace'>,
    group: object
  ): Promise<SubscriptionEntry | null> {
    const parsed = parseQualifiedKey(key);
    if (!parsed) {
      deliverFrame(
        input.onFrame,
        {
          id: input.id,
          kind: 'error',
          errors: [
            {
              message: `unqualified frame key '${key}' — expected '<ns>/<name>'`,
              code: 'unqualified_key',
              path: [key]
            }
          ]
        },
        this.#metric
      );
      return null;
    }
    const { ns, name } = parsed;

    // §5.12 Phase 1: subscription-time namespace gate. Mirrors the query /
    // mutate path so a WS subscribe frame can't reach a resolver in a
    // namespace the token wasn't scoped to.
    const nsGate = checkIdentityGrant(ctxBase.identity, ns, 'subscribe');
    if (!nsGate.ok) {
      deliverFrame(
        input.onFrame,
        {
          id: input.id,
          kind: 'error',
          errors: [
            {
              message: `namespace '${ns}' not in identity's allowed namespaces`,
              code: 'unauthorized_namespace',
              path: [key]
            }
          ]
        },
        this.#metric
      );
      return null;
    }

    if (this.#isTombstoned(ns)) {
      this.#metric('engine_namespace_tombstoned_reject', { key, ns });
      deliverFrame(
        input.onFrame,
        {
          id: input.id,
          kind: 'error',
          errors: [
            {
              message: `namespace '${ns}' was deleted`,
              code: 'namespace_tombstoned',
              path: [key]
            }
          ]
        },
        this.#metric
      );
      return null;
    }

    const nsCfg = this.#namespaces.get(ns);
    if (!nsCfg) {
      deliverFrame(
        input.onFrame,
        {
          id: input.id,
          kind: 'error',
          errors: [{ message: `unknown namespace '${ns}'`, code: 'unknown_namespace', path: [key] }]
        },
        this.#metric
      );
      return null;
    }

    // One-shot-only surfaces: virtual namespaces have no write stream and
    // extension-operator filters have no incremental evaluation, so both are
    // refused at registration. Checked BEFORE the dataset lookup so a virtual
    // namespace doesn't get unknown_namespace.
    if (nsCfg.virtual === true) {
      deliverFrame(
        input.onFrame,
        {
          id: input.id,
          kind: 'error',
          errors: [
            {
              message: `cannot subscribe to virtual namespace '${ns}' — one-shot query/mutate only`,
              code: WS_CODE_SUBSCRIPTION_UNSUPPORTED_FRAME,
              path: [key]
            }
          ]
        },
        this.#metric
      );
      this.#metric('engine_subscription_unsupported_frame', { key, reason: 'virtual_namespace' });
      return null;
    }
    const subWhere = (frameEntry.params as { where?: unknown } | undefined)?.where;
    if (whereContainsExtensionOperator(subWhere)) {
      deliverFrame(
        input.onFrame,
        {
          id: input.id,
          kind: 'error',
          errors: [
            {
              message:
                'subscription where-clause contains an extension operator — semantic filters are one-shot only',
              code: WS_CODE_SUBSCRIPTION_UNSUPPORTED_FRAME,
              path: [key]
            }
          ]
        },
        this.#metric
      );
      this.#metric('engine_subscription_unsupported_frame', { key, reason: 'extension_operator' });
      return null;
    }

    const dataset = this.#datasets.get(ns);
    if (!dataset) {
      deliverFrame(
        input.onFrame,
        {
          id: input.id,
          kind: 'error',
          errors: [{ message: `unknown namespace '${ns}'`, code: 'unknown_namespace', path: [key] }]
        },
        this.#metric
      );
      return null;
    }

    const registryEntry = nsCfg.registry.get(name);
    if (!registryEntry) {
      deliverFrame(
        input.onFrame,
        {
          id: input.id,
          kind: 'error',
          errors: [
            {
              message: `unknown name '${name}' in namespace '${ns}'`,
              code: 'unknown_name',
              path: [key]
            }
          ]
        },
        this.#metric
      );
      return null;
    }

    if (registryEntry.kind !== 'type') {
      deliverFrame(
        input.onFrame,
        {
          id: input.id,
          kind: 'error',
          errors: [
            {
              message: `cannot subscribe to mutation '${name}'`,
              code: 'subscribe_on_mutation',
              path: [key]
            }
          ]
        },
        this.#metric
      );
      return null;
    }

    // Thread entry/verb, as engine.#runEntry does.
    const ctx: RequestContext = {
      ...ctxBase,
      namespace: ns,
      entry: name,
      ...(registryEntry.verb !== undefined ? { verb: registryEntry.verb } : {})
    };
    // Metadata spellings reach policy, validation, the snapshot resolver and
    // the live matcher as the canonical columns, as in a query.
    const frame = withCanonicalMetadataFilters(frameEntry, registryEntry.fields);
    const args = toResolverArgs(frame, dataset, this.#edges);
    const decision = evaluatePolicy(registryEntry.policy, ctx, args);
    if (!decision.allow) {
      deliverFrame(
        input.onFrame,
        {
          id: input.id,
          kind: 'error',
          errors: [
            { message: decision.reason ?? 'policy denied', code: 'policy_denied', path: [key] }
          ]
        },
        this.#metric
      );
      return null;
    }
    // A row filter reads the whole row, so the substrate must not narrow it to
    // the caller's selection; the transport projects the response.
    if ((decision.obligations?.length ?? 0) > 0) delete args.fields;

    const params = frame.params;
    if (params) {
      for (const paramKey of Object.keys(params)) {
        if (!KNOWN_SUBSCRIBE_PARAMS.has(paramKey)) {
          const allowed = [...KNOWN_SUBSCRIBE_PARAMS].sort();
          deliverFrame(
            input.onFrame,
            {
              id: input.id,
              kind: 'error',
              errors: [
                {
                  message: `subscribe('${ns}/${name}'): unknown param '${paramKey}'. Allowed: ${allowed.join(', ')}.`,
                  code: 'unknown_param',
                  path: [key, 'params', paramKey]
                }
              ]
            },
            this.#metric
          );
          return null;
        }
      }
    }
    // Aliases in a governed vocabulary match their canonical value, as in a query.
    const typeFields = this.#schemaFor(ns).types[name]?.fields;
    const rawWhere = params?.where as WhereClause | undefined;
    const where =
      rawWhere !== undefined && typeFields !== undefined
        ? (normaliseVocabWhere(rawWhere, typeFields) as WhereClause)
        : rawWhere;
    const orderBy = params?.orderBy as OrderByClause[] | undefined;
    if (where !== undefined || orderBy !== undefined) {
      const schema = this.#schemaFor(ns);
      const typeSchema = schema.types[name];
      if (typeSchema) {
        try {
          validateFilter({
            ...(where !== undefined ? { where } : {}),
            ...(orderBy !== undefined ? { orderBy } : {}),
            typeSchema,
            capabilities: dataset.capabilities
          });
        } catch (err) {
          if (err instanceof FilterValidationError) {
            deliverFrame(
              input.onFrame,
              {
                id: input.id,
                kind: 'error',
                errors: [{ message: err.message, code: err.code, path: [key, ...err.path] }]
              },
              this.#metric
            );
            return null;
          }
          throw err;
        }
      }
    }

    // Register the entry BEFORE running the snapshot resolver, so a write
    // committing during the resolver is not lost. `snapshotReady: false` makes
    // the fanout buffer those events until the snapshot ships, so pushes never
    // precede it.
    const rowFilterObs = (decision.obligations ?? []).filter(
      (o): o is RowFilterObligation => o.kind === 'row-filter'
    );
    const schemaVersion = this.#schemaFor(ns).schemaVersion;
    const fields = (frameEntry.fields ?? {}) as FieldInput;
    const subscriptionEntry: SubscriptionEntry = {
      id: input.id,
      group,
      ns,
      type: name,
      fields,
      where,
      orderBy,
      onFrame: input.onFrame,
      obligations: rowFilterObs,
      ctx,
      schemaVersion,
      currentRowIds: new Set<Row['id']>(),
      queue: [],
      draining: false,
      closed: false,
      snapshotReady: false,
      pendingEvents: []
    };
    this.#registerEntry(subscriptionEntry);

    // The snapshot reads in the type's natural order unless it names one, as a query does.
    const ordered = withNaturalOrder(args.params, registryEntry, dataset);
    if (ordered !== undefined) args.params = ordered;
    // One row past the cap is enough to tell the snapshot is too large.
    const snapshotLimit = registryEntry.kind === 'type' ? this.#snapshotLimit : undefined;
    if (snapshotLimit !== undefined) args.params = { ...args.params, limit: snapshotLimit + 1 };

    // Run the resolver for the initial snapshot. Throws surface as error
    // frames — subscriptions don't have a transaction to roll back. Any
    // post-registration bail-out must unregister the entry first.
    let result: Row | Row[] | ReadResult | AsyncIterable<Row> | null;
    // Under a row filter the cap counts visible rows, so the snapshot reads on
    // past hidden ones, page by page, keeping only the rows the caller may see.
    const extraPages: Row[][] = [];
    let scanTruncated = false;
    try {
      result = await registryEntry.resolver(ctx, args);
      let next = rowFilterObs.length > 0 ? nextCursorOf(result) : undefined;
      const firstRows = rowFilterObs.length > 0 ? normaliseToRows(asRows(result)) : [];
      let visible = applyObligations(decision, firstRows, ctx).length;
      let scanned = firstRows.length;
      const maxScanned = SNAPSHOT_SCAN_FACTOR * ((snapshotLimit ?? 0) + 1);
      // shortcut: a row-filtered snapshot scans at most SNAPSHOT_SCAN_FACTOR reads' worth of rows (and MAX_SNAPSHOT_PAGES pages), then refuses as too large; raise it if callers see far fewer rows than exist.
      while (
        snapshotLimit !== undefined &&
        next !== undefined &&
        visible <= snapshotLimit &&
        scanned < maxScanned &&
        extraPages.length < MAX_SNAPSHOT_PAGES
      ) {
        const page = await registryEntry.resolver(ctx, {
          ...args,
          params: { ...args.params, cursor: next }
        });
        const pageRows = normaliseToRows(asRows(page));
        scanned += pageRows.length;
        const kept = applyObligations(decision, pageRows, ctx);
        extraPages.push(kept);
        visible += kept.length;
        next = nextCursorOf(page);
      }
      scanTruncated = next !== undefined && visible <= (snapshotLimit ?? Number.POSITIVE_INFINITY);
    } catch (err) {
      this.#unregisterEntry(subscriptionEntry);
      const code = isResolverFrameError(err) ? err.code : 'resolver_error';
      const details = isResolverFrameError(err) ? err.details : undefined;
      const errEntry: {
        message: string;
        code: string;
        path: string[];
        details?: Record<string, unknown>;
      } = {
        message: clientErrorMessage(err, this.#metric, key),
        code,
        path: [key]
      };
      if (details !== undefined) errEntry.details = details;
      deliverFrame(
        input.onFrame,
        {
          id: input.id,
          kind: 'error',
          errors: [errEntry]
        },
        this.#metric
      );
      return null;
    }

    // Torn down while the snapshot read ran (overload or tombstone): its
    // terminal frames are already out, so a snapshot now would follow its `end`.
    if (subscriptionEntry.closed) return null;

    // Async-iterable returns are the §5.5 stream contract — subscriptions
    // don't consume them. Surface a dedicated error so callers pointing a
    // stream-shaped resolver at `subscribe` get a clear signal instead of a
    // silent empty snapshot.
    if (isAsyncIterable<Row>(result)) {
      this.#unregisterEntry(subscriptionEntry);
      deliverFrame(
        input.onFrame,
        {
          id: input.id,
          kind: 'error',
          errors: [
            {
              message: `resolver for '${key}' returned an async iterable; use engine.stream instead`,
              code: 'streamable_on_oneshot',
              path: [key]
            }
          ]
        },
        this.#metric
      );
      return null;
    }

    // Snapshots are always lists. A resolver that returns `null` or a single
    // row is treated as an empty / one-element list for subscription purposes
    // — the client expects to track a set of matching rows over time.
    const rows = [...normaliseToRows(result), ...extraPages.flat()];
    const filtered = applyObligations(decision, rows, ctx);
    if (snapshotLimit !== undefined && (filtered.length > snapshotLimit || scanTruncated)) {
      this.#unregisterEntry(subscriptionEntry);
      deliverFrame(
        input.onFrame,
        {
          id: input.id,
          kind: 'error',
          errors: [
            {
              message: scanTruncated
                ? `snapshot for '${key}' reads too many rows to find the ones you may see; narrow the subscription with where`
                : `snapshot for '${key}' exceeds ${snapshotLimit} rows; narrow the subscription with where`,
              code: 'snapshot_too_large',
              path: [key]
            }
          ]
        },
        this.#metric
      );
      return null;
    }
    for (const row of filtered) subscriptionEntry.currentRowIds.add(row.id);

    // Emit the snapshot, then open the gate: flip snapshotReady and replay any
    // events buffered while the resolver ran. The snapshot frame is delivered
    // before any replayed push, preserving "snapshot first, pushes after".
    deliverFrame(
      input.onFrame,
      {
        id: input.id,
        kind: 'snapshot',
        schemaVersion,
        data: { [key]: filtered },
        shapes: { [key]: 'list' }
      },
      this.#metric,
      () => {
        // A snapshot the transport could not deliver ends the subscription.
        subscriptionEntry.closed = true;
        this.#unregisterEntry(subscriptionEntry);
        deliverFrame(
          input.onFrame,
          {
            id: input.id,
            kind: 'error',
            errors: [
              {
                message: `snapshot for '${key}' could not be delivered`,
                code: 'snapshot_delivery_failed',
                path: [key]
              }
            ]
          },
          this.#metric
        );
      }
    );

    subscriptionEntry.snapshotReady = true;
    this.#replayPendingEvents(subscriptionEntry);

    return subscriptionEntry;
  }

  /** Register an entry on the bus + per-call reverse index. */
  #registerEntry(entry: SubscriptionEntry): void {
    const busKey = `${entry.ns}/${entry.type}`;
    let bucket = this.#subscriptions.get(busKey);
    if (!bucket) {
      bucket = new Set();
      this.#subscriptions.set(busKey, bucket);
    }
    bucket.add(entry);
    let idSet = this.#entriesByGroup.get(entry.group);
    if (!idSet) {
      idSet = new Set();
      this.#entriesByGroup.set(entry.group, idSet);
    }
    idSet.add(entry);
  }

  /**
   * Remove an entry from the bus + per-call index (mirrors the drain teardown).
   * Used when a post-registration step bails before the snapshot ships.
   */
  #unregisterEntry(entry: SubscriptionEntry): void {
    const busKey = `${entry.ns}/${entry.type}`;
    const bucket = this.#subscriptions.get(busKey);
    if (bucket) {
      bucket.delete(entry);
      if (bucket.size === 0) this.#subscriptions.delete(busKey);
    }
    const idSet = this.#entriesByGroup.get(entry.group);
    if (idSet) {
      idSet.delete(entry);
      if (idSet.size === 0) this.#entriesByGroup.delete(entry.group);
    }
  }

  /**
   * Drain events buffered during registration through the normal emit path now
   * that the snapshot has shipped and currentRowIds is populated. Runs
   * synchronously right after the snapshot emit, so no new event can interleave.
   */
  #replayPendingEvents(entry: SubscriptionEntry): void {
    if (entry.pendingEvents.length === 0) return;
    const buffered = entry.pendingEvents.splice(0, entry.pendingEvents.length);
    for (const event of buffered) {
      if (entry.closed) break;
      this.#emitToSubscription(entry, event);
    }
  }

  #emitToSubscription(entry: SubscriptionEntry, event: WriteEvent): void {
    // Until the snapshot is emitted, buffer the raw event. The
    // entry is on the bus during the resolver (so nothing is lost), but
    // `currentRowIds` isn't populated yet and pushes must not precede the
    // snapshot — `#replayPendingEvents` drains the buffer once the snapshot ships.
    if (!entry.snapshotReady) {
      // The buffer answers to the same limit as the queue it drains into.
      if (entry.pendingEvents.length >= this.#subscriptionQueueLimit) {
        this.#overloadSubscription(entry);
        return;
      }
      entry.pendingEvents.push(event);
      return;
    }
    if (event.operation === 'delete') {
      if (entry.currentRowIds.has(event.id)) {
        entry.currentRowIds.delete(event.id);
        this.#enqueueFrame(entry, {
          id: entry.id,
          kind: 'remove',
          schemaVersion: entry.schemaVersion,
          removedId: event.id
        });
      }
      return;
    }

    // create / update. No row (the autoCRUD shape guarantees one on success)
    // means we can't filter-test — treat as a no-op.
    const row = event.row;
    if (row === undefined) return;

    const obligationsAllow = obligationsPermitRow(entry.obligations, entry.ctx, row);
    // The where-clause was validated at subscribe time, but the evaluator
    // throws on an unhonourable predicate. Contain it: tell THIS subscriber
    // and drop it, rather than let the throw escape the fan-out loop and take
    // the other subscribers with it.
    let whereMatches: boolean;
    try {
      const fields = this.#schemaFor(entry.ns).types[entry.type]?.fields;
      whereMatches =
        entry.where === undefined ? true : evaluateWhere(row, entry.where, (f) => fields?.[f]);
    } catch (err) {
      const code = isResolverFrameError(err) ? err.code : 'resolver_error';
      this.#enqueueFrame(entry, {
        id: entry.id,
        kind: 'error',
        errors: [
          {
            message: clientErrorMessage(err, this.#metric, `${entry.ns}/${entry.type}`),
            code,
            path: [`${entry.ns}/${entry.type}`]
          }
        ]
      });
      this.#unregisterEntry(entry);
      return;
    }
    const visible = obligationsAllow && whereMatches;

    const key = `${entry.ns}/${entry.type}`;
    const data = { [key]: row };
    const shapes = { [key]: 'single' as const };

    if (visible) {
      if (entry.currentRowIds.has(event.id)) {
        this.#enqueueFrame(entry, {
          id: entry.id,
          kind: 'update',
          schemaVersion: entry.schemaVersion,
          data,
          shapes
        });
      } else {
        entry.currentRowIds.add(event.id);
        this.#enqueueFrame(entry, {
          id: entry.id,
          kind: 'add',
          schemaVersion: entry.schemaVersion,
          data,
          shapes
        });
      }
    } else if (entry.currentRowIds.has(event.id)) {
      entry.currentRowIds.delete(event.id);
      this.#enqueueFrame(entry, {
        id: entry.id,
        kind: 'remove',
        schemaVersion: entry.schemaVersion,
        removedId: event.id
      });
    }
  }

  /**
   * Enqueue a frame for `entry`. When the queue is already at the back-
   * pressure limit, the entry is torn down instead of accepting another
   * frame. The drain task is spawned lazily — once it drains the queue it
   * exits, and the next enqueue respawns it. Frame ordering is preserved
   * because the queue is FIFO and the drain is single-flight.
   */
  #enqueueFrame(entry: SubscriptionEntry, frame: WsResponseFrame): void {
    if (entry.closed) return;
    if (entry.queue.length >= this.#subscriptionQueueLimit) {
      this.#overloadSubscription(entry);
      return;
    }
    entry.queue.push(frame);
    if (!entry.draining) {
      entry.draining = true;
      void this.#drainSubscription(entry);
    }
  }

  async #drainSubscription(entry: SubscriptionEntry): Promise<void> {
    try {
      while (entry.queue.length > 0 && !entry.closed) {
        const frame = entry.queue.shift() as WsResponseFrame;
        try {
          await entry.onFrame(frame);
        } catch {
          // A consumer that rejects on a data frame is behaving as if the
          // queue drained — we just drop the error and continue draining. If
          // it keeps rejecting the queue will eventually breach the limit and
          // the entry tears down.
        }
      }
    } finally {
      entry.draining = false;
    }
  }

  /**
   * Tear down a subscription that breached the queue threshold. Emits one
   * final `subscription_overloaded` error frame followed by an `end` frame
   * carrying `reason: WS_REASON_SUBSCRIPTION_OVERLOADED`, drops the entry from
   * the bus, and marks it closed so the drain task exits. The final frames are
   * fire-and-forget — an overloaded consumer is unlikely to honour them, but
   * transports that read the final error can at least log.
   */
  #overloadSubscription(entry: SubscriptionEntry): void {
    if (entry.closed) return;
    entry.closed = true;
    this.#unregisterEntry(entry);
    // Drop any still-queued frames — they belong to a subscription the engine
    // no longer recognises and we don't want the drain loop to keep calling
    // `onFrame` for a torn-down entry.
    entry.queue.length = 0;
    entry.pendingEvents.length = 0;
    this.#metric('engine_subscription_overloaded', {
      id: entry.id,
      ns: entry.ns,
      type: entry.type,
      queueLimit: this.#subscriptionQueueLimit
    });
    // Per-reason closed counter, alongside the overload metric above.
    this.#metric('engine_subscription_closed_overloaded', {
      id: entry.id,
      ns: entry.ns,
      type: entry.type
    });
    // Fire-and-forget the terminal frames. We dispatch these directly (not via
    // the queue) because the queue is the source of the overload and the
    // entry is already closed to further enqueues.
    void (async (): Promise<void> => {
      try {
        await entry.onFrame({
          id: entry.id,
          kind: 'error',
          errors: [
            {
              message: `subscription '${entry.id}' queue threshold exceeded`,
              code: WS_REASON_SUBSCRIPTION_OVERLOADED
            }
          ]
        });
        await entry.onFrame({
          id: entry.id,
          kind: 'end',
          final: true,
          reason: WS_REASON_SUBSCRIPTION_OVERLOADED
        });
      } catch {
        // Overloaded consumers routinely reject the terminal frames. That's
        // the cost of the back-pressure contract — no retry here.
      }
    })();
  }
}
