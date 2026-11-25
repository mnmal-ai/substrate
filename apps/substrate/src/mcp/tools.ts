/** The MCP tool table (names, descriptions, input schemas) and the presets that select from it. */

import { z } from 'zod';
import { resolveAgentCapabilities } from './agent-jwt.js';
import {
  createActHandler,
  createDropNamespaceHandler,
  createDropTypeHandler,
  createMutateHandler,
  createNlHandler,
  createProposeFieldHandler,
  createProposeIndexHandler,
  createProposeTypeHandler,
  createQueryHandler,
  createRunHandler,
  createSchemaHandler,
  frameInputSchema,
  type RecallInput,
  recall
} from './handlers.js';
import { errorResult, getSubstrate, okResult, type ToolResult, toMessage } from './http.js';

const WALK_DESCRIPTION =
  ' Walks: `_walk: { in: "ns/Type.field" }` follows a reference backwards (overview: `←Type.field`), `out: "field"` forwards (may cross into a namespace you can read; `in` names it); it filters in `where`, nests rows in `fields`, aggregates in `fields._agg`. E.g. orders with an item over 50, with item count: { "shop/Order": { "params": { "where": { "_walk": { "in": "shop/Item.order", "where": { "price": { "gt": 50 } } } } }, "fields": { "_agg": { "items": { "in": "shop/Item.order", "count": true } } } } }. `quantifier`: "any" (default), "none", "all"; `pick`: { latest | max | min: field }. An "any" walk binds `as: "L"`, read later as { "$ref": "L.price", "times": 1.25 } (`$.f` seed row, `_agg.<n>` aggregate; `times`/`plus` scale, `plus` on a date shifts ms). `_agg`: count, avg/sum/min/max: field, latest: { by, value }; in `where` it compares: { "_agg": {...}, "gte": 3 }. Params: `count: true`; `aggregate: { n: { sum: "price" } }`, per group with `groupBy: { day: { dateTrunc: [{ "lit": "day" }, "seenAt"] } }` or "customer.region" (out hop), `having`, `offset`; `select: { m: { sub: ["_agg.x", "price"] } }` adds a value, sortable in `orderBy`. An expression is a field name, a literal, { "lit": "text" } or { "fn": [args] }. Walks are query-only.';

/** One tool: its name, what the client is told of it, and its handler. */
export interface ToolEntry {
  name: string;
  config: { description?: string; inputSchema?: Record<string, unknown> | z.ZodType };
  // biome-ignore lint/suspicious/noExplicitAny: handler signatures vary per tool
  handler: (...args: any[]) => Promise<ToolResult>;
}

/**
 * Every tool the server can register. Each handler is a thin JSON-over-HTTP
 * closure over `endpoint` (no client package): the MCP bridge only does
 * request/response (schema/query/mutate), never the subscribe/stream path, so
 * it speaks `/substrate/v1/*` JSON directly.
 */
export function toolTable(endpoint: string): ToolEntry[] {
  return [
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
      name: 'act',
      config: {
        description:
          'Run operations as one transaction. Steps split by `;`: `<action> <Type> [#id …] [field=value …] [as $t]`. Built-ins: create, update, find, count. `?` or `? Type` for help. `define Type.name …` proposes a new action. Reply { ok, ack, result, found? }: `found` holds find rows (up to 100); pass `result` to fetch the full record. A refusal names the problem, the choices and the nearest valid sketch; nothing ran.',
        inputSchema: {
          sketch: z.string().min(1).optional().describe('e.g. close Todo #12'),
          mode: z.enum(['write', 'dry-run']).optional(),
          result: z.string().min(1).optional().describe('Result id to fetch')
        }
      },
      handler: createActHandler(endpoint)
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
            .describe('"large" if the type will hold many rows, so indexes are advised sooner.'),
          actions: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
              'act words live with the type, declared as code declares them: ' +
                '{ "archive": { "past": "archived", "set": { "status": "archived" } } }.'
            )
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
            .describe(
              'Must equal `namespace` exactly. It guards against a mistyped name; it is not a confirmation by a person.'
            ),
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
            .describe(
              'Must equal "<namespace>/<type>" exactly. It guards against a mistyped name; it is not a confirmation by a person.'
            ),
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
}

/** Tools that change nothing, for a host that asks before a write. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'schema',
  'query',
  'ask',
  'whoami',
  'recall'
]);
/** The tools a worker agent needs; the admin tools and `ask` are opt-in. */
export const CORE_TOOLS: readonly string[] = [
  'query',
  'mutate',
  'schema',
  'recall',
  'run',
  'whoami'
];

/** The `lean` preset: the agent's whole fixed cost is `act` and `whoami`, plus `ask` where nl runs. */
export const LEAN_TOOLS: readonly string[] = ['act', 'whoami'];

/**
 * Parse SUBSTRATE_MCP_TOOLS: tool names and the presets `core`, `lean` and `all`
 * (`core` while unset or blank). An unknown name throws: a typo that silently registered nothing
 * would read as "this server has no such tool", which is a worse failure than
 * refusing to start.
 */
export function resolveToolAllowlist(
  raw: string | undefined,
  known: string[],
  nlAvailable = false
): Set<string> {
  if (raw === undefined || raw.trim() === '') return new Set(CORE_TOOLS);
  const names = new Set<string>();
  for (const n of raw.split(',').map((t) => t.trim())) {
    if (n === '') continue;
    if (n === 'core') for (const t of CORE_TOOLS) names.add(t);
    else if (n === 'lean') {
      for (const t of LEAN_TOOLS) names.add(t);
      if (nlAvailable) names.add('ask');
    } else if (n === 'all') for (const t of known) names.add(t);
    else if (known.includes(n)) names.add(n);
    else
      throw new Error(
        `SUBSTRATE_MCP_TOOLS: unknown tool '${n}'. Valid names: core, lean, all, ${[...known].sort().join(', ')}`
      );
  }
  return names;
}
