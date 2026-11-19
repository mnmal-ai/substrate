/**
 * stdio MCP server exposing Substrate's query/mutate/schema surface to
 * MCP-speaking agents. Spec: §5.7.
 *
 * Every tool is a thin JSON-over-HTTP proxy to a `/substrate/v1/*` route. Frame keys
 * are qualified (`<ns>/<Type>`, §4.7), so one call can fan across namespaces.
 * Subscribe / stream are long-lived frame streams and not exposed — stdio cannot host
 * long-lived push streams cleanly.
 *
 * Run by the `substrate mcp` subcommand via `runMcp`.
 */

import {
  type ClientFromEnv,
  createClientFromEnv,
  DEFAULT_MAX_WRITES,
  substrateFetch,
  tokenAudience
} from '@mnmal-ai/substrate-client';
import type { NlAskRequest } from '@mnmal-ai/substrate-types';
import { stringifyJson, trimTrailingSlashes } from '@mnmal-ai/substrate-types';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// Baked at build time — the bundler inlines package.json, so the bundled
// binary carries the literal value.
import pkg from '../../package.json' with { type: 'json' };
import { makeAgentJwtProvider, resolveAgentCapabilities } from './agent-jwt.js';
import { runSandboxed } from './run-sandbox.js';
import {
  buildInstructions,
  expressionLines,
  LOCAL_EXPRESSIONS_NOTE,
  localExpressions,
  overviewLegend,
  schemaOverview,
  serverExpressions
} from './schema-overview.js';

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
            ctx.addIssue({
              code: 'custom',
              message:
                'payload must decode to a JSON object — e.g. { "default/Todo": { "params": { "limit": 5 }, "fields": { "id": true } } }'
            });
            return z.NEVER;
          }
          return parsed as Record<string, unknown>;
        } catch (err) {
          ctx.addIssue({
            code: 'custom',
            message: `payload must be valid JSON (${(err as Error).message})`
          });
          return z.NEVER;
        }
      }
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        ctx.addIssue({
          code: 'custom',
          message:
            'payload must be an object or a JSON string decoding to an object — e.g. { "default/Todo": { "params": { "limit": 5 }, "fields": { "id": true } } }'
        });
        return z.NEVER;
      }
      return raw as Record<string, unknown>;
    })
    .describe(example);

/**
 * query/mutate input: `payload`, plus any other keys kept, so a bare
 * `{ "<ns>/<Type>": ... }` frame reaches the handler (frameOf) instead of being
 * stripped and refused. Optional, so the SDK does not refuse the bare call first.
 */
const frameInputSchema = (example: string) =>
  z.object({ payload: payloadSchema(example).optional() }).loose();

export interface FrameArgs {
  [key: string]: unknown;
  payload?: Record<string, unknown> | undefined;
}

/** The frame a call carries: its `payload`, or the arguments themselves when every key is `<ns>/<name>`. */
function frameOf(args: FrameArgs): Record<string, unknown> | undefined {
  if (args.payload !== undefined) return args.payload;
  const keys = Object.keys(args).filter((k) => k !== 'payload');
  return keys.length > 0 && keys.every((k) => k.includes('/')) ? args : undefined;
}

const MISSING_PAYLOAD =
  'missing payload: wrap the frame as { "payload": { "<ns>/<Type>": { "params": {...}, "fields": {...} } } }';

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function okResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: stringifyJson(value) }] };
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
  /** Row-body projection: field -> `true`, or `true` for the whole body. Omitted → handles. */
  rowFields?: Record<string, true> | true | undefined;
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
  const url = `${trimTrailingSlashes(endpoint)}${path}`;
  let res: Response;
  try {
    res = await substrateFetch(url, {
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
  const url = `${trimTrailingSlashes(endpoint)}${path}`;
  let res: Response;
  try {
    res = await substrateFetch(url, {
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

/** The server's expression catalogue, or undefined when it publishes none (an older server, or no default namespace). */
async function expressionsOf(endpoint: string) {
  try {
    return serverExpressions(await getSubstrate<unknown>(endpoint, '/substrate/v1/schema'));
  } catch {
    return undefined;
  }
}

export function createSchemaHandler(
  endpoint: string
): (args?: {
  namespace?: string;
  type?: string;
  shape?: string;
  full?: boolean;
}) => Promise<ToolResult> {
  return async (args) => {
    // Scoped, cheap lookups when a namespace (and optionally a type) is given —
    // the right call before a create/update so you read the exact write contract
    // instead of pulling the whole federated schema. No args → the compact
    // overview; `full: true` → the whole federated schema.
    const ns = args?.namespace;
    const type = args?.type;
    const shape = args?.shape;
    if ((ns === undefined || ns === '') && args?.full !== true) {
      try {
        const [federated, catalogue] = await Promise.all([
          getSubstrate<Parameters<typeof schemaOverview>[0]>(
            endpoint,
            '/substrate/v1/federated-schema'
          ),
          expressionsOf(endpoint)
        ]);
        return okResult({
          legend: overviewLegend,
          overview: schemaOverview(federated),
          expressions: expressionLines(catalogue ?? localExpressions),
          ...(catalogue === undefined ? { expressionsNote: LOCAL_EXPRESSIONS_NOTE } : {})
        });
      } catch (err) {
        return errorResult(toMessage(err));
      }
    }
    let path = '/substrate/v1/federated-schema';
    if ((ns === undefined || ns === '') && args?.full === true) {
      try {
        const [federated, catalogue] = await Promise.all([
          getSubstrate<Record<string, unknown>>(endpoint, path),
          expressionsOf(endpoint)
        ]);
        return okResult({
          ...federated,
          $expressions: catalogue ?? { ...localExpressions, note: LOCAL_EXPRESSIONS_NOTE }
        });
      } catch (err) {
        return errorResult(toMessage(err));
      }
    }
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

export function createQueryHandler(endpoint: string): (args: FrameArgs) => Promise<ToolResult> {
  return async (args) => {
    const payload = frameOf(args);
    if (payload === undefined) return errorResult(MISSING_PAYLOAD);
    try {
      const envelope = await postSubstrate(endpoint, '/substrate/v1/query', payload);
      return okResult(envelope);
    } catch (err) {
      return errorResult(toMessage(err));
    }
  };
}

/** The refusal codes that mean the frame's params do not fit the type. */
const SHAPE_CODES = new Set([
  'unknown_field',
  'missing_required_field',
  'invalid_enum_value',
  'invalid_field_type'
]);

interface EnvelopeError {
  code?: string;
  path?: unknown[];
}

/** The type a generated mutation key writes, or null for any other key. */
function typeOfOp(key: string): { ns: string; type: string } | null {
  const slash = key.indexOf('/');
  if (slash < 1) return null;
  const m = /^(create|update|upsert|delete)(Many)?([A-Z][A-Za-z0-9_]*)$/.exec(key.slice(slash + 1));
  return m?.[3] === undefined ? null : { ns: key.slice(0, slash), type: m[3] };
}

/** Each shape-refused type's write contract, keyed `<ns>/<Type>`; undefined when there is none. */
async function shapeContracts(
  endpoint: string,
  errors: EnvelopeError[]
): Promise<Record<string, unknown> | undefined> {
  const types = new Map<string, { ns: string; type: string }>();
  for (const e of errors) {
    if (e.code === undefined || !SHAPE_CODES.has(e.code)) continue;
    const t = typeof e.path?.[0] === 'string' ? typeOfOp(e.path[0]) : null;
    if (t !== null) types.set(`${t.ns}/${t.type}`, t);
  }
  const fetched = await Promise.all(
    [...types].map(async ([key, { ns, type }]) => {
      try {
        const path = `/substrate/v1/schema/${encodeURIComponent(ns)}/${encodeURIComponent(type)}?shape=fields`;
        return [key, await getSubstrate(endpoint, path)] as const;
      } catch {
        return null;
      }
    })
  );
  const found = fetched.filter((f) => f !== null);
  return found.length === 0 ? undefined : Object.fromEntries(found);
}

export function createMutateHandler(endpoint: string): (args: FrameArgs) => Promise<ToolResult> {
  return async (args) => {
    const payload = frameOf(args);
    if (payload === undefined) return errorResult(MISSING_PAYLOAD);
    try {
      const envelope = await postSubstrate<{ errors?: EnvelopeError[] }>(
        endpoint,
        '/substrate/v1/mutate',
        payload
      );
      const contract = await shapeContracts(endpoint, envelope.errors ?? []);
      return okResult(contract === undefined ? envelope : { ...envelope, contract });
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
  orderedBy?: Record<string, 'asc' | 'desc'>;
  indexes?: Record<string, unknown>[];
  expectedSize?: 'small' | 'large';
}

export function createProposeTypeHandler(
  endpoint: string
): (args: ProposeTypeArgs) => Promise<ToolResult> {
  return async ({ namespace, ...params }) => {
    try {
      const payload = {
        [`${namespace}/propose_type`]: {
          params,
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

export interface ProposeIndexArgs {
  namespace: string;
  type: string;
  action: 'add' | 'remove' | 'dismiss' | 'orderedBy';
  reason: string;
  recommendationId?: string | undefined;
  declaration?: Record<string, unknown> | undefined;
  orderedBy?: Record<string, 'asc' | 'desc'> | undefined;
  indexName?: string | undefined;
}

/** `propose_index` lives on the proposals control plane; `namespace` names the target. */
export function createProposeIndexHandler(
  endpoint: string
): (args: ProposeIndexArgs) => Promise<ToolResult> {
  return async (args) => {
    try {
      const params = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
      const payload = {
        '_system_proposals/propose_index': {
          params,
          fields: { id: true, action: true, namespace: true, type: true, indexName: true }
        }
      };
      return okResult(await postSubstrate(endpoint, '/substrate/v1/mutate', payload));
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

/**
 * `run`: one script, sandboxed (Decision #642), signed as this MCP server's
 * agent. The client is made on first use and kept: building it reads the key.
 */
export function createRunHandler(env: NodeJS.ProcessEnv = process.env) {
  let signed: ClientFromEnv | undefined;
  return async (
    input: {
      script: string;
      args?: Record<string, unknown>;
      mode?: 'read' | 'dry-run' | 'write';
      maxWrites?: number;
    },
    // The MCP SDK's request extra: its signal fires when the caller cancels the call.
    extra?: { signal?: AbortSignal }
  ): Promise<ToolResult> => {
    try {
      signed ??= createClientFromEnv({ env, allowAnonymous: true });
      if (signed.kid === null) {
        return errorResult(
          'run needs an agent identity: set SUBSTRATE_AGENT_KEY_ID and SUBSTRATE_AGENT_KEY_PATH'
        );
      }
      const report = await runSandboxed(input.script, {
        client: signed.client,
        kid: signed.kid,
        mode: input.mode ?? 'read',
        args: input.args ?? {},
        maxWrites: input.maxWrites ?? DEFAULT_MAX_WRITES,
        log: () => {},
        ...(extra?.signal !== undefined ? { signal: extra.signal } : {})
      });
      return report.ok ? okResult(report) : { ...okResult(report), isError: true };
    } catch (err) {
      return errorResult(toMessage(err));
    }
  };
}

export interface McpServerOptions {
  /**
   * Comma-separated tool names and presets to register (SUBSTRATE_MCP_TOOLS):
   * `core` or `all`. Unset or blank means `core`.
   * Every registered definition rides along on every model call.
   */
  tools?: string;
  /** Sent to the client at initialize; clients put it in the agent's context. */
  instructions?: string;
}

const WALK_DESCRIPTION =
  ' Walks: `_walk: { in: "ns/Type.field" }` follows a reference backwards (overview: `←Type.field`), `out: "field"` forwards; it filters in `where`, nests rows in `fields`, aggregates in `fields._agg`. E.g. orders with an item over 50, with item count: { "shop/Order": { "params": { "where": { "_walk": { "in": "shop/Item.order", "where": { "price": { "gt": 50 } } } } }, "fields": { "_agg": { "items": { "in": "shop/Item.order", "count": true } } } } }. `quantifier`: "any" (default), "none", "all"; `pick`: { latest | max | min: field }. An "any" walk binds `as: "L"`, read later as { "$ref": "L.price", "times": 1.25 } (`$.f` seed row, `_agg.<n>` aggregate; `times`/`plus` scale, `plus` on a date shifts ms). `_agg`: count, avg/sum/min/max: field, latest: { by, value }; in `where` it compares: { "_agg": {...}, "gte": 3 }. Params: `count: true`; `aggregate: { n: { sum: "price" } }`, per group with `groupBy: { day: { dateTrunc: [{ "lit": "day" }, "seenAt"] } }`, `having`, `offset`; `select: { m: { sub: ["_agg.x", "price"] } }` adds a value, sortable in `orderBy`. An expression is a field name, a literal, { "lit": "text" } or { "fn": [args] }. Walks are query-only.';

export function createMcpServer(endpoint: string, options: McpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'substrate', version: MCP_SERVER_VERSION },
    options.instructions !== undefined ? { instructions: options.instructions } : undefined
  );

  // TOOLS table: each entry maps directly to a server.registerTool call.
  // Every handler is a thin JSON-over-HTTP closure over `endpoint` (no client
  // package) — the MCP bridge only does request/response (schema/query/mutate),
  // never the subscribe/stream path, so it speaks `/substrate/v1/*` JSON directly.
  const TOOLS: Array<{
    name: string;
    config: { description?: string; inputSchema?: Record<string, unknown> | z.ZodType };
    // biome-ignore lint/suspicious/noExplicitAny: handler signatures vary per tool
    handler: (...args: any[]) => Promise<ToolResult>;
  }> = [
    {
      name: 'schema',
      config: {
        description:
          "Schema lookup. No args: every namespace's types as `field: type` lines. `namespace`: one namespace. `namespace` + `type`: that type's write contract ({ fields, mutations }); read it before a create/update, since undeclared fields are refused (`unknown_field`). Compact answers name generated CRUD instead of repeating fields; `mutationRefs` explains. `full: true` with no namespace: the whole federated schema plus the expression catalogue (large).",
        inputSchema: {
          namespace: z.string().min(1).optional().describe('e.g. "notes"'),
          type: z.string().min(1).optional().describe('e.g. "Todo"; needs `namespace`'),
          shape: z
            .enum(['compact', 'full', 'fields'])
            .optional()
            .describe(
              'Type contract: "compact" (default), "fields" (fields + mutation names) or "full" (every block inlined)'
            ),
          full: z.boolean().optional().describe('No namespace: the whole federated schema')
        }
      },
      handler: createSchemaHandler(endpoint)
    },
    {
      name: 'query',
      config: {
        description:
          'Query. payload maps <ns>/<Type> keys (any namespaces) to { params, fields }; `schema` lists expression functions.' +
          WALK_DESCRIPTION,
        inputSchema: frameInputSchema(
          'Query frame. Example: { "default/Todo": { "params": { "limit": 20 }, ' +
            '"fields": { "id": true, "title": true } } }'
        )
      },
      handler: createQueryHandler(endpoint)
    },
    {
      name: 'mutate',
      config: {
        description:
          'Mutate. payload maps <ns>/<mutation> keys to { params, fields } or an array of them. An array under one key is one transaction. Single-frame keys share one transaction on one tx scope and are refused across two; a single-frame key beside an array is not rolled back with it, so writes that must land together go in one array. A shape-refused write returns its type contract as `contract`.',
        inputSchema: frameInputSchema(
          'Mutation frame. Single: { "default/createTodo": { "params": { "title": "..." }, ' +
            '"fields": { "id": true } } }. Batched atomic: ' +
            '{ "default/updateTodo": [ { "params": { "id": "1", "done": true }, "fields": { "id": true } }, ' +
            '{ "params": { "id": "2", "done": true }, "fields": { "id": true } } ] }. ' +
            'By filter: { "default/updateManyTodo": { "params": { "where": { "done": { "eq": false } }, ' +
            '"set": { "done": true } }, "fields": { "count": true, "ids": true, "idsTruncated": true } } }; ' +
            'deleteMany<Type> takes only "where".'
        )
      },
      handler: createMutateHandler(endpoint)
    },
    {
      name: 'run',
      config: {
        description:
          'Sandboxed script for 3+ dependent calls (paging, joins, read-driven writes). `script`: default export `async (s) => result`; type syntax is stripped. `s`: kid, mode, args, query(frame | key, entry) (throws if refused), queryAll(key, { params, fields }), byShortId(key, n | n[], fields?), recall({ query, namespace, type, k?, where?, row? }), schema(ns?, type?), mutate(frame | key, entry), log(). Modes: "read" (default, no mutate), "dry-run" (records only), "write". Dry-run, check report.mutations, then write. Return ids/counts.',
        inputSchema: {
          script: z
            .string()
            .min(1)
            .describe("e.g. export default async (s) => (await s.queryAll('ns/Todo', {})).length"),
          args: z.record(z.string(), z.unknown()).optional().describe('Passed as s.args'),
          mode: z.enum(['read', 'dry-run', 'write']).optional().describe('Default "read"'),
          maxWrites: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('Write mode: max mutate frames, default 50')
        }
      },
      handler: createRunHandler()
    },
    {
      name: 'ask',
      config: {
        description:
          'Ask a natural-language question of one namespace. The parser answers first; a constrained judge handles what it escalates; a judge outage hands off honestly. Returns { outcome, trail }, where outcome.kind is rows | recall | clarify | refuse | unknown. unknown means part of the question was dropped and the answer would change which rows count; it carries dropped and the plan, and nothing ran. rows also carries dropped (what it does not reflect) and plan; an answer of count carries count, and one of aggregate carries aggregate (fn, field, and a value or groups keyed by `by`; a count per unit arrives as aggregate with fn `count` and field `*`). Relative dates are read against asOf when given, else the server clock; the parsed trail event says which. Read-only. Requires the @mnmal-ai/substrate-nl plugin (404 otherwise).',
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
            .describe('force the reading to this type (resubmit a clarify option)'),
          asOf: z
            .string()
            .min(1)
            .optional()
            .describe(
              '"now" for relative dates ("yesterday", "last week") and month-day year inference; a bare month or year ("in march", "in 2025") reads as a window: ISO-8601 date-time with an offset, within years 1000 to 9998, e.g. 2026-10-02T12:00:00-05:00. Default: the server clock.'
            )
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
            .describe('Short human-readable justification. Why is this type being added?'),
          orderedBy: z
            .record(z.string(), z.enum(['asc', 'desc']))
            .optional()
            .describe(
              'What order do you usually read this in? { "<field>": "asc" | "desc" } over a ' +
                'date or number field, or createdAt / updatedAt. Omit for newest first.'
            ),
          indexes: z
            .array(z.record(z.string(), z.unknown()))
            .optional()
            .describe(
              'Indexes the reads will need: [{ "fields": ["brand"] }]. Never unique or named.'
            ),
          expectedSize: z
            .enum(['small', 'large'])
            .optional()
            .describe('"large" if the type will hold many rows, so indexes are advised sooner.')
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
      name: 'propose_index',
      config: {
        description:
          'Apply or dismiss an index recommendation (query `_system/IndexRecommendation`), ' +
          'or change indexes directly. `add` / `orderedBy` work on proposed types only ' +
          '(`index_on_code_defined_type` otherwise); `remove` drops an engine-owned, ' +
          'non-unique index the engine no longer wants, on any type (`not_engine_owned`, ' +
          '`unique_index`, `still_desired`, `unknown_index`). A referenced recommendation ' +
          'moves to accepted or dismissed; a closed one is refused (`recommendation_closed`), ' +
          'one whose evidence no longer holds is superseded (`recommendation_stale`). ' +
          'Requires the `substrate.index` capability in the target namespace.',
        inputSchema: {
          namespace: z.string().min(1).describe('Namespace of the type whose indexes change.'),
          type: z.string().min(1).describe('Type name, e.g. "Sneaker".'),
          action: z.enum(['add', 'remove', 'dismiss', 'orderedBy']),
          reason: z.string().min(1).describe('Short human-readable justification.'),
          recommendationId: z
            .string()
            .min(1)
            .optional()
            .describe('The IndexRecommendation row id; required for dismiss.'),
          declaration: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              'add: an index declaration, e.g. { "fields": ["brand", { "field": "size", "dir": "desc" }] }. ' +
                "Defaults to the recommendation's."
            ),
          orderedBy: z
            .record(z.string(), z.enum(['asc', 'desc']))
            .optional()
            .describe('orderedBy: the natural order, one key, e.g. { "releasedAt": "desc" }.'),
          indexName: z
            .string()
            .min(1)
            .optional()
            .describe("remove: the index to drop. Defaults to the recommendation's.")
        }
      },
      handler: createProposeIndexHandler(endpoint)
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
          'Who this session is authenticated as: { authEnabled, identity: { id, grants } | null }. Ask before concluding a credential works: reads can succeed anonymously. authEnabled false: the server verifies nothing. identity null with authEnabled true: your key never arrived (SUBSTRATE_AGENT_KEY_ID / SUBSTRATE_AGENT_KEY_PATH).',
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
          'Semantic search: top-k records by similarity to `query`; hits carry `id`, `shortId` + handle fields. As a query frame, recall/Hit takes the text in params.to.',
        inputSchema: {
          query: z.string().min(1).describe('Search text'),
          k: z.number().int().min(1).max(100).optional().describe('Default 10'),
          namespace: z.string().optional().describe('Required (no default)'),
          type: z.string().min(1).describe('e.g. "Note"'),
          threshold: z.number().optional().describe('Min similarity 0..1'),
          lexicalThreshold: z.number().optional().describe('Keyword-only hit floor'),
          // Loose on purpose: the server validates the shape and names the fault.
          where: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('field -> { eq } | { in: [...] }; null matches missing'),
          rowFields: z
            .union([z.record(z.string(), z.literal(true)), z.literal(true)])
            .optional()
            .describe('{ field: true } adds fields; true = whole row')
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
    if (!allowed.has(t.name)) continue;
    // biome-ignore lint/suspicious/noExplicitAny: config.inputSchema varies per tool
    server.registerTool(t.name, t.config as any, t.handler);
  }

  return server;
}

/** The tools a worker agent needs; the admin tools and `ask` are opt-in. */
export const CORE_TOOLS: readonly string[] = [
  'query',
  'mutate',
  'schema',
  'recall',
  'run',
  'whoami'
];

/**
 * Parse SUBSTRATE_MCP_TOOLS: tool names and the presets `core` and `all`
 * (`core` while unset or blank). An unknown name throws: a typo that silently registered nothing
 * would read as "this server has no such tool", which is a worse failure than
 * refusing to start.
 */
function resolveToolAllowlist(raw: string | undefined, known: string[]): Set<string> {
  if (raw === undefined || raw.trim() === '') return new Set(CORE_TOOLS);
  const names = new Set<string>();
  for (const n of raw.split(',').map((t) => t.trim())) {
    if (n === '') continue;
    if (n === 'core') for (const t of CORE_TOOLS) names.add(t);
    else if (n === 'all') for (const t of known) names.add(t);
    else if (known.includes(n)) names.add(n);
    else
      throw new Error(
        `SUBSTRATE_MCP_TOOLS: unknown tool '${n}'. Valid names: core, all, ${[...known].sort().join(', ')}`
      );
  }
  return names;
}

/** The overview for the session's instructions, or null when the server is slow or down. */
async function fetchOverview(endpoint: string): Promise<ReturnType<typeof schemaOverview> | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000).unref());
  const fetched = getSubstrate<Parameters<typeof schemaOverview>[0]>(
    endpoint,
    '/substrate/v1/federated-schema'
  ).then(schemaOverview, () => null);
  return Promise.race([fetched, timeout]);
}

/**
 * Boot the stdio MCP server. Resolves once the transport is connected; the
 * process keeps running until the host (Claude Code, etc.) closes stdio.
 */
export async function runMcp(): Promise<void> {
  const endpoint = process.env.SUBSTRATE_URL ?? 'http://localhost:3100';
  configureAgentAuth(process.env, endpoint);
  const server = createMcpServer(endpoint, {
    ...(process.env.SUBSTRATE_MCP_TOOLS === undefined
      ? {}
      : { tools: process.env.SUBSTRATE_MCP_TOOLS }),
    instructions: buildInstructions(await fetchOverview(endpoint))
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
