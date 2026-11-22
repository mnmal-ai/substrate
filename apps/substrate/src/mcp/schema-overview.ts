/**
 * A compact map of the federated schema for agents: every namespace's types,
 * each as one line of `field: type`, plus the mutations autoCRUD did not
 * generate. Enough to pick a type and write a query; a write contract is
 * still one scoped `schema { namespace, type }` away.
 */

import {
  DATE_UNITS,
  EXPR_AGGREGATES,
  EXPR_FUNCTIONS,
  EXPR_LIMITS
} from '@mnmal-ai/substrate-types';

interface FieldShape {
  kind?: string;
  type?: string;
  ns?: string;
  of?: FieldShape;
  fields?: Record<string, unknown>;
  enum?: unknown[];
  nullable?: boolean;
  readonly?: boolean;
  serverSet?: unknown;
}

interface NamespaceSchema {
  types?: Record<
    string,
    {
      fields?: Record<string, FieldShape>;
      inboundRefs?: Array<{ type: string; field: string }>;
      actions?: Record<
        string,
        {
          kind?: string;
          params?: Record<
            string,
            { type?: unknown; list?: string; optional?: boolean; default?: unknown }
          >;
        }
      >;
    }
  >;
  mutations?: Record<string, unknown>;
}

export interface NamespaceOverview {
  types: Record<string, string>;
  mutations?: string[];
  /** Type to its action index text, `close(resolution?), defer(revisitWhen)`; read by the lean instructions. */
  actions?: Record<string, string>;
}

// The overview rides in the session instructions, which an agent trusts. Proposals let any
// agent with mutate add enum values, so only identifier-shaped text is copied through.
const NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const ENUM_VALUE = /^[A-Za-z0-9_./-]{1,40}$/;
const MAX_ENUM_VALUES = 20;
const MAX_ENUM_TEXT = 200;

function safe(text: unknown, pattern: RegExp): string {
  return typeof text === 'string' && pattern.test(text) ? text : '<unsafe>';
}

function enumText(values: unknown[]): string {
  const shown: string[] = [];
  let length = 0;
  for (const v of values.slice(0, MAX_ENUM_VALUES)) {
    const text = safe(v, ENUM_VALUE);
    if (length + text.length > MAX_ENUM_TEXT) break;
    shown.push(text);
    length += text.length + 1;
  }
  return [...shown, ...(shown.length < values.length ? ['…'] : [])].join('|');
}

function fieldType(f: FieldShape, ns: string): string {
  let t: string;
  if (f.kind === 'list' && f.of !== undefined) t = `${fieldType(f.of, ns)}[]`;
  else if (f.kind === 'crossRef')
    t = `→${f.ns === ns || f.ns === undefined ? '' : `${safe(f.ns, NAME)}/`}${safe(f.type, NAME)}`;
  else if (f.kind === 'struct')
    t = `{${Object.keys(f.fields ?? {})
      .map((k) => safe(k, NAME))
      .join(', ')}}`;
  else if (Array.isArray(f.enum)) t = f.nullable ? `(${enumText(f.enum)})` : enumText(f.enum);
  else t = safe(f.type ?? f.kind, NAME);
  const tags: string[] = [];
  if (f.readonly === true || (f.serverSet !== undefined && f.serverSet !== false))
    tags.push('readonly');
  return `${t}${f.nullable ? '?' : ''}${tags.length > 0 ? ` [${tags.join(', ')}]` : ''}`;
}

const AUTO_CRUD = /^(get|create|update|delete)(.+)$/;

export function schemaOverview(
  federated: Record<string, NamespaceSchema>
): Record<string, NamespaceOverview> {
  const out: Record<string, NamespaceOverview> = {};
  for (const [ns, schema] of Object.entries(federated)) {
    const typeDefs = schema.types ?? {};
    const types: Record<string, string> = {};
    const actions: Record<string, string> = {};
    for (const [name, def] of Object.entries(typeDefs)) {
      // `←Type.field`: a same-namespace reference to this type, the start of an inbound walk.
      const line = [
        ...Object.entries(def.fields ?? {}).map(
          ([field, shape]) => `${safe(field, NAME)}: ${fieldType(shape, ns)}`
        ),
        ...(def.inboundRefs ?? []).map((r) => `←${safe(r.type, NAME)}.${safe(r.field, NAME)}`)
      ].join(', ');
      const declared = Object.entries(def.actions ?? {});
      types[safe(name, NAME)] =
        declared.length > 0
          ? `${line}; actions: ${declared.map(([a]) => safe(a, NAME)).join(', ')}`
          : line;
      if (declared.length > 0)
        actions[safe(name, NAME)] = declared
          .map(([a, decl]) => {
            const params = Object.entries(decl.params ?? {}).map(
              ([p, d]) => `${safe(p, NAME)}${d.optional === true || 'default' in d ? '?' : ''}`
            );
            return `${safe(a, NAME)}${params.length > 0 ? `(${params.join(', ')})` : ''}`;
          })
          .join(', ');
    }
    const custom = Object.keys(schema.mutations ?? {}).filter((m) => {
      const crud = AUTO_CRUD.exec(m);
      return !(crud?.[2] !== undefined && crud[2] in typeDefs);
    });
    const mutations = custom.map((m) => safe(m, NAME));
    out[safe(ns, NAME)] = {
      types,
      ...(mutations.length > 0 ? { mutations } : {}),
      ...(Object.keys(actions).length > 0 ? { actions } : {})
    };
  }
  return out;
}

/** How to read the overview; rides beside it in the tool result and the instructions. */
export const OVERVIEW_LEGEND =
  'Each type is `field: type` pairs. `a|b` is an enum, `?` nullable, `T[]` a list, `→Type` a reference ' +
  '(`→ns/Type` across namespaces). No field needs an index to filter; json filters by path only, and ' +
  'only non-json scalars sort. [readonly] ' +
  'fields are server-set. Generated get/create/update/delete<Type> mutations are not listed; `mutations` ' +
  "holds the rest. For a type's exact write contract call `schema` with `namespace` and `type`.";

/** Appended to the overview legend. */
const WALK_LEGEND =
  ' `←Type.field` is a reference TO this type; follow it backwards with `_walk: { in: "ns/Type.field" }` ' +
  'in `where`, as a nested `fields` entry, or in `_agg`.';

export const overviewLegend = OVERVIEW_LEGEND + WALK_LEGEND;

/** Past this, the instructions carry only type names; the full overview is one `schema` call away. */
const INSTRUCTIONS_OVERVIEW_MAX = 12_000;

const CONVENTIONS = [
  'Substrate holds typed records. Every query and mutate key is qualified: `<namespace>/<Type>` or `<namespace>/<mutation>`.',
  '- Filters go in `params.where`, never top-level params: `{ "ns/Type": { "params": { "where": { "status": { "eq": "open" } }, "limit": 20 }, "fields": { "id": true } } }`. A refused operator is named with the field and its kind; read it rather than guessing.',
  '- Read `errors` before `data`. A refused frame is ABSENT from `data`; a present empty list means nothing matched. A read with `_pagination.hasMore` is truncated: page with `nextCursor` (default page 100, max 1000).',
  '- Lists, counts and joins are exact `query` frames; `recall` (similarity search) needs `query`, `namespace` and `type`, and is for finding records by meaning.',
  '- In one `mutate` call the single-frame keys commit together or not at all, and an array under one key is one transaction. Send unrelated writes as separate calls.',
  '- `createdAt`, `updatedAt`, `createdBy` and `updatedBy` are server-set: never send them; read them through `_metadata`.',
  '- `whoami` says which identity this session reads and writes as.',
  '- If an admin tool (propose_type, propose_field, propose_index, drop_namespace, drop_type) or ask is missing from your tools, set SUBSTRATE_MCP_TOOLS=all (or core,<name>) in the MCP server env.',
  '- With a shell, `substrate run <script.mts>` runs many reads and writes in one call and returns one small report (GET /substrate/v1/onboard, `instructions.codeMode`).'
].join('\n');

/** The caller's pending (coined, unpromoted) action names, by namespace and type, without the `*`. */
export type PendingWords = Record<string, Record<string, string[]>>;

const PENDING_LEGEND = '* yours, pending';

/** The overview with each pending word appended to its type's action text as `name*`. */
function markPending(
  overview: Record<string, NamespaceOverview>,
  pending: PendingWords | null | undefined
): { overview: Record<string, NamespaceOverview>; any: boolean } {
  let any = false;
  const marked = Object.fromEntries(
    Object.entries(overview).map(([ns, o]) => {
      const types = { ...o.types };
      const actions = { ...o.actions };
      for (const [type, names] of Object.entries(pending?.[ns] ?? {})) {
        if (!(type in types) || names.length === 0) continue;
        any = true;
        const stars = names.map((n) => `${safe(n, NAME)}*`).join(', ');
        const declared = actions[type];
        actions[type] = declared === undefined ? stars : `${declared}, ${stars}`;
        types[type] = types[type]?.includes('; actions: ')
          ? `${types[type]}, ${stars}`
          : `${types[type]}; actions: ${stars}`;
      }
      return [
        ns,
        {
          ...o,
          types,
          ...(Object.keys(actions).length > 0 ? { actions } : {})
        }
      ];
    })
  );
  return { overview: marked, any };
}

/** The MCP `instructions` text: the conventions, then this server's types as of session start. */
export function buildInstructions(
  source: Record<string, NamespaceOverview> | null,
  pending?: PendingWords | null
): string {
  if (source === null) {
    return `${CONVENTIONS}\n\nThe type list was unavailable at session start; call \`schema\` with no arguments for it.`;
  }
  const { overview, any } = markPending(source, pending);
  // The action index is the lean instructions' text; here each type line already names its actions.
  const full = JSON.stringify(
    Object.fromEntries(
      Object.entries(overview).map(([ns, { actions: _actions, ...rest }]) => [ns, rest])
    )
  );
  const body =
    full.length <= INSTRUCTIONS_OVERVIEW_MAX
      ? `${overviewLegend}\n${full}`
      : `Type names only (the full overview is large; call \`schema\` with no arguments for fields):\n${JSON.stringify(
          Object.fromEntries(Object.entries(overview).map(([ns, o]) => [ns, Object.keys(o.types)]))
        )}`;
  return `${CONVENTIONS}\n\nTypes on this server at session start:\n${body}${any ? `\n${PENDING_LEGEND}` : ''}`;
}

/** An expression catalogue, as the server's unscoped `GET /substrate/v1/schema` publishes it. */
export interface ExpressionCatalogue {
  functions: readonly {
    name: string;
    args: readonly string[] | 'variadic';
    returns: string;
    description: string;
  }[];
  aggregates: readonly string[];
  limits: { maxDepth: number; maxNodesPerExpr: number; maxNodesPerFrame: number };
  dateUnits: readonly string[];
}

/** This binary's own catalogue: the fallback when the server publishes none. */
export const localExpressions: ExpressionCatalogue = {
  functions: EXPR_FUNCTIONS,
  aggregates: EXPR_AGGREGATES,
  limits: EXPR_LIMITS,
  dateUnits: DATE_UNITS
};

/** The `expressions` section of an unscoped schema reply, or undefined when it has none. */
export function serverExpressions(schema: unknown): ExpressionCatalogue | undefined {
  const e = (schema as { expressions?: Partial<ExpressionCatalogue> } | null)?.expressions;
  return Array.isArray(e?.functions) &&
    Array.isArray(e?.aggregates) &&
    Array.isArray(e?.dateUnits) &&
    e?.limits
    ? (e as ExpressionCatalogue)
    : undefined;
}

/** The expression catalogue as compact lines for the no-args overview: one per function, then aggregates, limits and date units. */
export function expressionLines(c: ExpressionCatalogue): string[] {
  return [
    ...c.functions.map((f) => {
      const args = f.args === 'variadic' ? '...' : f.args.join(', ');
      return `${f.name}(${args}) → ${f.returns}: ${f.description}`;
    }),
    `aggregates: ${c.aggregates.join(', ')}`,
    `limits: maxDepth ${c.limits.maxDepth}, maxNodesPerExpr ${c.limits.maxNodesPerExpr}, maxNodesPerFrame ${c.limits.maxNodesPerFrame}`,
    `dateUnits: ${c.dateUnits.join(', ')}`
  ];
}

/** Said beside a catalogue that is this binary's own, which may differ from what the server accepts. */
export const LOCAL_EXPRESSIONS_NOTE =
  "The server published no expression catalogue (GET /substrate/v1/schema), so this is the local binary's; the server may accept a different set.";

const LEAN_CONVENTIONS = [
  'Substrate holds typed records. Use `act` for every operation: send a sketch, get a one-line ack and a result id.',
  '- A step is `<action> <Type> [#shortId …] [field=value …] [as $name]`; split steps with `;` or newlines. Lists are `a,b` or `[a,b]`. Built-ins: create, update, find, count. `?` lists types and actions, `? Type` shows one.',
  "- `define Type.name field=value field=$ …` coins an update action for you; after 5 uses an hour apart it is everyone's.",
  '- `find` answers its rows in `found`: id, shortId and the fields named by `fields=a,b`. Everything in one sketch commits together or not at all; pass `result` to fetch the full outcome (short-lived).'
].join('\n');

/** The lean session's `instructions`: the conventions, then one index line per namespace; `_system*` namespaces are left out. */
export function buildLeanInstructions(
  source: Record<string, NamespaceOverview> | null,
  pending?: PendingWords | null
): string {
  if (source === null) {
    return `${LEAN_CONVENTIONS}\n\nThe type list was unavailable at session start; send \`?\` for it.`;
  }
  const visible = Object.fromEntries(
    Object.entries(source).filter(([ns]) => !ns.startsWith('_system'))
  );
  const { overview, any } = markPending(visible, pending);
  const line = (ns: string, o: NamespaceOverview, withActions: boolean) =>
    `${ns}: ${Object.keys(o.types)
      .map((t) => (withActions && o.actions?.[t] !== undefined ? `${t}{${o.actions[t]}}` : t))
      .join(', ')}`;
  const index = (withActions: boolean) =>
    Object.entries(overview)
      .map(([ns, o]) => line(ns, o, withActions))
      .join('\n');
  const full = index(true);
  return `${LEAN_CONVENTIONS}\n\nTypes and actions at session start:\n${
    full.length <= INSTRUCTIONS_OVERVIEW_MAX ? full : index(false)
  }${any ? `\n${PENDING_LEGEND}` : ''}`;
}
