/**
 * stdio MCP server exposing Substrate's query/mutate/schema surface to
 * MCP-speaking agents. Spec: §5.7.
 *
 * Every tool is a thin JSON-over-HTTP proxy to a `/substrate/v1/*` route. Frame keys
 * are qualified (`<ns>/<Type>`, §4.7), so one call can fan across namespaces.
 * Subscribe / stream are WS-only and not exposed — stdio cannot host
 * long-lived push streams cleanly.
 *
 * Run by the `substrate mcp` subcommand via `runMcp`.
 */

import { tokenAudience } from '@mnmal-ai/substrate-client';
import type { NlAskRequest } from '@mnmal-ai/substrate-types';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// Baked at build time — the bundler inlines package.json, so the bundled
// binary carries the literal value.
import pkg from '../../package.json' with { type: 'json' };
import { makeAgentJwtProvider, resolveAgentCapabilities } from './agent-jwt.js';

/** The version the MCP server reports in its initialize serverInfo. */
export const MCP_SERVER_VERSION: string =
  typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0';

// Module-level provider; set once at server startup via configureAgentAuth.
let agentJwt: () => string | null = () => null;

/**
 * Call at MCP server startup (next to where SUBSTRATE_URL is read) to arm the
 * agent JWT; its `aud` is `endpoint`'s origin.
 */
export function configureAgentAuth(env: NodeJS.ProcessEnv, endpoint: string): void {
  agentJwt = makeAgentJwtProvider(env, new URL(endpoint).origin);
}

/** Request headers for `endpoint`; a token is only sent where `tokenAudience` allows. */
function authHeaders(endpoint: string, extra: Record<string, string>): Record<string, string> {
  const token = agentJwt();
  if (token === null) return extra;
  tokenAudience(endpoint);
  return { ...extra, authorization: token };
}

export interface ToolResultContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  [key: string]: unknown;
  content: ToolResultContent[];
  isError?: boolean;
}

export const payloadSchema = (example: string) =>
  z
    .unknown()
    .transform((raw, ctx): Record<string, unknown> => {
      if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            ctx.addIssue({ code: 'custom', message: 'payload must decode to a JSON object' });
            return z.NEVER;
          }
          return parsed as Record<string, unknown>;
        } catch {
          ctx.addIssue({ code: 'custom', message: 'payload must be valid JSON' });
          return z.NEVER;
        }
      }
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        ctx.addIssue({
          code: 'custom',
          message: 'payload must be an object or a JSON string decoding to an object'
        });
        return z.NEVER;
      }
      return raw as Record<string, unknown>;
    })
    .describe(example);

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function okResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function toMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // Include cause message when present — structured errors (e.g. NetworkError)
  // store the originating Error as cause rather than embedding it in message.
  if (err.cause instanceof Error && err.cause.message) {
    return `${err.message}: ${err.cause.message}`;
  }
  return err.message;
}

export interface RecallInput {
  query: string;
  k?: number | undefined;
  namespace?: string | undefined;
  type?: string | undefined;
  threshold?: number | undefined;
  lexicalThreshold?: number | undefined;
  /** Row-field filter, field -> `{ eq }` or `{ in }`. The server validates its shape. */
  where?: Record<string, unknown> | undefined;
}

export interface RecallOutput {
  rows: Array<{ row: Record<string, unknown>; score: number }>;
  model: string;
}

/**
 * POST a JSON body to a Substrate HTTP endpoint and return the parsed response.
 *
 * `errorMode` controls the !ok branch:
 *   - 'parsedError' — try to parse the response as Substrate's `{error: {message}}`
 *     envelope; throw the inner message. Falls back to `HTTP <status>` if the
 *     body isn't shaped that way. Used by /substrate/v1/recall.
 *   - 'textPreview' (default) — read the response as text and throw a
 *     `POST <path> returned <status>: <preview>` message capped at 500 chars.
 *     Used by /substrate/v1/nl + /substrate/v1/_system/drop-{namespace,type}.
 */
async function postSubstrate<T>(
  endpoint: string,
  path: string,
  body: unknown,
  errorMode: 'parsedError' | 'textPreview' = 'textPreview'
): Promise<T> {
  const url = `${endpoint.replace(/\/+$/, '')}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(endpoint, {
        'content-type': 'application/json',
        accept: 'application/json'
      }),
      body: JSON.stringify(body),
      // A redirect would carry the token to wherever it points.
      redirect: 'error'
    });
  } catch (err) {
    throw new Error(
      `Substrate request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    if (errorMode === 'parsedError') {
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        /* fall through to HTTP status */
      }
      // Envelopes come nested (`{ error: { message } }`) or flat (`{ code, message }`).
      const env =
        parsed !== null && typeof parsed === 'object'
          ? (parsed as { error?: { message?: string }; message?: unknown })
          : undefined;
      const flat = typeof env?.message === 'string' ? env.message : undefined;
      const message =
        env !== undefined && 'error' in env
          ? (env.error?.message ?? flat ?? 'unknown error')
          : (flat ?? `HTTP ${res.status}`);
      throw new Error(message);
    }
    const preview = await res.text().catch(() => '<unreadable>');
    throw new Error(`POST ${path} returned ${res.status}: ${preview.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

/**
 * GET a JSON body from a Substrate HTTP endpoint and return the parsed response.
 * The read-only sibling of `postSubstrate` — used for `/substrate/v1/federated-schema`.
 * Non-2xx throws `GET <path> returned <status>: <preview>` (capped 500 chars);
 * a transport failure wraps the cause with the failing URL.
 */
async function getSubstrate<T>(endpoint: string, path: string): Promise<T> {
  const url = `${endpoint.replace(/\/+$/, '')}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: authHeaders(endpoint, { accept: 'application/json' }),
      redirect: 'error'
    });
  } catch (err) {
    throw new Error(
      `Substrate request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    const preview = await res.text().catch(() => '<unreadable>');
    throw new Error(`GET ${path} returned ${res.status}: ${preview.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

/** Test seam: temporarily swap the agent JWT provider, run getSubstrate, then restore. */
export async function getSubstrateForTest<T>(
  endpoint: string,
  path: string,
  provider: () => string | null
): Promise<T> {
  const prev = agentJwt;
  agentJwt = provider;
  try {
    return await getSubstrate<T>(endpoint, path);
  } finally {
    agentJwt = prev;
  }
}

export async function recall(endpoint: string, body: RecallInput): Promise<RecallOutput> {
  return postSubstrate<RecallOutput>(endpoint, '/substrate/v1/recall', body, 'parsedError');
}

export function createSchemaHandler(
  endpoint: string
): (args?: { namespace?: string; type?: string; shape?: string }) => Promise<ToolResult> {
  return async (args) => {
    // Scoped, cheap lookups when a namespace (and optionally a type) is given —
    // the right call before a create/update so you read the exact write contract
    // instead of pulling the whole federated schema. No args → federated.
    const ns = args?.namespace;
    const type = args?.type;
    const shape = args?.shape;
    let path = '/substrate/v1/federated-schema';
    if (ns !== undefined && ns !== '') {
      if (type !== undefined && type !== '') {
        // `shape` is only meaningful on the type route; the namespace route
        // would silently ignore it.
        const q = shape !== undefined && shape !== '' ? `?shape=${encodeURIComponent(shape)}` : '';
        path = `/substrate/v1/schema/${encodeURIComponent(ns)}/${encodeURIComponent(type)}${q}`;
      } else {
        path = `/substrate/v1/schema/${encodeURIComponent(ns)}`;
      }
    }
    try {
      const schema = await getSubstrate(endpoint, path);
      return okResult(schema);
    } catch (err) {
      return errorResult(toMessage(err));
    }
  };
}

export function createQueryHandler(
  endpoint: string
): (args: { payload: Record<string, unknown> }) => Promise<ToolResult> {
  return async ({ payload }) => {
    try {
      const envelope = await postSubstrate(endpoint, '/substrate/v1/query', payload);
      return okResult(envelope);
    } catch (err) {
      return errorResult(toMessage(err));
    }
  };
}

export function createMutateHandler(
  endpoint: string
): (args: { payload: Record<string, unknown> }) => Promise<ToolResult> {
  return async ({ payload }) => {
    try {
      const envelope = await postSubstrate(endpoint, '/substrate/v1/mutate', payload);
      return okResult(envelope);
    } catch (err) {
      return errorResult(toMessage(err));
    }
  };
}

export function createNlHandler(endpoint: string): (args: NlAskRequest) => Promise<ToolResult> {
  return async (args) => {
    try {
      return okResult(
        await postSubstrate<Record<string, unknown>>(endpoint, '/substrate/v1/nl', args)
      );
    } catch (err) {
      return errorResult(toMessage(err));
    }
  };
}

export interface ProposeTypeArgs {
  namespace: string;
  typeName: string;
  fields: Record<string, unknown>;
  proposedReason: string;
}

export function createProposeTypeHandler(
  endpoint: string
): (args: ProposeTypeArgs) => Promise<ToolResult> {
  return async ({ namespace, typeName, fields, proposedReason }) => {
    try {
      const payload = {
        [`${namespace}/propose_type`]: {
          params: { typeName, fields, proposedReason },
          fields: { id: true, typeName: true, applied: true, appliedAt: true }
        }
      };
      const envelope = await postSubstrate(endpoint, '/substrate/v1/mutate', payload);
      return okResult(envelope);
    } catch (err) {
      return errorResult(toMessage(err));
    }
  };
}

export interface ProposeFieldArgs {
  namespace: string;
  targetType: string;
  fieldName: string;
  fieldSpec: Record<string, unknown>;
  proposedReason: string;
}

export function createProposeFieldHandler(
  endpoint: string
): (args: ProposeFieldArgs) => Promise<ToolResult> {
  return async ({ namespace, targetType, fieldName, fieldSpec, proposedReason }) => {
    try {
      const payload = {
        [`${namespace}/propose_field`]: {
          params: { targetType, fieldName, fieldSpec, proposedReason },
          fields: { id: true, targetType: true, fieldName: true, applied: true, appliedAt: true }
        }
      };
      const envelope = await postSubstrate(endpoint, '/substrate/v1/mutate', payload);
      return okResult(envelope);
    } catch (err) {
      return errorResult(toMessage(err));
    }
  };
}

export interface DropNamespaceArgs {
  namespace: string;
  confirm: string;
  dryRun?: boolean | undefined;
  cascade?: 'refuse' | 'delete' | undefined;
}

export function createDropNamespaceHandler(
  endpoint: string
): (args: DropNamespaceArgs) => Promise<ToolResult> {
  return async (input) => {
    try {
      const result = await postSubstrate<unknown>(
        endpoint,
        '/substrate/v1/_system/drop-namespace',
        input
      );
      return okResult(result);
    } catch (err) {
      return errorResult(toMessage(err));
    }
  };
}

export interface DropTypeArgs {
  namespace: string;
  type: string;
  confirm: string;
  dryRun?: boolean | undefined;
  cascade?: 'refuse' | 'delete' | undefined;
}

export function createDropTypeHandler(
  endpoint: string
): (args: DropTypeArgs) => Promise<ToolResult> {
  return async (input) => {
    try {
      const result = await postSubstrate<unknown>(
        endpoint,
        '/substrate/v1/_system/drop-type',
        input
      );
      return okResult(result);
    } catch (err) {
      return errorResult(toMessage(err));
    }
  };
}

export interface McpServerOptions {
  /**
   * Comma-separated tool names to register (SUBSTRATE_MCP_TOOLS). Unset or blank
   * registers every tool. Every registered definition rides along on every
   * model call, so an agent that only queries and recalls should not carry
   * all ten.
   */
  tools?: string;
}

export function createMcpServer(endpoint: string, options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'substrate', version: MCP_SERVER_VERSION });

  // TOOLS table: each entry maps directly to a server.registerTool call.
  // Every handler is a thin JSON-over-HTTP closure over `endpoint` (no client
  // package) — the MCP bridge only does request/response (schema/query/mutate),
  // never the WS/subscribe path, so it speaks `/substrate/v1/*` JSON directly.
  const TOOLS: Array<{
    name: string;
    config: { description?: string; inputSchema?: Record<string, unknown> };
    // biome-ignore lint/suspicious/noExplicitAny: handler signatures vary per tool
    handler: (...args: any[]) => Promise<ToolResult>;
  }> = [
    {
      name: 'schema',
      config: {
        description:
          'Fetch the Substrate schema. No args → the full federated schema for every ' +
          'namespace (use sparingly; it is large). SCOPED + CHEAP: pass `namespace` ' +
          "for one namespace, or `namespace` + `type` for a single type's write " +
          'contract ({ fields, mutations }). Mine the scoped shape BEFORE a ' +
          'create/update so you send only declared fields — autoCRUD rejects ' +
          'undeclared fields with `unknown_field`. CHEAPER STILL: add ' +
          '`shape: "fields"` when you only need the type\'s field names and ' +
          'kinds — for an autoCRUD type the mutations restate the field block ' +
          'five times over, so the default answer costs about 6x the question.',
        inputSchema: {
          namespace: z
            .string()
            .min(1)
            .optional()
            .describe('Scope to one namespace, e.g. "notes". Omit for the full federated schema.'),
          type: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Scope to one type within `namespace`, e.g. "Todo" — returns its field defs + create/update param shapes. Requires `namespace`.'
            ),
          shape: z
            .enum(['full', 'fields'])
            .optional()
            .describe(
              'Projection of the type contract; requires `namespace` + `type`. "full" (default) inlines every mutation\'s params and returns. "fields" returns the field defs plus `mutationNames`, about a sixth the size — use it to answer "what fields does this type have".'
            )
        }
      },
      handler: createSchemaHandler(endpoint)
    },
    {
      name: 'query',
      config: {
        description:
          'Query Substrate. payload is a single frame object mapping qualified keys ' +
          '(<ns>/<Type>) to { params, fields }. ONE call can span multiple ' +
          'namespaces — e.g. { "prices/Price": {...}, "products/Product": {...} }.',
        inputSchema: {
          payload: payloadSchema(
            'Query frame. Example: { "default/Todo": { "params": { "limit": 20 }, ' +
              '"fields": { "id": true, "title": true } } }'
          )
        }
      },
      handler: createQueryHandler(endpoint)
    },
    {
      name: 'mutate',
      config: {
        description:
          'Run one or more mutations. payload is a single frame object mapping ' +
          'qualified keys (<ns>/<mutationName>) to { params, fields } (single-frame) ' +
          'or to an array of frames (batched atomic). ONE op-key can accept a ' +
          'single frame or an array. An ARRAY op-key is its own transaction: it ' +
          'commits or rolls back as a unit, independently of every other op-key ' +
          'in the call. The SINGLE-FRAME op-keys share one transaction when they ' +
          'sit on one tx scope (every namespace on one pg handle); across two ' +
          'tx scopes they are refused rather than split. So a single-frame ' +
          'op-key beside an array is NOT rolled back when the array fails — to ' +
          'make writes atomic together, put them in one array under one op-key. ' +
          'The memory dataset mints a fresh tx scope per namespace, so ' +
          'single-frame op-keys in two namespaces are refused there.',
        inputSchema: {
          payload: payloadSchema(
            'Mutation frame. Single: { "default/createTodo": { "params": { "title": "..." }, ' +
              '"fields": { "id": true } } }. Batched atomic: ' +
              '{ "default/updateTodo": [ { "params": { "id": "1", "done": true }, "fields": { "id": true } }, ' +
              '{ "params": { "id": "2", "done": true }, "fields": { "id": true } } ] }.'
          )
        }
      },
      handler: createMutateHandler(endpoint)
    },
    {
      name: 'ask',
      config: {
        description:
          'Ask a natural-language question of one namespace. The parser answers first; a constrained judge handles what it escalates; a judge outage hands off honestly. Returns { outcome, trail }, where outcome.kind is rows | recall | clarify | refuse. Read-only. Requires the @mnmal-ai/substrate-nl plugin (404 otherwise).',
        inputSchema: {
          namespace: z.string().min(1).describe('Namespace to ask, e.g. "notes".'),
          question: z.string().min(1).describe('The question, e.g. "open todos in billing".'),
          project: z
            .string()
            .min(1)
            .optional()
            .describe('Asking project; scopes project-bearing types.'),
          type: z
            .string()
            .min(1)
            .optional()
            .describe('force the reading to this type (resubmit a clarify option)')
        }
      },
      handler: createNlHandler(endpoint)
    },
    {
      name: 'propose_type',
      config: {
        description:
          'Propose a brand-new type in an owned namespace. The plugin writes a ' +
          'TypeProposal record and registers the type + autoCRUD surface (createX, ' +
          'getX, updateX, deleteX) at runtime — future queries/mutations against ' +
          'this type succeed immediately. Requires the `substrate.propose` capability. ' +
          'Use `propose_field` to extend an existing type; this tool rejects ' +
          'if the type already exists (structured error code `type_already_proposed` ' +
          'or `type_already_exists`).',
        inputSchema: {
          namespace: z
            .string()
            .min(1)
            .describe("Target namespace (must be in the plugin's ownedNamespaces)."),
          typeName: z.string().min(1).describe('PascalCase type name, e.g. "Dress".'),
          fields: z
            .record(z.string(), z.unknown())
            .describe(
              'Initial field map keyed by field name. Each value is a FieldSpecJson: ' +
                '{ kind: "scalar" | "crossRef" | "struct" | "list", ... }. ' +
                'Example: { "name": { "kind": "scalar", "type": "string" }, ' +
                '"owner": { "kind": "crossRef", "ns": "household", "type": "Person", "onDelete": "set_null" } }.'
            ),
          proposedReason: z
            .string()
            .min(1)
            .describe('Short human-readable justification. Why is this type being added?')
        }
      },
      handler: createProposeTypeHandler(endpoint)
    },
    {
      name: 'propose_field',
      config: {
        description:
          'Propose a new field on an existing type. Used for additive schema ' +
          'evolution AND for declaring edges (propose a crossRef field to model ' +
          'a relationship, including cross-namespace edges). Idempotent on exact ' +
          'spec match; rejects with `destructive_change_required` if a field of ' +
          'the same name exists with a different spec. Requires the `substrate.propose` ' +
          'capability.',
        inputSchema: {
          namespace: z
            .string()
            .min(1)
            .describe('Namespace containing the target type (must be in ownedNamespaces).'),
          targetType: z
            .string()
            .min(1)
            .describe('Existing type to extend. May be code-declared or previously proposed.'),
          fieldName: z.string().min(1).describe('camelCase field name to add.'),
          fieldSpec: z
            .record(z.string(), z.unknown())
            .describe(
              'Single FieldSpecJson: { kind: "scalar" | "crossRef" | "struct" | "list", ... }. ' +
                'For an edge: { "kind": "crossRef", "ns": "<target-ns>", "type": "<TargetType>", "onDelete": "set_null" }.'
            ),
          proposedReason: z.string().min(1).describe('Short human-readable justification.')
        }
      },
      handler: createProposeFieldHandler(endpoint)
    },
    {
      name: 'drop_namespace',
      config: {
        description:
          'Admin: physically delete every row + short-id for a given namespace. ' +
          'Refuses by default if any edge references the namespace; pass ' +
          'cascade="delete" to drop those edges too. Dry-run mode reports counts ' +
          'without mutating. Emits a AuditEvent { kind: "namespace_dropped" }. ' +
          'Requires the `admin` capability on the server side. ' +
          'DESTRUCTIVE — data cannot be recovered after a non-dry-run call.',
        inputSchema: {
          namespace: z.string().min(1).describe('Namespace to drop.'),
          confirm: z
            .string()
            .min(1)
            .describe('Must equal `namespace` exactly (confirmation gate).'),
          dryRun: z
            .boolean()
            .optional()
            .describe('If true, report counts and roll back — no actual deletion.'),
          cascade: z
            .enum(['refuse', 'delete'])
            .optional()
            .describe(
              'Behaviour when edges reference the namespace. Default "refuse" — aborts if any edges exist.'
            )
        }
      },
      handler: createDropNamespaceHandler(endpoint)
    },
    {
      name: 'drop_type',
      config: {
        description:
          'Admin: physically delete every row + short-id for a given (namespace, type). ' +
          'Same cascade + dry-run semantics as drop_namespace. Emits a ' +
          'AuditEvent { kind: "type_dropped" }. Requires the `admin` capability. ' +
          'DESTRUCTIVE — data cannot be recovered after a non-dry-run call.',
        inputSchema: {
          namespace: z.string().min(1).describe('Namespace containing the type to drop.'),
          type: z.string().min(1).describe('Type name to drop, e.g. "Todo".'),
          confirm: z
            .string()
            .min(1)
            .describe('Must equal "<namespace>/<type>" exactly (confirmation gate).'),
          dryRun: z
            .boolean()
            .optional()
            .describe('If true, report counts and roll back — no actual deletion.'),
          cascade: z
            .enum(['refuse', 'delete'])
            .optional()
            .describe(
              'Behaviour when edges reference the type. Default "refuse" — aborts if any edges exist.'
            )
        }
      },
      handler: createDropTypeHandler(endpoint)
    },
    {
      name: 'whoami',
      config: {
        description:
          'Ask the server who this MCP session is authenticated as. Returns ' +
          '{ authEnabled, identity }, where `identity` is null for an anonymous caller and ' +
          'otherwise carries { id, grants } — a namespace -> capabilities map, AS RECORDED, so a ' +
          "wildcard stays a `'*'` key rather than expanding into every namespace. " +
          'USE THIS BEFORE CONCLUDING A CREDENTIAL WORKS: on a reads-open stack an ' +
          'authenticated read and an anonymous one return byte-identical results, so a ' +
          'successful query is not evidence of identity. ' +
          '`authEnabled: false` means the deployment verifies nothing (a posture you cannot ' +
          'fix from here); `authEnabled: true` with `identity: null` means your own ' +
          'credential never arrived (SUBSTRATE_AGENT_KEY_ID / SUBSTRATE_AGENT_KEY_PATH). Those need ' +
          'different fixes, which is why they are separate fields.',
        inputSchema: {}
      },
      handler: async (): Promise<ToolResult> => {
        try {
          const answer = await getSubstrate(endpoint, '/substrate/v1/whoami');
          // Report what THIS CLIENT asked for beside what the server resolved.
          // The effective identity is claim INTERSECT row, so without this "the
          // row lacks admin" and "my token asked for less" render identically.
          // Labelled separately because it is a fact about this process.
          const claimed = resolveAgentCapabilities(process.env);
          return okResult({
            ...(answer as Record<string, unknown>),
            client: {
              claimedCapabilities: claimed,
              note:
                'What this MCP client ASKED for. The effective identity is this ' +
                'claim intersected with the registry row, so a capability absent ' +
                'here is unreachable however the row is granted. Widen with ' +
                'SUBSTRATE_AGENT_CAPABILITIES (csv).'
            }
          });
        } catch (err) {
          return errorResult(toMessage(err));
        }
      }
    },
    {
      name: 'recall',
      config: {
        description:
          'Semantic recall over embedded Substrate records. Returns top-K records by cosine similarity ' +
          'to the NL query. Use for finding prior context by meaning when structural ' +
          '`where`/`contains` queries miss. WHICH TYPES ARE EMBEDDED IS A SERVER FACT — ask it ' +
          '(`GET /substrate/v1/embed-stats` returns `embeddedTypes`) rather than assuming; a type is ' +
          'embedded iff its namespace definition declares an `embed.source`. The same operation ' +
          'is also reachable as `POST /substrate/v1/recall` (body param `query`) and as the frame key ' +
          '`recall/Hit` through query — where the search text is `params.to`, not ' +
          '`params.query` and not a `where` clause. See docs/surface-parity.md.',
        inputSchema: {
          query: z.string().min(1).describe('Natural-language query to embed and match against.'),
          k: z.number().int().min(1).max(100).optional().describe('Max results. Default 10.'),
          namespace: z
            .string()
            .optional()
            .describe(
              'Namespace to search. Pass it: there is no default. Omitted, the server ' +
                'falls back to ITS OWN SUBSTRATE_NAMESPACE and refuses with `missing_namespace` if that is unset.'
            ),
          type: z.string().min(1).describe('Type to search, e.g. "Note". Required.'),
          threshold: z.number().optional().describe('Minimum similarity (0..1). Default 0.'),
          lexicalThreshold: z
            .number()
            .optional()
            .describe(
              'Cosine floor for hits only the lexical (keyword) arm found. Default: same as ' +
                'threshold. 0 keeps them unfloored, so keyword matches survive a high threshold.'
            ),
          // Loose on purpose: the server validates the shape and names the fault.
          where: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              'Row-field filter applied inside every candidate source, so k fills with ' +
                'matching rows: field -> { eq: scalar | null } or { in: [scalar | null, ...] }, ' +
                'every field must match; eq null matches a missing or null field. Example: ' +
                '{ "project": { "in": ["substrate", null] } }.'
            )
        }
      },
      handler: async (input: RecallInput): Promise<ToolResult> => {
        try {
          const result = await recall(endpoint, input);
          return okResult(result);
        } catch (err) {
          return errorResult(toMessage(err));
        }
      }
    }
  ];

  const allowed = resolveToolAllowlist(
    options.tools,
    TOOLS.map((t) => t.name)
  );
  for (const t of TOOLS) {
    if (allowed !== null && !allowed.has(t.name)) continue;
    // biome-ignore lint/suspicious/noExplicitAny: config.inputSchema varies per tool
    server.registerTool(t.name, t.config as any, t.handler);
  }

  return server;
}

/**
 * Parse SUBSTRATE_MCP_TOOLS. `null` means register everything. An unknown name
 * throws: a typo that silently registered nothing would read as "this server
 * has no such tool", which is a worse failure than refusing to start.
 */
function resolveToolAllowlist(raw: string | undefined, known: string[]): Set<string> | null {
  if (raw === undefined || raw.trim() === '') return null;
  const names = raw
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n !== '');
  for (const n of names) {
    if (!known.includes(n)) {
      throw new Error(
        `SUBSTRATE_MCP_TOOLS: unknown tool '${n}'. Valid names: ${[...known].sort().join(', ')}`
      );
    }
  }
  return new Set(names);
}

/**
 * Boot the stdio MCP server. Resolves once the transport is connected; the
 * process keeps running until the host (Claude Code, etc.) closes stdio.
 */
export async function runMcp(): Promise<void> {
  const endpoint = process.env.SUBSTRATE_URL ?? 'http://localhost:3100';
  configureAgentAuth(process.env, endpoint);
  const server = createMcpServer(
    endpoint,
    process.env.SUBSTRATE_MCP_TOOLS === undefined ? {} : { tools: process.env.SUBSTRATE_MCP_TOOLS }
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
