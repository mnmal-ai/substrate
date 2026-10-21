/**
 * Bridge-proxy subsystem (§5.8 / §6.5).
 *
 * Routes a per-namespace bucket to the registered `BridgeClient`, merges its
 * `data`/`shapes`/`errors` into the envelope in place, and surfaces
 * unreachable or errored bridges as per-key orphan / error markers. Takes its
 * engine slice via `BridgeSubsystemDeps` and never imports `Engine`.
 */

import type { BridgeRegistry, PackEnvelope, QualifiedFrame } from '@mnmal-ai/substrate-types';
import { isAuthCause } from '@mnmal-ai/substrate-types';
import { BridgeUnreachableError } from '../bridge-unreachable-error.js';
import { addError, type MetricFn, toBridgeFrame } from './internals.js';

export interface BridgeSubsystemDeps {
  /** Bridge registry (shared by reference with the engine). */
  bridges: BridgeRegistry;
  /** Metric sink (shared by reference with the engine). */
  metric: MetricFn;
}

/**
 * Mark a key's result set partial, naming the bridge that could not be
 * reached. Merges rather than overwrites, so a multi-bridge key accumulates.
 */
function markIncomplete(envelope: PackEnvelope, key: string, bridgeName: string): void {
  if (envelope._completeness === undefined) envelope._completeness = {};
  const completeness = envelope._completeness;
  if (completeness[key] === undefined) completeness[key] = { complete: false };
  const entry = completeness[key];
  entry.complete = false;
  if (entry.unreachable === undefined) entry.unreachable = [];
  const unreachable = entry.unreachable;
  if (!unreachable.includes(bridgeName)) unreachable.push(bridgeName);
}

/**
 * True when the unreachable error was a 401/403 rather than an outage. Both
 * surface as `BridgeUnreachableError` (§6.6), but §6 gives auth failures their
 * own `bridge_auth_failed` metric. Delegates to `isAuthCause` so the metric
 * and the error's message wording share one predicate.
 */
function isAuthFailure(err: BridgeUnreachableError): boolean {
  return isAuthCause(err.cause);
}

export class BridgeSubsystem {
  readonly #bridges: BridgeRegistry;
  readonly #metric: MetricFn;

  constructor(deps: BridgeSubsystemDeps) {
    this.#bridges = deps.bridges;
    this.#metric = deps.metric;
  }

  /**
   * Proxy a per-bridge bucket through `BridgeClient.query`. §5.8 / §6.5.
   *
   * Unreachable bridges surface as per-key `__orphan: true, reason:
   * 'bridge_unreachable'` entries on the envelope — "reads never fail" is the
   * §6.5 invariant. Any merged `data`/`shapes` from a reachable bridge flow
   * through verbatim; schemaVersion drift detection belongs to the client-side
   * decoder (§7.1) and is not re-checked here.
   *
   * Bridge errors other than unreachable (e.g. remote HTTP 4xx) surface as
   * per-key `bridge_error` entries — the caller asked for a read and the bridge
   * refused; we don't synthesise an orphan because the row's state is unknown.
   * They also mark the key incomplete: the two signals describe the same fact,
   * so a consumer reading only `_completeness` must not conclude "complete".
   */
  async runQuery(ns: string, bucket: QualifiedFrame, envelope: PackEnvelope): Promise<void> {
    const bucketKeys = Object.keys(bucket);
    const bridge = this.#bridges.get(ns);
    if (bridge === undefined) {
      for (const key of bucketKeys) {
        addError(
          envelope,
          [key],
          `bridge for namespace '${ns}' not registered`,
          'unknown_namespace'
        );
      }
      return;
    }
    if (this.#bridges.isUnreachable(ns)) {
      for (const key of bucketKeys) {
        envelope.data[key] = { __orphan: true, reason: 'bridge_unreachable' };
        envelope.shapes[key] = 'single';
        markIncomplete(envelope, key, bridge.name);
      }
      this.#metric('engine_bridge_unreachable_read', { ns, keys: bucketKeys });
      return;
    }
    try {
      const result = await bridge.query(toBridgeFrame(bucket));
      for (const key of bucketKeys) {
        const data = result.data?.[key];
        const shape = result.shapes?.[key];
        if (data !== undefined) envelope.data[key] = data;
        if (shape !== undefined) envelope.shapes[key] = shape;
      }
      if (result.errors !== undefined && result.errors.length > 0) {
        if (envelope.errors === undefined) envelope.errors = [];
        const errs = envelope.errors;
        for (const err of result.errors) errs.push(err);
      }
    } catch (err) {
      if (err instanceof BridgeUnreachableError) {
        for (const key of bucketKeys) {
          envelope.data[key] = { __orphan: true, reason: 'bridge_unreachable' };
          envelope.shapes[key] = 'single';
          markIncomplete(envelope, key, bridge.name);
        }
        this.#metric(isAuthFailure(err) ? 'bridge_auth_failed' : 'engine_bridge_unreachable_read', {
          ns,
          keys: bucketKeys,
          error: err.message
        });
        return;
      }
      this.#reportBridgeError(ns, bucketKeys, err);
      for (const key of bucketKeys) {
        addError(envelope, [key], `bridge '${bridge.name}' request failed`, 'bridge_error');
        // `errors[]` and `_completeness` must not disagree. A consumer reading
        // only the typed sidecar would otherwise treat a refused bridge read as
        // a complete empty result.
        markIncomplete(envelope, key, bridge.name);
      }
    }
  }

  /**
   * Proxy a per-bridge bucket through `BridgeClient.mutate`. §5.8 / §6.5.
   *
   * Unreachable bridges surface as per-key `bridge_unreachable` errors on the
   * envelope — "deletes never proceed silently across a network" (§6.5).
   * G1 atomicity does NOT extend across bridges: each bridge's mutate is
   * independent of the local tx and independent of other bridges.
   */
  async runMutate(ns: string, bucket: QualifiedFrame, envelope: PackEnvelope): Promise<void> {
    const bucketKeys = Object.keys(bucket);
    const bridge = this.#bridges.get(ns);
    if (bridge === undefined) {
      for (const key of bucketKeys) {
        addError(
          envelope,
          [key],
          `bridge for namespace '${ns}' not registered`,
          'unknown_namespace'
        );
      }
      return;
    }
    if (this.#bridges.isUnreachable(ns)) {
      for (const key of bucketKeys) {
        addError(envelope, [key], `bridge '${ns}' unreachable`, 'bridge_unreachable');
      }
      this.#metric('engine_bridge_unreachable_mutate', { ns, keys: bucketKeys });
      return;
    }
    try {
      const result = await bridge.mutate(toBridgeFrame(bucket));
      for (const key of bucketKeys) {
        const data = result.data?.[key];
        const shape = result.shapes?.[key];
        if (data !== undefined) envelope.data[key] = data;
        if (shape !== undefined) envelope.shapes[key] = shape;
      }
      if (result.errors !== undefined && result.errors.length > 0) {
        if (envelope.errors === undefined) envelope.errors = [];
        const errs = envelope.errors;
        for (const err of result.errors) errs.push(err);
      }
    } catch (err) {
      if (err instanceof BridgeUnreachableError) {
        const auth = isAuthFailure(err);
        // The detail names the peer's URL, so it goes to the metric only.
        const message = auth
          ? `bridge '${bridge.name}' refused the request`
          : `bridge '${bridge.name}' unreachable`;
        for (const key of bucketKeys) {
          addError(envelope, [key], message, 'bridge_unreachable');
        }
        this.#metric(auth ? 'bridge_auth_failed' : 'engine_bridge_unreachable_mutate', {
          ns,
          keys: bucketKeys,
          error: err.message
        });
        return;
      }
      this.#reportBridgeError(ns, bucketKeys, err);
      for (const key of bucketKeys) {
        addError(envelope, [key], `bridge '${bridge.name}' request failed`, 'bridge_error');
      }
    }
  }

  /** The peer's own wording can carry its URL or body, so it stays server-side. */
  #reportBridgeError(ns: string, keys: Array<string>, err: unknown): void {
    this.#metric('engine_bridge_error', {
      ns,
      keys,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
