/**
 * serve/late-refs.ts — late-bound cross-phase holders.
 *
 * Three holders, one shape: a mutable ref populated after `compose()` that
 * earlier-built closures read at request time, long after population.
 */

import type { AuthConfig, KeyRegistry } from '@mnmal-ai/substrate-compose';
import type { Engine } from '@mnmal-ai/substrate-core';
import type { MemoryDatasetRegistry } from '@mnmal-ai/substrate-dataset-memory';
import type {
  Dataset,
  Identity,
  PolicyDecision,
  PolicyProbeContext
} from '@mnmal-ai/substrate-types';

export interface LateRefs {
  /** Populated from the composed dataset registry after `compose()`. */
  datasetRegistryRef: {
    current: { get: (ns: string) => Dataset | undefined } | null;
  };
  resolveDataset: (namespace: string) => Dataset | null;
  /** Populated with the composed engine after `compose()`. */
  engineRef: { current: Engine | null };
  checkReadPolicy: (
    ns: string,
    type: string,
    identity: Identity | null,
    probe?: PolicyProbeContext
  ) => PolicyDecision;
  checkWritePolicy: (
    ns: string,
    type: string,
    identity: Identity | null,
    probe?: PolicyProbeContext
  ) => PolicyDecision;
  /**
   * Kernel routes mount DURING substrate composition, which runs before
   * `compose()` — so the KeyRegistry does not exist yet at mount time.
   * `withAuth` reads `cfg.keyRegistry` per REQUEST, so this holder, populated
   * after compose, is sufficient. Without the registry an agent kid cannot
   * resolve and every valid agent token 401s on kernel routes.
   */
  kernelAuth: AuthConfig | null;
}

export function createLateRefs(auth: AuthConfig | null): LateRefs {
  // Late-bound dataset registry holder. kernelHostDeps is built BEFORE
  // compose() builds the actual dataset registry, but substrate-recall only calls
  // `resolveDataset` at postWrite invocation time, after compose() has
  // populated the holder.
  const datasetRegistryRef: LateRefs['datasetRegistryRef'] = { current: null };
  const resolveDataset = (namespace: string): Dataset | null =>
    datasetRegistryRef.current?.get(namespace) ?? null;

  // Late-bound engine holder, same pattern. substrate-recall's checkReadPolicy
  // probes engine.evaluateReadPolicy so /substrate/v1/recall honours the same
  // composed policies that gate engine.query. The not-ready branch fails
  // CLOSED — an out-of-band read surface must never be more permissive than
  // dispatch.
  const engineRef: LateRefs['engineRef'] = { current: null };
  const checkReadPolicy = (
    ns: string,
    type: string,
    identity: Identity | null,
    probe?: PolicyProbeContext
  ): PolicyDecision =>
    engineRef.current?.evaluateReadPolicy(ns, type, identity, probe) ?? {
      allow: false,
      reason: 'engine not ready'
    };
  // The write-side twin, for substrate-recall's mutating surfaces
  // (/substrate/v1/salience/boost, boost-on-read in /substrate/v1/embeddings/fetch). A read
  // check alone is weaker wherever a namespace's posture differs by operation.
  const checkWritePolicy = (
    ns: string,
    type: string,
    identity: Identity | null,
    probe?: PolicyProbeContext
  ): PolicyDecision =>
    engineRef.current?.evaluateWritePolicy(ns, type, identity, probe) ?? {
      allow: false,
      reason: 'engine not ready'
    };

  const kernelAuth: AuthConfig | null = auth === null ? null : { ...auth };
  return {
    datasetRegistryRef,
    resolveDataset,
    engineRef,
    checkReadPolicy,
    checkWritePolicy,
    kernelAuth
  };
}

/**
 * Populate the late-bound holders after `compose()`, including handing
 * kernel routes the key registry compose primed.
 *
 * Throws when auth is enabled and `keyRegistry` is absent: that is always a
 * mismatched install (`@mnmal-ai/substrate-compose` is an external runtime
 * dependency), and serving on would 401 every signed agent silently.
 */
export function populateLateRefs(
  refs: LateRefs,
  composedDatasets: MemoryDatasetRegistry,
  engine: Engine,
  keyRegistry: KeyRegistry | null | undefined
): void {
  const kernelAuth = refs.kernelAuth;
  if (kernelAuth !== null) {
    if (keyRegistry === null || keyRegistry === undefined) {
      throw new Error(
        'substrate: auth is enabled but compose returned no keyRegistry. This is a ' +
          'MISMATCHED INSTALL, not a config problem — @mnmal-ai/substrate-compose is older ' +
          'than @mnmal-ai/substrate and predates ComposeResult.keyRegistry. ' +
          'Every signed agent request to a kernel route would 401 while unsigned ones ' +
          'succeed. Reinstall the substrate line together rather than swapping one dist.'
      );
    }
    kernelAuth.keyRegistry = keyRegistry;
  }
  refs.datasetRegistryRef.current = composedDatasets;
  refs.engineRef.current = engine;
}
