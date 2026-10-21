/**
 * serve/nl-engine.ts — the engine access substrate-nl is handed.
 *
 * Fail-closed: the plugin only calls these from inside a request, after
 * compose() populated the ref, so a null engine means a fault. Queries run
 * under the caller's request context and the remote page bounds, since an NL
 * request is a remote read.
 */

import { buildContext } from '@mnmal-ai/substrate-compose';
import { type Engine, effectiveFilterOperators } from '@mnmal-ai/substrate-core';
import type { Query, SubstrateRequest } from '@mnmal-ai/substrate-types';
import type { LateRefs } from './late-refs.js';

export function nlEngineAccess(
  engineRef: LateRefs['engineRef'],
  trustedProxies: Set<string>,
  pageLimits: { defaultLimit: number; maxLimit: number }
) {
  const ready = (): Engine => {
    const engine = engineRef.current;
    if (engine === null) throw new Error('substrate-nl: engine not ready');
    return engine;
  };
  return {
    federatedSchema: () => ready().federatedSchema(),
    operators: (ns: string) => {
      const dataset = ready().datasetFor(ns);
      return dataset === undefined ? undefined : effectiveFilterOperators(dataset.capabilities);
    },
    query: async (frame: Query, req: SubstrateRequest) =>
      ready().query({
        frame,
        ctx: buildContext(req, trustedProxies),
        pageLimits,
        ...(req.signal !== undefined ? { signal: req.signal } : {})
      })
  };
}
