/**
 * Frame surface for the `recall` virtual namespace.
 *
 * Adapters from frame dispatch onto the transport-agnostic cores —
 * `handleRecallRequest`, `handleSalienceBoost`, `handleEmbeddingsFetch` — that
 * the HTTP routes also call.
 *
 * Coded core throws (`{ code }`) are re-raised as `ResolverFrameError` so the
 * engine surfaces the SAME code the HTTP route maps to a status — `policy_denied`
 * → 403, `bad_request` → 400, embedder `unavailable`/`invalid_response` →
 * `embedder_*` (503 on the route).
 *
 * Identity is bound from `ctx.identity` here, as routes bind `req.identity`:
 * the cores take an identity-BOUND 2-arg policy check.
 *
 * Two sentinel ids appear in mutation returns: `'ack'` (boost) and `'embeddings'`
 * (fetchEmbeddings). These are fixed strings, never real row ids — mutations must
 * return a Row (id required by the frame contract), so sentinels satisfy the shape.
 */

import type { Embedder } from '@mnmal-ai/substrate-embedder';
import type {
  FieldDef,
  KernelNamespaceContribution,
  RequestContext,
  ResolverArgs,
  Row
} from '@mnmal-ai/substrate-types';
import { ResolverFrameError } from '@mnmal-ai/substrate-types';
import { buildClusterSurface, type ClusterSurfaceDeps } from './cluster-frame-surface.js';
import type { EmbedStats } from './embed-stats.js';
import { handleEmbeddingsFetch, validateFetchInput } from './embeddings-fetch-core.js';
import type { EmbeddingsStore } from './embeddings-store.js';
import type { LexicalStore } from './lexical-store.js';
import { checkParams } from './params.js';
import {
  bindPolicy,
  DEFAULT_SALIENCE_CONFIG,
  type ExpansionResolver,
  handleRecallRequest,
  type ReadPolicyCheck,
  type RecallInput,
  type RecallRow,
  type SalienceConfig,
  type SpreadResolver,
  type WritePolicyCheck
} from './recall-route.js';
import { callerFromContext } from './row-visibility.js';
import { handleSalienceBoost, validateBoostInput } from './salience-boost-core.js';

/**
 * Dependencies for the recall frame surface. Threaded by `createRecallPlugin`
 * from the same deps the kernelRoutes use, so frame + HTTP behaviour match.
 */
export interface RecallFrameDeps {
  /** Lexical arm store. Absent → the lexical arm does not run. */
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
  embedder?: Embedder;
  store: EmbeddingsStore;
  salience?: SalienceConfig;
  spreadResolver: SpreadResolver;
  expansionResolver: ExpansionResolver;
  expansionEnabled: boolean;
  stats?: EmbedStats;
  /**
   * Unbound 3-arg read-policy check (the plugin config form). Each resolver
   * binds `ctx.identity` into a 2-arg check the cores accept — the frame mirror
   * of routes binding `req.identity`.
   */
  checkReadPolicy?: ReadPolicyCheck;
  /**
   * Write-policy probe. The frame path reaches the SAME mutating cores as the
   * kernel routes, so it must carry the same gate.
   */
  checkWritePolicy?: WritePolicyCheck;
  /** Crystallisation deps. Absent = recall/Cluster is not published. */
  clusterSurface?: ClusterSurfaceDeps;
}

const scalar = (type: FieldDefScalarType): FieldDef => ({ kind: 'scalar', type });
type FieldDefScalarType = 'string' | 'number' | 'boolean' | 'date' | 'json';

/** Published field shape for a `recall/Hit` row. Names mirror the resolver output exactly. */
export const HIT_FIELDS: Record<string, FieldDef> = {
  id: scalar('string'),
  namespace: scalar('string'),
  type: scalar('string'),
  score: scalar('number'),
  salience: scalar('number'),
  blendedScore: scalar('number'),
  kind: scalar('string'),
  expandedFrom: scalar('json'),
  vector: scalar('json'),
  row: scalar('json')
};

function bad(message: string): never {
  throw new ResolverFrameError('bad_request', message);
}

/**
 * Everything the `recall/Hit` frame accepts. Deliberately spells the search
 * text `to` — THIS surface's name for it — so a refusal tells a caller what to
 * send here rather than what the route wants. The message is generated from
 * this array, so the two cannot disagree.
 */
const FRAME_PARAMS = [
  'to',
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

/**
 * Parse + validate the `recall/Hit` params into a `RecallInput`. Matches the
 * RecallInput surface exactly (to → query, k, namespace, type, threshold,
 * expand, boost, returnVector, lexical, explain, where). Wrong types throw
 * `bad_request`; `where` is passed through for the core to validate.
 */
export function parseHitParams(params: Record<string, unknown> | undefined): RecallInput {
  const p = params ?? {};
  const unknown = checkParams(p as Record<string, unknown>, FRAME_PARAMS);
  // `query` stays out of the allowed set so the cross-surface hint below keeps
  // firing on the one confusion this pair actually causes.
  if (unknown !== null && p.query === undefined) bad(unknown);
  if (typeof p.to !== 'string' || p.to.length === 0) {
    // Recall's search text is `to` here and `query` on the route and the MCP
    // tool. Renaming either breaks callers, so the refusal names the other
    // spelling instead.
    bad(
      typeof p.query === 'string' && p.query.length > 0
        ? '"to" must be a non-empty string — this is the FRAME surface, which spells the search text `to`; you passed `query`, which is the spelling POST /substrate/v1/recall and the MCP tool use'
        : '"to" must be a non-empty string (the FRAME surface spells the search text `to`; POST /substrate/v1/recall and the MCP tool call it `query`)'
    );
  }
  const input: RecallInput = { query: p.to as string };
  if (p.k !== undefined) {
    if (typeof p.k !== 'number') bad('"k" must be a number');
    input.k = p.k;
  }
  if (p.namespace !== undefined) {
    if (typeof p.namespace !== 'string') bad('"namespace" must be a string');
    input.namespace = p.namespace;
  }
  if (p.type !== undefined) {
    if (typeof p.type !== 'string') bad('"type" must be a string');
    input.type = p.type;
  }
  if (p.threshold !== undefined) {
    if (typeof p.threshold !== 'number') bad('"threshold" must be a number');
    input.threshold = p.threshold;
  }
  if (p.lexicalThreshold !== undefined) {
    if (typeof p.lexicalThreshold !== 'number') bad('"lexicalThreshold" must be a number');
    input.lexicalThreshold = p.lexicalThreshold;
  }
  if (p.expand !== undefined) {
    if (typeof p.expand !== 'boolean') bad('"expand" must be a boolean');
    input.expand = p.expand;
  }
  if (p.boost !== undefined) {
    if (typeof p.boost !== 'boolean') bad('"boost" must be a boolean');
    input.boost = p.boost;
  }
  if (p.returnVector !== undefined) {
    if (typeof p.returnVector !== 'boolean') bad('"returnVector" must be a boolean');
    input.returnVector = p.returnVector;
  }
  if (p.lexical !== undefined) {
    if (typeof p.lexical !== 'boolean') bad('"lexical" must be a boolean');
    input.lexical = p.lexical;
  }
  if (p.explain !== undefined) {
    if (typeof p.explain !== 'boolean') bad('"explain" must be a boolean');
    input.explain = p.explain;
  }
  // Passed through unvalidated: the core validates the filter's shape.
  if (p.where !== undefined) input.where = p.where as NonNullable<RecallInput['where']>;
  return input;
}

/**
 * Re-raise a coded core throw as a `ResolverFrameError` so the engine surfaces
 * the same code the HTTP route maps to a status. `policy_denied` / `bad_request`
 * pass through verbatim; embedder `unavailable` / `invalid_response` become
 * `embedder_*` (route 503 parity). Anything uncoded rethrows raw.
 */
function rethrowCoded(err: unknown): never {
  const code = (err as { code?: string } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'policy_denied' || code === 'bad_request') {
    throw new ResolverFrameError(code, message);
  }
  if (code === 'unavailable' || code === 'invalid_response') {
    throw new ResolverFrameError(`embedder_${code}`, message);
  }
  // No arm could run. Both codes pass through verbatim: they distinguish
  // "nothing is wired" from "you switched off the only arm".
  if (code === 'embedder_unavailable' || code === 'no_retrieval_arm') {
    throw new ResolverFrameError(code, message);
  }
  throw err;
}

/**
 * Keep only the selected keys of `fields`; `undefined` fields = passthrough.
 * `fields: {}` strips every key, matching the compose layer's projectEnvelope.
 * A nested `row: { … }` selection keeps `row`, which the core has already
 * narrowed through `rowFields`.
 */
function projectHit(row: Row, fields: Record<string, unknown> | undefined): Row {
  if (fields === undefined) return row;
  const keep = Object.entries(fields)
    .filter(([k, v]) => v === true || (k === 'row' && isPlainObject(v)))
    .map(([k]) => k);
  const out: Record<string, unknown> = {};
  for (const k of keep) {
    if (k in row) out[k] = (row as Record<string, unknown>)[k];
  }
  return out as Row;
}

function hitRow(r: RecallRow): Row {
  return {
    id: String(r.row.id ?? ''),
    namespace: r.namespace,
    type: r.type,
    score: r.score,
    salience: r._salience,
    blendedScore: r._blendedScore,
    kind: r._expandedFrom === undefined ? 'seed' : 'expansion',
    ...(r._expandedFrom !== undefined ? { expandedFrom: r._expandedFrom } : {}),
    ...(r.vector !== undefined ? { vector: r.vector } : {}),
    row: r.row
  };
}

export function buildRecallFrameSurface(deps: RecallFrameDeps): KernelNamespaceContribution {
  const salience = deps.salience ?? DEFAULT_SALIENCE_CONFIG;

  const hitResolver = async (ctx: RequestContext, args: ResolverArgs): Promise<Row[]> => {
    // No pre-gate: the core decides whether any arm can run, and
    // `rethrowCoded` maps its refusal.
    const input = parseHitParams(args.params);
    const rowSelection = args.fields?.row;
    if (rowSelection === true) input.rowFields = true;
    else if (isPlainObject(rowSelection)) input.rowFields = rowSelection as Record<string, true>;
    const bound = bindPolicy(deps.checkReadPolicy, callerFromContext(ctx));
    const boundWrite = bindPolicy(deps.checkWritePolicy, callerFromContext(ctx));
    let out: Awaited<ReturnType<typeof handleRecallRequest>>;
    try {
      out = await handleRecallRequest(input, {
        ...(deps.embedder !== undefined ? { embedder: deps.embedder } : {}),
        store: deps.store,
        ...(deps.lexicalStore !== undefined ? { lexicalStore: deps.lexicalStore } : {}),
        ...(deps.lexicalSources !== undefined ? { lexicalSources: deps.lexicalSources } : {}),
        ...(deps.embedSources !== undefined ? { embedSources: deps.embedSources } : {}),
        salience,
        spreadResolver: deps.spreadResolver,
        expansionResolver: deps.expansionResolver,
        expansionEnabled: deps.expansionEnabled,
        ...(boundWrite !== undefined ? { checkWritePolicy: boundWrite } : {}),
        ...(deps.stats !== undefined ? { stats: deps.stats } : {}),
        ...(bound !== undefined ? { checkReadPolicy: bound } : {}),
        caller: callerFromContext(ctx)
      });
    } catch (err) {
      rethrowCoded(err);
    }
    return out.rows.map((r) => projectHit(hitRow(r), args.fields));
  };

  const boostResolver = async (ctx: RequestContext, args: ResolverArgs): Promise<Row> => {
    const bound = bindPolicy(deps.checkReadPolicy, callerFromContext(ctx));
    const boundWrite = bindPolicy(deps.checkWritePolicy, callerFromContext(ctx));
    try {
      const input = validateBoostInput(args.params);
      const result = await handleSalienceBoost(input, {
        store: deps.store,
        halfLifeHours: salience.halfLifeHours,
        ...(bound !== undefined ? { checkReadPolicy: bound } : {}),
        ...(boundWrite !== undefined ? { checkWritePolicy: boundWrite } : {}),
        caller: callerFromContext(ctx),
        ...(deps.embedder !== undefined ? { model: deps.embedder.modelId } : {})
      });
      // Mutations must return a Row (id required); 'ack' is a sentinel, never a real row id.
      return { id: 'ack', ...result };
    } catch (err) {
      rethrowCoded(err);
    }
  };

  const fetchEmbeddingsResolver = async (ctx: RequestContext, args: ResolverArgs): Promise<Row> => {
    const bound = bindPolicy(deps.checkReadPolicy, callerFromContext(ctx));
    const boundWrite = bindPolicy(deps.checkWritePolicy, callerFromContext(ctx));
    try {
      const input = validateFetchInput(args.params);
      const result = await handleEmbeddingsFetch(input, {
        store: deps.store,
        salience,
        ...(deps.embedder !== undefined ? { embedder: deps.embedder } : {}),
        ...(bound !== undefined ? { checkReadPolicy: bound } : {}),
        ...(boundWrite !== undefined ? { checkWritePolicy: boundWrite } : {}),
        caller: callerFromContext(ctx)
      });
      // Mutations must return a Row (id required); 'embeddings' is a sentinel, never a real row id.
      return { id: 'embeddings', ...result };
    } catch (err) {
      rethrowCoded(err);
    }
  };

  const clusterSurface =
    deps.clusterSurface === undefined ? undefined : buildClusterSurface(deps.clusterSurface);

  return {
    namespace: 'recall',
    types: {
      Hit: { fields: HIT_FIELDS, resolver: hitResolver },
      ...(clusterSurface?.types ?? {})
    },
    mutations: {
      boost: { resolver: boostResolver },
      fetchEmbeddings: { resolver: fetchEmbeddingsResolver },
      ...(clusterSurface?.mutations ?? {})
    }
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
