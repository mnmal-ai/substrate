/**
 * A compact map of the federated schema for agents: every namespace's types,
 * each as one line of `field: type`, plus the mutations autoCRUD did not
 * generate. Enough to pick a type and write a query; a write contract is
 * still one scoped `schema { namespace, type }` away.
 */

interface FieldShape {
  kind?: string;
  type?: string;
  ns?: string;
  of?: FieldShape;
  fields?: Record<string, unknown>;
  enum?: unknown[];
  nullable?: boolean;
  indexed?: boolean;
  readonly?: boolean;
  serverSet?: unknown;
}

interface NamespaceSchema {
  types?: Record<string, { fields?: Record<string, FieldShape> }>;
  mutations?: Record<string, unknown>;
}

export interface NamespaceOverview {
  types: Record<string, string>;
  mutations?: string[];
}

function fieldType(f: FieldShape, ns: string): string {
  let t: string;
  if (f.kind === 'list' && f.of !== undefined) t = `${fieldType(f.of, ns)}[]`;
  else if (f.kind === 'crossRef')
    t = `→${f.ns === ns || f.ns === undefined ? '' : `${f.ns}/`}${f.type}`;
  else if (f.kind === 'struct') t = `{${Object.keys(f.fields ?? {}).join(', ')}}`;
  else if (Array.isArray(f.enum)) t = f.nullable ? `(${f.enum.join('|')})` : f.enum.join('|');
  else t = f.type ?? f.kind ?? 'unknown';
  const tags: string[] = [];
  if (f.indexed === false) tags.push('unindexed');
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
    for (const [name, def] of Object.entries(typeDefs)) {
      types[name] = Object.entries(def.fields ?? {})
        .map(([field, shape]) => `${field}: ${fieldType(shape, ns)}`)
        .join(', ');
    }
    const custom = Object.keys(schema.mutations ?? {}).filter((m) => {
      const crud = AUTO_CRUD.exec(m);
      return !(crud?.[2] !== undefined && crud[2] in typeDefs);
    });
    out[ns] = custom.length > 0 ? { types, mutations: custom } : { types };
  }
  return out;
}

/** How to read the overview; rides beside it in the tool result and the instructions. */
export const OVERVIEW_LEGEND =
  'Each type is `field: type` pairs. `a|b` is an enum, `?` nullable, `T[]` a list, `→Type` a reference ' +
  '(`→ns/Type` across namespaces). [unindexed] fields need `_allowTableScan` to filter on; [readonly] ' +
  'fields are server-set. Generated get/create/update/delete<Type> mutations are not listed; `mutations` ' +
  "holds the rest. For a type's exact write contract call `schema` with `namespace` and `type`.";

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
  '- With a shell, `substrate run <script.mts>` runs many reads and writes in one call and returns one small report (GET /substrate/v1/onboard, `instructions.codeMode`).'
].join('\n');

/** The MCP `instructions` text: the conventions, then this server's types as of session start. */
export function buildInstructions(overview: Record<string, NamespaceOverview> | null): string {
  if (overview === null) {
    return `${CONVENTIONS}\n\nThe type list was unavailable at session start; call \`schema\` with no arguments for it.`;
  }
  const full = JSON.stringify(overview);
  const body =
    full.length <= INSTRUCTIONS_OVERVIEW_MAX
      ? `${OVERVIEW_LEGEND}\n${full}`
      : `Type names only (the full overview is large; call \`schema\` with no arguments for fields):\n${JSON.stringify(
          Object.fromEntries(Object.entries(overview).map(([ns, o]) => [ns, Object.keys(o.types)]))
        )}`;
  return `${CONVENTIONS}\n\nTypes on this server at session start:\n${body}`;
}
