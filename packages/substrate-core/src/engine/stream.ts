/**
 * StreamSubsystem — owns the §5.5 stream dispatch: drives an async-iterable
 * resolver, emits a `chunk` frame per yielded row (post row-filter
 * obligations), and terminates with `end` / `error`. Independent of the
 * subscription bus. Takes its engine slice via `StreamSubsystemDeps` and never
 * imports `Engine`.
 */

import type {
  DatasetRegistry,
  EdgesStore,
  FrameEntry,
  OrderByClause,
  ReadResult,
  RequestContext,
  ResolverArgs,
  Row,
  RowFilterObligation,
  Schema,
  WhereClause,
  WsResponseFrame
} from '@mnmal-ai/substrate-types';
import {
  isResolverFrameError,
  WS_CODE_SUBSCRIPTION_UNSUPPORTED_FRAME
} from '@mnmal-ai/substrate-types';
import { FilterValidationError, validateFilter } from '../filter/validator.js';
import { evaluatePolicy } from '../policy-evaluator.js';
import {
  checkIdentityGrant,
  clientErrorMessage,
  deliverFrame,
  isAsyncIterable,
  type MetricFn,
  type NamespaceConfig,
  obligationsPermitRow,
  parseQualifiedKey,
  type StreamHandle,
  type StreamInput,
  withCanonicalMetadataFilters
} from './internals.js';

export interface StreamSubsystemDeps {
  namespaces: Map<string, NamespaceConfig>;
  datasets: DatasetRegistry;
  edges: EdgesStore;
  metric: MetricFn;
  /** Schema accessor; a callback because importing Engine would be circular. */
  schemaFor: (ns: string) => Schema;
  /** Tombstone accessor; a stream against a tombstoned ns is refused upfront. */
  isTombstoned: (ns: string) => boolean;
}

export class StreamSubsystem {
  readonly #namespaces: Map<string, NamespaceConfig>;
  readonly #datasets: DatasetRegistry;
  readonly #edges: EdgesStore;
  readonly #metric: MetricFn;
  readonly #schemaFor: (ns: string) => Schema;
  readonly #isTombstoned: (ns: string) => boolean;

  constructor(deps: StreamSubsystemDeps) {
    this.#namespaces = deps.namespaces;
    this.#datasets = deps.datasets;
    this.#edges = deps.edges;
    this.#metric = deps.metric;
    this.#schemaFor = deps.schemaFor;
    this.#isTombstoned = deps.isTombstoned;
  }

  /**
   * Register a stream dispatch. §5.5.
   *
   * Drives an async-iterable resolver, emits a `chunk` frame per yielded row
   * (post row-filter obligations), and terminates with `end` on clean
   * completion, `error` on throw, or `end { final: true, _meta: { cancelled } }`
   * on cancellation.
   *
   * Differences from `subscribe`:
   *   - Multi-key frames are rejected with `stream_multi_key` — stream
   *     ordering is per-key, conflating two keys silently would be a footgun.
   *   - Non-iterable resolver returns surface as `not_streamable` — the engine
   *     refuses to synthesise an iterable from a one-shot return.
   *   - Cancellation is a first-class contract: the engine hands the resolver
   *     an `AbortSignal` via `args.signal` and stops pulling from the iterator
   *     when it fires. Well-behaved resolvers honour the signal in their
   *     `finally` block (close cursors, release locks).
   *
   * The returned handle's `cancel` is synchronous so route shutdown paths
   * (`conn.onClose`) don't need async plumbing. The generator drain happens in
   * the background task spawned here; a caller that needs to observe
   * completion should listen for the terminal `end` / `error` frame on
   * `onFrame` rather than awaiting any promise from this method.
   */
  stream(input: StreamInput): StreamHandle {
    const keys = Object.keys(input.frame);

    if (keys.length === 0) {
      deliverFrame(
        input.onFrame,
        {
          id: input.id,
          kind: 'error',
          errors: [{ message: 'stream frame must have exactly one key', code: 'stream_multi_key' }]
        },
        this.#metric
      );
      deliverFrame(input.onFrame, { id: input.id, kind: 'end', final: true }, this.#metric);
      return { id: input.id, cancel: (): void => {} };
    }
    if (keys.length > 1) {
      deliverFrame(
        input.onFrame,
        {
          id: input.id,
          kind: 'error',
          errors: [
            {
              message: `stream dispatch accepts one key; received ${keys.length}`,
              code: 'stream_multi_key'
            }
          ]
        },
        this.#metric
      );
      deliverFrame(input.onFrame, { id: input.id, kind: 'end', final: true }, this.#metric);
      return { id: input.id, cancel: (): void => {} };
    }

    const controller = new AbortController();
    // External abort (socket close, app shutdown) cascades into our controller
    // so resolver code only needs to listen on `args.signal`.
    if (input.signal !== undefined) {
      if (input.signal.aborted) controller.abort();
      else {
        input.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }

    // Nothing awaits the stream, so an escaped throw would be an unhandled
    // rejection, which exits the process.
    this.#runStream(input, keys[0] as string, controller).catch((err: unknown) => {
      const key = keys[0] as string;
      deliverFrame(
        input.onFrame,
        {
          id: input.id,
          kind: 'error',
          errors: [
            {
              message: clientErrorMessage(err, this.#metric, key),
              code: 'resolver_error',
              path: [key]
            }
          ]
        },
        this.#metric
      );
      deliverFrame(input.onFrame, { id: input.id, kind: 'end', final: true }, this.#metric);
    });

    return {
      id: input.id,
      cancel: (): void => {
        controller.abort();
      }
    };
  }

  async #runStream(input: StreamInput, key: string, controller: AbortController): Promise<void> {
    const rawEntry = input.frame[key];
    const signal = controller.signal;

    // §5.13 batched mutate is mutate-only. Array values on a stream surface
    // are rejected with a dedicated error code — streams carry one key and
    // one resolver per call; the array shape has no semantics here.
    if (Array.isArray(rawEntry)) {
      await input.onFrame({
        id: input.id,
        kind: 'error',
        errors: [
          {
            message: `batched frame arrays are not supported on stream (op-key '${key}')`,
            code: 'batched_not_supported',
            path: [key]
          }
        ]
      });
      await input.onFrame({ id: input.id, kind: 'end', final: true });
      this.#metric('engine_batched_not_supported', { op: 'stream', key });
      return;
    }
    const frameEntry = rawEntry as FrameEntry;

    const emitError = async (
      message: string,
      code: string,
      path: string[] = [key],
      details?: Record<string, unknown>
    ): Promise<void> => {
      const errEntry: {
        message: string;
        code: string;
        path: string[];
        details?: Record<string, unknown>;
      } = { message, code, path };
      if (details !== undefined) errEntry.details = details;
      await input.onFrame({
        id: input.id,
        kind: 'error',
        errors: [errEntry]
      });
      await input.onFrame({ id: input.id, kind: 'end', final: true });
    };

    const parsed = parseQualifiedKey(key);
    if (!parsed) {
      await emitError(`unqualified frame key '${key}' — expected '<ns>/<name>'`, 'unqualified_key');
      return;
    }
    const { ns, name } = parsed;

    // §5.12 Phase 1: stream-time namespace gate. Consistent with the
    // query/mutate/subscribe paths so one seam covers every dispatch verb.
    const nsGate = checkIdentityGrant(input.ctx.identity, ns, 'stream');
    if (!nsGate.ok) {
      await emitError(
        `namespace '${ns}' not in identity's allowed namespaces`,
        'unauthorized_namespace'
      );
      return;
    }

    if (this.#isTombstoned(ns)) {
      await emitError(`namespace '${ns}' was deleted`, 'namespace_tombstoned');
      return;
    }

    const nsCfg = this.#namespaces.get(ns);
    if (!nsCfg) {
      await emitError(`unknown namespace '${ns}'`, 'unknown_namespace');
      return;
    }

    // Virtual (dataset-less) namespaces are one-shot query/mutate only. Refuse
    // BEFORE the dataset lookup so a virtual ns doesn't get unknown_namespace.
    if (nsCfg.virtual === true) {
      await emitError(
        `cannot stream virtual namespace '${ns}' — one-shot query/mutate only`,
        WS_CODE_SUBSCRIPTION_UNSUPPORTED_FRAME
      );
      this.#metric('engine_subscription_unsupported_frame', { key, reason: 'virtual_namespace' });
      return;
    }

    const dataset = this.#datasets.get(ns);
    if (!dataset) {
      await emitError(`unknown namespace '${ns}'`, 'unknown_namespace');
      return;
    }

    const registryEntry = nsCfg.registry.get(name);
    if (!registryEntry) {
      await emitError(`unknown name '${name}' in namespace '${ns}'`, 'unknown_name');
      return;
    }
    // Streams are reads: the namespace gate above checked `read` only, and a
    // write here would land outside any transaction, unseen by subscribers.
    if (registryEntry.kind === 'mutation') {
      await emitError(
        `cannot stream mutation '${key}' — send it to mutate`,
        WS_CODE_SUBSCRIPTION_UNSUPPORTED_FRAME
      );
      return;
    }

    const ctxBase = this.#buildStreamContext(input.ctx);
    // Thread entry/verb, as engine.#runEntry does.
    const ctx: RequestContext = {
      ...ctxBase,
      namespace: ns,
      entry: name,
      ...(registryEntry.verb !== undefined ? { verb: registryEntry.verb } : {})
    };
    // Streams always expose the abort signal. Keeping the branch clean means a
    // resolver that forgets to read `signal` still gets its chance at graceful
    // shutdown via the AsyncIterator's `return()` call below.
    const args: ResolverArgs = {
      dataset,
      edges: this.#edges,
      signal
    };
    // Metadata spellings reach policy, validation and the resolver as the
    // canonical columns, as in a query.
    const frame = withCanonicalMetadataFilters(frameEntry, registryEntry.fields);
    if (frame.params !== undefined) args.params = frame.params;
    if (frame.fields !== undefined) args.fields = frame.fields;

    const decision = evaluatePolicy(registryEntry.policy, ctx, args);
    if (!decision.allow) {
      await emitError(decision.reason ?? 'policy denied', 'policy_denied');
      this.#metric('engine_policy_denied', { key, reason: decision.reason });
      return;
    }
    // A row filter reads the whole row, so the substrate must not narrow it to
    // the caller's selection; the transport projects the response.
    if ((decision.obligations?.length ?? 0) > 0) delete args.fields;

    if (registryEntry.kind === 'type') {
      const params = frame.params;
      const where = params?.where as WhereClause | undefined;
      const orderBy = params?.orderBy as OrderByClause[] | undefined;
      const allowTableScan = params?._allowTableScan === true;
      if (where !== undefined || orderBy !== undefined) {
        const schema = this.#schemaFor(ns);
        const typeSchema = schema.types[name];
        if (typeSchema) {
          try {
            validateFilter({
              ...(where !== undefined ? { where } : {}),
              ...(orderBy !== undefined ? { orderBy } : {}),
              allowTableScan,
              typeSchema,
              capabilities: dataset.capabilities
            });
          } catch (err) {
            if (err instanceof FilterValidationError) {
              await emitError(err.message, err.code, [key, ...err.path]);
              this.#metric('engine_filter_validation_error', {
                key,
                code: err.code,
                path: err.path
              });
              return;
            }
            throw err;
          }
        }
      }
    }

    let result: Row | Row[] | ReadResult | AsyncIterable<Row> | null;
    try {
      result = await registryEntry.resolver(ctx, args);
    } catch (err) {
      const code = isResolverFrameError(err) ? err.code : 'resolver_error';
      const details = isResolverFrameError(err) ? err.details : undefined;
      await emitError(clientErrorMessage(err, this.#metric, key), code, [key], details);
      return;
    }

    if (!isAsyncIterable<Row>(result)) {
      await emitError(`resolver for '${key}' did not return an async iterable`, 'not_streamable');
      return;
    }

    const obligations = (decision.obligations ?? []).filter(
      (o): o is RowFilterObligation => o.kind === 'row-filter'
    );
    const schemaVersion = this.#schemaFor(ns).schemaVersion;

    const iterator = result[Symbol.asyncIterator]();
    let sequence = 0;
    let cancelled = signal.aborted;

    // Abort path: flip `cancelled` so the loop consults it between
    // `iterator.next()` returns. A well-behaved resolver listens on
    // `args.signal` and rejects its pending await so `.next()` throws
    // immediately; resolvers that don't are unstuck by the `.return()` the
    // loop issues once it detects cancellation (see below). Calling
    // `.return()` here (pre-`.next()`) would close the generator without ever
    // running its body or `finally` block, defeating cleanup.
    const onAbort = (): void => {
      cancelled = true;
    };
    if (signal.aborted) cancelled = true;
    else signal.addEventListener('abort', onAbort, { once: true });

    try {
      while (true) {
        let step: IteratorResult<Row>;
        try {
          step = await iterator.next();
        } catch (err) {
          // A resolver that throws mid-iteration surfaces as `error` + `end`.
          // Cancellation-induced throws (AbortError, etc.) are silent since we
          // already know the stream is ending and the caller asked for it.
          if (cancelled) break;
          await input.onFrame({
            id: input.id,
            kind: 'error',
            errors: [
              {
                message: clientErrorMessage(err, this.#metric, key),
                code: 'resolver_error',
                path: [key]
              }
            ]
          });
          await input.onFrame({ id: input.id, kind: 'end', final: true });
          return;
        }
        if (step.done === true) break;
        // Cancellation race: the iterator may have yielded just before the
        // abort signal fired. Suppress the post-abort chunk — once cancelled,
        // no further data flows downstream. Fire the iterator's `.return()`
        // to release the generator's finally block even if the resolver hasn't
        // registered its own signal listener.
        if (cancelled) {
          if (typeof iterator.return === 'function') {
            try {
              await iterator.return();
            } catch {
              // Cleanup errors are not escalated — the caller asked to stop.
            }
          }
          break;
        }

        const row = step.value;
        if (!obligationsPermitRow(obligations, ctx, row)) continue;

        const chunk: WsResponseFrame = {
          id: input.id,
          kind: 'chunk',
          schemaVersion,
          data: { [key]: row },
          shapes: { [key]: 'single' },
          sequence
        };
        sequence++;
        await input.onFrame(chunk);
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
    }

    // End frame. Cancelled streams tag `_meta.cancelled` so the client can
    // distinguish "stream ended because the server said so" from "I cancelled
    // this" — useful when cancellation is racing natural completion.
    const endFrame: WsResponseFrame = { id: input.id, kind: 'end', final: true };
    if (cancelled) {
      endFrame._meta = { cancelled: true };
    }
    await input.onFrame(endFrame);
  }

  #buildStreamContext(caller: Partial<RequestContext>): Omit<RequestContext, 'namespace'> {
    const base: Omit<RequestContext, 'namespace'> = {
      identity: caller.identity ?? null,
      operation: 'stream',
      now: caller.now ?? new Date(),
      headers: caller.headers ?? {},
      meta: caller.meta ?? {}
    };
    if (caller.clientIp !== undefined) base.clientIp = caller.clientIp;
    return base;
  }
}
