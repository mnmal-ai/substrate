/** One handler per MCP tool: each a JSON-over-HTTP call to a `/substrate/v1/*` route. */

import {
  type ClientFromEnv,
  createClientFromEnv,
  DEFAULT_MAX_WRITES
} from '@mnmal-ai/substrate-client';
import type { ActMode, NlAskRequest } from '@mnmal-ai/substrate-types';
import { z } from 'zod';
import {
  errorResult,
  getSubstrate,
  okResult,
  postSubstrate,
  type ToolResult,
  toMessage
} from './http.js';
import { runSandboxed } from './run-sandbox.js';
import {
  expressionLines,
  LOCAL_EXPRESSIONS_NOTE,
  localExpressions,
  overviewLegend,
  schemaOverview,
  serverExpressions
} from './schema-overview.js';

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
export const frameInputSchema = (example: string) =>
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
  actions?: Record<string, unknown>;
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

/**
 * `act`: a sketch goes to `POST /substrate/v1/act`, a result id to its record. The default
 * namespace is read from the env on each call.
 */
export function createActHandler(endpoint: string, env: NodeJS.ProcessEnv = process.env) {
  return async (args: {
    sketch?: string;
    mode?: ActMode;
    result?: string;
  }): Promise<ToolResult> => {
    try {
      if (args.result !== undefined) {
        const path = `/substrate/v1/act/results/${encodeURIComponent(args.result)}`;
        return okResult(await getSubstrate(endpoint, path));
      }
      if (args.sketch === undefined) return errorResult('pass `sketch`, or `result` to fetch one');
      const namespace = env.SUBSTRATE_NAMESPACE;
      const reply = await postSubstrate<{ ok?: boolean }>(
        endpoint,
        '/substrate/v1/act',
        {
          sketch: args.sketch,
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
          ...(namespace !== undefined && namespace !== '' ? { namespace } : {})
        },
        'parsedError'
      );
      return { ...okResult(reply), isError: reply.ok === false };
    } catch (err) {
      return errorResult(toMessage(err));
    }
  };
}
