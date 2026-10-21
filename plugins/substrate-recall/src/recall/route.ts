/**
 * `POST /substrate/v1/recall` HTTP transport.
 *
 * KernelRouteClaim handler factory. Body parsing + error-code mapping live
 * here; retrieval itself is `handleRecallRequest` in `./handler.js`.
 */

import { jsonResponse } from '@mnmal-ai/substrate-compose';
import type { Embedder } from '@mnmal-ai/substrate-embedder';
import type { HttpHandler, SubstrateRequest, SubstrateResponse } from '@mnmal-ai/substrate-types';
import type { EmbedStats } from '../embed-stats.js';
import type { EmbeddingsStore } from '../embeddings-store.js';
import type { LexicalStore } from '../lexical-store.js';
import { checkParams } from '../params.js';
import { callerFromRequest } from '../row-visibility.js';
import { handleRecallRequest } from './handler.js';
import {
  bindPolicy,
  DEFAULT_SALIENCE_CONFIG,
  type ExpansionResolver,
  type ReadPolicyCheck,
  type RecallInput,
  type SalienceConfig,
  type SpreadResolver,
  type WritePolicyCheck
} from './types.js';

/**
 * Everything `POST /substrate/v1/recall` accepts. The refusal message is generated
 * from this array, so the two cannot disagree.
 */
const ROUTE_PARAMS = [
  'query',
  'k',
  'namespace',
  'type',
  'threshold',
  'lexicalThreshold',
  'expand',
  'boost',
  'returnVector',
  'lexical',
  'explain',
  'where'
] as const;

function parseBody(req: SubstrateRequest): RecallInput | { error: string } {
  const raw = req.body;
  if (raw === null || (Buffer.isBuffer(raw) && raw.length === 0)) {
    return { error: 'request body is required' };
  }
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (text.trim().length === 0) {
    return { error: 'request body is required' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'invalid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'request body must be a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  // `to` is deliberately not in the allowed set, but a body carrying it skips
  // the generic unknown-key refusal so the cross-surface hint below fires.
  const unknown = checkParams(obj, ROUTE_PARAMS);
  if (unknown !== null && obj.to === undefined) return { error: unknown };
  if (typeof obj.query !== 'string' || obj.query.length === 0) {
    // Name the other spelling: the `recall/Hit` frame calls this `to`.
    return {
      error:
        typeof obj.to === 'string'
          ? '"query" must be a non-empty string — this is the ROUTE, which spells the search text `query`; you passed `to`, which is the spelling the `recall/Hit` frame uses'
          : '"query" must be a non-empty string (the route and the MCP tool spell the search text `query`; the `recall/Hit` frame calls it `to`)'
    };
  }
  const input: RecallInput = { query: obj.query };
  if (obj.k !== undefined) {
    if (typeof obj.k !== 'number') return { error: '"k" must be a number' };
    input.k = obj.k;
  }
  if (obj.namespace !== undefined) {
    if (typeof obj.namespace !== 'string') return { error: '"namespace" must be a string' };
    input.namespace = obj.namespace;
  }
  if (obj.type !== undefined) {
    if (typeof obj.type !== 'string') return { error: '"type" must be a string' };
    input.type = obj.type;
  }
  if (obj.threshold !== undefined) {
    if (typeof obj.threshold !== 'number') return { error: '"threshold" must be a number' };
    input.threshold = obj.threshold;
  }
  if (obj.lexicalThreshold !== undefined) {
    if (typeof obj.lexicalThreshold !== 'number') {
      return { error: '"lexicalThreshold" must be a number' };
    }
    input.lexicalThreshold = obj.lexicalThreshold;
  }
  if (obj.expand !== undefined) {
    if (typeof obj.expand !== 'boolean') return { error: '"expand" must be a boolean' };
    input.expand = obj.expand;
  }
  if (obj.boost !== undefined) {
    if (typeof obj.boost !== 'boolean') return { error: '"boost" must be a boolean' };
    input.boost = obj.boost;
  }
  if (obj.returnVector !== undefined) {
    if (typeof obj.returnVector !== 'boolean') return { error: '"returnVector" must be a boolean' };
    input.returnVector = obj.returnVector;
  }
  if (obj.lexical !== undefined) {
    if (typeof obj.lexical !== 'boolean') return { error: '"lexical" must be a boolean' };
    input.lexical = obj.lexical;
  }
  if (obj.explain !== undefined) {
    if (typeof obj.explain !== 'boolean') return { error: '"explain" must be a boolean' };
    input.explain = obj.explain;
  }
  // The core validates the filter's shape, once for every surface.
  if (obj.where !== undefined) input.where = obj.where as NonNullable<RecallInput['where']>;
  return input;
}

export interface RecallRouteConfig {
  embedder?: Embedder;
  store?: EmbeddingsStore;
  /** Lexical arm store. Absent → the arm never runs and `arms.lexicalWhy` says so. */
  lexicalStore?: LexicalStore;
  /**
   * Which types declare a `lexical.source`. Forwarded to the core so it can
   * answer `lexicalWhy: 'no-source'` instead of reporting `ran` for an arm
   * that cannot match. Absent → the core cannot say, and runs the arm.
   */
  lexicalSources?: { get(namespace: string, type: string): unknown; size(): number };
  /**
   * Which types declare an `embed.source`. Forwarded to the core so it can
   * answer `denseWhy: 'no-source'` for a type with no vectors instead of
   * reporting `dense: true` over a knn that cannot match. Absent → the core
   * cannot say, and runs the arm.
   */
  embedSources?: { get(namespace: string, type: string): unknown; size(): number };
  /**
   * Salience blend config. When omitted, defaults to
   * `DEFAULT_SALIENCE_CONFIG` (weight=0 → ranking unchanged, boost still
   * fires so the signal accumulates passively for future opt-in).
   */
  salience?: SalienceConfig;
  /**
   * Spread-target resolver. The plugin builds this
   * at compose time from the spread registry + an `EdgesStore`. Absent →
   * the spread path is short-circuited (forward + backward boosts skip).
   */
  spreadResolver?: SpreadResolver;
  /**
   * Expansion resolver. The plugin builds this at compose time
   * from the spread registry + an optional `EdgesStore`. When set, enables
   * `input.expand:true` to walk opt-in crossRefs from the knn top-K and
   * merge scored neighbours into the candidate pool. Absent → expansion is
   * short-circuited even if `input.expand:true`.
   */
  expansionResolver?: ExpansionResolver;
  /**
   * Plugin-level kill-switch for expansion. Set to `false` to
   * disable expansion regardless of `input.expand`. Defaults to `true`.
   */
  expansionEnabled?: boolean;
  /**
   * Optional stats counter. When provided, the route
   * increments `expansionFailures` on caught exceptions in the expansion path
   * (resolver throws / fetchEmbeddings throws). Surfaces degraded paths on the
   * `/substrate/v1/embed-stats` route.
   */
  stats?: EmbedStats;
  /**
   * Unbound read-policy check. The route binds the request's
   * verified identity (`req.identity ?? null` — populated by the auth layer)
   * and threads the bound check into `handleRecallRequest`. Denied primary
   * scope maps to a 403 `policy_denied` envelope. Absent → open.
   */
  checkReadPolicy?: ReadPolicyCheck;
  /** Unbound write-policy check — the route binds `req.identity`. */
  checkWritePolicy?: WritePolicyCheck;
}

/**
 * KernelRouteClaim handler factory.
 *
 * Returns an `HttpHandler` for `POST /substrate/v1/recall`. Pass to
 * `KernelRouteClaim.handler` when building the substrate plugin's
 * `kernelRoutes` array.
 *
 * @example
 * ```ts
 * kernelRoutes: [
 *   { path: 'recall', method: 'POST', handler: recallRouteHandler({ embedder, store }) }
 * ]
 * ```
 */
export function recallRouteHandler(cfg: RecallRouteConfig): HttpHandler {
  return async (req: SubstrateRequest): Promise<SubstrateResponse> => {
    // No embedder/store pre-gate: `handleRecallRequest` decides which arms can
    // run, and a lexical-only deployment must still be served.
    const parsed = parseBody(req);
    if ('error' in parsed) {
      return jsonResponse(400, { code: 'bad_request', message: parsed.error });
    }
    try {
      // Bind the request's verified identity (auth layer populates
      // req.identity; absent = anonymous) into the read-policy check so
      // handleRecallRequest stays transport-agnostic.
      const unbound = cfg.checkReadPolicy;
      const unboundWrite = cfg.checkWritePolicy;
      const caller = callerFromRequest(req);
      const out = await handleRecallRequest(parsed, {
        ...(cfg.embedder !== undefined ? { embedder: cfg.embedder } : {}),
        ...(cfg.store !== undefined ? { store: cfg.store } : {}),
        ...(cfg.lexicalStore !== undefined ? { lexicalStore: cfg.lexicalStore } : {}),
        ...(cfg.lexicalSources !== undefined ? { lexicalSources: cfg.lexicalSources } : {}),
        ...(cfg.embedSources !== undefined ? { embedSources: cfg.embedSources } : {}),
        salience: cfg.salience ?? DEFAULT_SALIENCE_CONFIG,
        spreadResolver: cfg.spreadResolver ?? null,
        expansionResolver: cfg.expansionResolver ?? null,
        expansionEnabled: cfg.expansionEnabled ?? true,
        ...(cfg.stats !== undefined ? { stats: cfg.stats } : {}),
        ...(unbound !== undefined ? { checkReadPolicy: bindPolicy(unbound, caller) } : {}),
        ...(unboundWrite !== undefined
          ? { checkWritePolicy: bindPolicy(unboundWrite, caller) }
          : {}),
        caller
      });
      return jsonResponse(200, out);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'bad_request') {
        return jsonResponse(400, { code: 'bad_request', message });
      }
      if (code === 'missing_namespace') {
        return jsonResponse(400, { code, message });
      }
      if (code === 'policy_denied') {
        return jsonResponse(403, { error: { code: 'policy_denied', message } });
      }
      if (code === 'unavailable' || code === 'invalid_response') {
        return jsonResponse(503, { error: { code: `embedder_${code}`, message } });
      }
      // Nothing to search with. 503 for the deployment fault; 400 for
      // `no_retrieval_arm`, where the caller switched off the only arm.
      if (code === 'embedder_unavailable') {
        return jsonResponse(503, { error: { code, message } });
      }
      if (code === 'no_retrieval_arm') {
        return jsonResponse(400, { error: { code, message } });
      }
      // Non-EmbedError — write to stderr so the error surfaces in container
      // logs without coupling this route to the host's logger choice.
      process.stderr.write(
        `recall route failure: ${message}\n${err instanceof Error && err.stack ? err.stack : ''}\n`
      );
      return jsonResponse(500, { error: { code: 'internal', message: 'recall failed' } });
    }
  };
}
