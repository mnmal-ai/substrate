/**
 * recall MCP tool registration for the substrate plugin.
 *
 * `recallMcpTool(cfg)` returns a `McpToolRegistration` claim that
 * `createRecallPlugin` places in the `mcpTools` array of its
 * `KernelPlugin`. The handler delegates to `handleRecallRequest` — the
 * same pure function the HTTP recall route uses — so MCP and HTTP recall
 * return identical shapes for identical queries.
 */

import type { Embedder } from '@mnmal-ai/substrate-embedder';
import type { McpToolRegistration } from '@mnmal-ai/substrate-types';
import type { EmbedStats } from './embed-stats.js';
import type { EmbeddingsStore } from './embeddings-store.js';
import type { LexicalStore } from './lexical-store.js';
import { checkParams } from './params.js';
import {
  bindPolicy,
  DEFAULT_SALIENCE_CONFIG,
  type ExpansionResolver,
  handleRecallRequest,
  type ReadPolicyCheck,
  type SalienceConfig,
  type SpreadResolver,
  type WritePolicyCheck
} from './recall-route.js';
import { anonymousCaller } from './row-visibility.js';

/**
 * Everything `recall` accepts. Spells the search text `query`, matching
 * the route rather than the frame — the MCP tool is a route-shaped surface.
 * `boost` and `returnVector` are accepted because the core honours them,
 * even though the declared inputSchema does not advertise them.
 */
const MCP_PARAMS = [
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

export interface RecallMcpToolConfig {
  embedder?: Embedder;
  store: EmbeddingsStore;
  /**
   * Lexical arm store. Absent → this surface runs
   * dense-only and the response's `arms.lexicalWhy` says `no-store`.
   */
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
   * Salience blend config. Threaded into `handleRecallRequest`
   * so MCP recall ranks + boosts identically to the HTTP route.
   * When omitted, falls back to `DEFAULT_SALIENCE_CONFIG` (weight=0 → off).
   */
  salience?: SalienceConfig;
  /** Spread-target resolver. When omitted, spreading is skipped. */
  spreadResolver?: SpreadResolver;
  /** Expansion resolver. When omitted, `expand:true` is a no-op. */
  expansionResolver?: ExpansionResolver;
  /**
   * Plugin-level kill-switch for expansion. When false, `expand:true` in the
   * MCP input is ignored. Defaults to `true`.
   */
  expansionEnabled?: boolean;
  /** Optional stats counter — records expansion failures for `/substrate/v1/embed-stats`. */
  stats?: EmbedStats;
  /**
   * Unbound read-policy check. This MCP surface has no identity
   * channel, so the handler binds `null` — fail-closed under a gated read
   * posture, unchanged under open postures. Absent → open.
   */
  checkReadPolicy?: ReadPolicyCheck;
  /** Unbound write-policy check — bound to a null identity here. */
  checkWritePolicy?: WritePolicyCheck;
}

export function recallMcpTool(cfg: RecallMcpToolConfig): McpToolRegistration {
  return {
    name: 'recall',
    description:
      'Semantic recall over embedded Substrate records. Returns top-K records by cosine ' +
      'similarity to the natural-language query. Provide a query plus optional ' +
      'namespace/type filters. Requires an embedder configured in substrate-recall.config.json. AN EMPTY RESULT IS ' +
      "NOT NECESSARILY A MISS: read `arms` on the response. `denseWhy: 'no-source'` means the " +
      'type declares no `embed.source`, so it has no vectors and this query could never have ' +
      'matched — ask GET /substrate/v1/embed-stats which types are embedded, rather than concluding ' +
      'nothing is recorded. Set `expand:true` ' +
      'to additionally walk opt-in `spread` crossRefs from the top-K hits, fetch ' +
      'neighbour embeddings, compute fresh cosine, and merge into the re-ranked top-K. Off ' +
      'by default; preserves byte-identical behaviour when omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language query to embed and match against.'
        },
        namespace: {
          type: 'string',
          description:
            'Namespace to search. Falls back to $SUBSTRATE_NAMESPACE; required if that is unset.'
        },
        type: {
          type: 'string',
          description: 'Type to search. Required: there is no default.'
        },
        k: { type: 'number', description: 'Max results. Default 10.' },
        threshold: { type: 'number', description: 'Minimum cosine similarity (0..1). Default 0.' },
        lexicalThreshold: {
          type: 'number',
          description:
            'Cosine floor for hits only the lexical arm found. Default: same as threshold. 0 keeps them unfloored, including rows with no stored vector.'
        },
        expand: {
          type: 'boolean',
          description:
            'When true, walk opt-in crossRefs from the top-K hits and include neighbour scores. Default false.'
        },
        lexical: {
          type: 'boolean',
          description:
            'Set false to DISABLE the lexical (keyword) arm for this call. On by default wherever a lexical store is wired and the type declares a `lexical.source` — the declaration is the opt-in, so this exists to turn the arm off, not on. The response `arms` field reports what actually ran.'
        },
        explain: {
          type: 'boolean',
          description:
            'Return per-arm ranks (`_arms`) and the pre-fusion dense score (`_denseScore`) on each row. A fused score alone cannot say which arm put a row where it is.'
        },
        where: {
          type: 'object',
          description:
            'Row-field filter applied inside every candidate source, so k fills with matching rows: field -> { eq: scalar | null } or { in: [scalar | null, ...] }, every field must match. eq null matches a missing or null field. Example: { "project": { "in": ["substrate", null] } }.'
        }
      },
      required: ['query', 'type']
    },
    handler: async (input: unknown): Promise<unknown> => {
      // No embedder pre-gate: the core decides which arms can run (a
      // lexical-only deployment needs no embedder); the catch maps its refusal.
      //
      // An MCP client may not enforce the declared inputSchema, so unknown
      // params are refused here rather than silently dropped by the core.
      if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
        const unknown = checkParams(input as Record<string, unknown>, MCP_PARAMS);
        if (unknown !== null) {
          return { error: { code: 'bad_request', message: unknown } };
        }
      }
      const unbound = cfg.checkReadPolicy;
      const unboundWrite = cfg.checkWritePolicy;
      try {
        const caller = anonymousCaller();
        return await handleRecallRequest(input as Parameters<typeof handleRecallRequest>[0], {
          ...(cfg.embedder !== undefined ? { embedder: cfg.embedder } : {}),
          store: cfg.store,
          // Each recall surface hand-copies its deps into `handleRecallRequest`:
          // a dep added to the shared bag reaches no surface until copied here.
          ...(cfg.lexicalStore !== undefined ? { lexicalStore: cfg.lexicalStore } : {}),
          ...(cfg.lexicalSources !== undefined ? { lexicalSources: cfg.lexicalSources } : {}),
          ...(cfg.embedSources !== undefined ? { embedSources: cfg.embedSources } : {}),
          salience: cfg.salience ?? DEFAULT_SALIENCE_CONFIG,
          spreadResolver: cfg.spreadResolver ?? null,
          expansionResolver: cfg.expansionResolver ?? null,
          expansionEnabled: cfg.expansionEnabled ?? true,
          ...(cfg.stats !== undefined ? { stats: cfg.stats } : {}),
          // No identity channel on this surface — bind null.
          ...(unbound !== undefined ? { checkReadPolicy: bindPolicy(unbound, caller) } : {}),
          // Same anonymous caller for the write gate, so this surface does not
          // boost on a namespace requiring identity to write. Intended: it
          // cannot say who is asking.
          ...(unboundWrite !== undefined
            ? { checkWritePolicy: bindPolicy(unboundWrite, caller) }
            : {}),
          caller
        });
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (
          code === 'bad_request' ||
          code === 'policy_denied' ||
          code === 'embedder_unavailable' ||
          code === 'no_retrieval_arm'
        ) {
          return {
            error: { code, message: err instanceof Error ? err.message : code }
          };
        }
        throw err;
      }
    }
  };
}
