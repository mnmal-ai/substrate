/**
 * Schema discovery routes.
 *
 *   GET /substrate/v1/schema                  — the `default` namespace's published
 *                                        schema (back-compat convenience).
 *   GET /substrate/v1/schema/:namespace       — one namespace's published schema.
 *   GET /substrate/v1/schema/:namespace/:type — one type's write contract: its field
 *                                        defs plus the mutations that target it.
 *
 * The scoped forms exist so agents can mine the EXACT shape they need before a
 * create/update without pulling the whole federated schema (which is large
 * enough to blow an agent's context). The declared FieldDef map is the write
 * contract — autoCRUD rejects undeclared fields (see substrate-sdk
 * assertNoUnknownFields) — so reading `/:namespace/:type` is the cheap,
 * authoritative way to learn what a write may carry.
 *
 * Multi-namespace consumers that genuinely need everything still call
 * `/substrate/v1/federated-schema` (`Record<ns, Schema>`).
 *
 * Each namespace-scoped response also carries the operator contract —
 * `operators` keyed by field kind, plus `extensionOperators` — so a caller can
 * tell which predicates a field will accept.
 */

import { isDeepStrictEqual } from 'node:util';
import { type Engine, effectiveFilterOperators, nextKeys } from '@mnmal-ai/substrate-core';
import {
  DATE_UNITS,
  EXPR_AGGREGATES,
  EXPR_FUNCTIONS,
  EXPR_LIMITS,
  type FieldDef,
  type FieldKind,
  type HttpHandler,
  METADATA_AUTHOR_FIELDS,
  METADATA_FILTER_FIELDS,
  type MutationSchema
} from '@mnmal-ai/substrate-types';
import { jsonResponse } from './helpers.js';

/**
 * Returns one namespace's operator contract, joined in at route time.
 *
 * Not folded into the published schema: `schemaVersion` hashes
 * `{ types, mutations }`, so doing so would fire client drift detection, and
 * the answer depends on the substrate rather than the declaration.
 *
 * Returns undefined when the namespace has no host-registered dataset (bridge
 * and virtual namespaces), so the keys are absent rather than an empty map
 * that would read as "no operators work here".
 */
function operatorContract(
  engine: Engine,
  ns: string
):
  | {
      operators: Record<FieldKind, string[]>;
      extensionOperators: string[];
      metadataFields: Readonly<Record<string, FieldDef>>;
      metadataAuthorFields: typeof METADATA_AUTHOR_FIELDS;
    }
  | undefined {
  const dataset = engine.datasetFor(ns);
  if (dataset === undefined) return undefined;
  return {
    operators: effectiveFilterOperators(dataset.capabilities),
    // Valid on ANY field kind — they self-declare at registration and skip the
    // capability check — so they cannot be folded into the per-kind map above.
    // `GET /substrate/v1/onboard` publishes this same list as `filterOperators`.
    extensionOperators: [...engine.listFilterOperators()].sort(),
    // Filterable and orderable on every type without being declared on it.
    metadataFields: METADATA_FILTER_FIELDS,
    // `createdBy` / `updatedBy` as `_metadata` returns them: a plain operand
    // matches the id column, an object `{ kind, id }` matches both.
    metadataAuthorFields: METADATA_AUTHOR_FIELDS
  };
}

/** The expression catalogue: what `select`, `where.$expr`, `groupBy`, `having` and aggregates accept. */
const EXPRESSIONS = {
  functions: EXPR_FUNCTIONS,
  aggregates: EXPR_AGGREGATES,
  limits: EXPR_LIMITS,
  dateUnits: DATE_UNITS
};

/**
 * GET /substrate/v1/schema — the `defaultNamespace`'s schema, a pre-federation
 * compatibility surface.
 *
 * Answers 404 listing the available namespaces when the deployment does not
 * host that namespace (a configuration fact, not a server fault), and 400 when
 * the caller passes `namespace`/`type` as query parameters.
 */
export function schemaRoute(engine: Engine, defaultNamespace: string): HttpHandler {
  return async (req) => {
    // Refused before the lookup: ignoring the query string would answer about
    // `default`, a namespace the caller never named.
    const ns = req.query.namespace;
    const type = req.query.type;
    if ((ns !== undefined && ns !== '') || (type !== undefined && type !== '')) {
      const path =
        ns !== undefined && ns !== '' && type !== undefined && type !== ''
          ? `/substrate/v1/schema/${ns}/${type}`
          : ns !== undefined && ns !== ''
            ? `/substrate/v1/schema/${ns}`
            : '/substrate/v1/schema/<namespace>/<Type>';
      return jsonResponse(400, {
        error: 'namespace and type are PATH segments on this route, not query parameters',
        detail:
          'GET /substrate/v1/schema takes no query parameters — it serves the default namespace only. The query string was not applied.',
        hint: `Use GET ${path}`
      });
    }
    try {
      return jsonResponse(200, {
        ...engine.schemaFor(defaultNamespace),
        ...operatorContract(engine, defaultNamespace),
        // Unscoped only: the scoped routes stay cheap.
        expressions: EXPRESSIONS
      });
    } catch {
      return jsonResponse(404, {
        error: `unknown namespace '${defaultNamespace}'`,
        detail:
          'GET /substrate/v1/schema serves the default namespace only, a pre-federation compatibility surface. This deployment does not host it.',
        availableNamespaces: Object.keys(engine.federatedSchema()).sort(),
        hint: 'Use GET /substrate/v1/schema/<namespace>, GET /substrate/v1/schema/<namespace>/<Type>, or GET /substrate/v1/federated-schema.'
      });
    }
  };
}

/** GET /substrate/v1/schema/:namespace — one namespace's full published schema. */
export function schemaForNamespaceRoute(engine: Engine): HttpHandler {
  return async (req) => {
    const ns = req.params.namespace;
    if (ns === undefined || ns === '') {
      return jsonResponse(400, { error: 'namespace path segment is required' });
    }
    try {
      return jsonResponse(200, { ...engine.schemaFor(ns), ...operatorContract(engine, ns) });
    } catch {
      // schemaFor throws on unknown / tombstoned namespace.
      return jsonResponse(404, { error: `unknown namespace '${ns}'` });
    }
  };
}

/** Projections available on the scoped type route; the first is the default. */
const TYPE_SHAPES = ['compact', 'full', 'fields'] as const;

/**
 * GET /substrate/v1/schema/:namespace/:type — one type's write contract.
 *
 * Returns the type's field defs plus only the mutations that target it (the
 * `create<Type>` / `update<Type>` / … param + return shapes), so a caller
 * learns exactly what a write may carry in one cheap round-trip.
 *
 * By default (`compact`) the generated autoCRUD mutations name the type
 * instead of restating its field block (`createTodo: { params: 'Todo fields',
 * returns: 'Todo' }`), and `mutationRefs` says how to read those names. Custom
 * mutations keep their full signatures. `?shape=full` inlines every field
 * block, as the namespace's published schema does. `?shape=fields` drops the
 * mutations and returns only their names. An unknown `shape` is refused
 * rather than ignored, so a wrong guess cannot look like it worked.
 */
export function schemaForTypeRoute(engine: Engine): HttpHandler {
  return async (req) => {
    const ns = req.params.namespace;
    const type = req.params.type;
    if (ns === undefined || ns === '' || type === undefined || type === '') {
      return jsonResponse(400, { error: 'namespace and type path segments are required' });
    }
    const shape = req.query.shape ?? 'compact';
    if (!(TYPE_SHAPES as readonly string[]).includes(shape)) {
      return jsonResponse(400, {
        error: `unknown shape '${shape}'`,
        detail:
          "The `shape` query parameter selects a projection of this type's contract. An unrecognised value is refused rather than ignored, so a wrong guess cannot look like it worked.",
        allowedShapes: [...TYPE_SHAPES],
        hint: `Use GET /substrate/v1/schema/${ns}/${type}?shape=fields for the field defs alone, ?shape=full for every mutation with its field block inlined, or omit \`shape\` for the compact write contract.`
      });
    }
    let schema: ReturnType<Engine['schemaFor']>;
    try {
      schema = engine.schemaFor(ns);
    } catch {
      return jsonResponse(404, { error: `unknown namespace '${ns}'` });
    }
    const typeSchema = schema.types[type];
    if (typeSchema === undefined) {
      return jsonResponse(404, {
        error: `unknown type '${type}' in namespace '${ns}'`,
        availableTypes: Object.keys(schema.types).sort()
      });
    }
    // Surface the mutations that target this type so the caller sees the exact
    // create/update param bag alongside the field defs.
    const mutations: Record<string, MutationSchema> = {};
    for (const [name, def] of Object.entries(schema.mutations)) {
      if (mutationTargetsType(name, def, type, typeSchema.fields)) mutations[name] = def;
    }
    // Absent when the dataset keeps no per-type storage. Not part of
    // `schemaVersion`: it changes as indexes build, with no schema change.
    // Introspection never fails the schema route: a catalog error omits it.
    const storage = await engine
      .datasetFor(ns)
      ?.describeStorage?.(type)
      .catch(() => undefined);
    // A field held in jsonb until the sweep gives it a column says so on its def.
    const pending = new Set(storage?.pending ?? []);
    const base = {
      schemaVersion: schema.schemaVersion,
      namespace: ns,
      type,
      fields:
        pending.size === 0
          ? typeSchema.fields
          : Object.fromEntries(
              Object.entries(typeSchema.fields).map(([f, def]) => [
                f,
                pending.has(f) ? { ...def, storage: 'pending' as const } : def
              ])
            ),
      // Each field carries its `kind`; `operators` is keyed by kind. The join
      // is the caller's, which keeps the map one copy per response rather than
      // one per field.
      ...operatorContract(engine, ns)
    };
    const withStorage = storage === undefined ? base : { ...base, storage };
    // Annotation only: for each crossRef of this type, the fields an index
    // serves once a walk has hopped through it. Omitted where no plan exists.
    const dataset = engine.datasetFor(ns);
    const plan = await dataset?.indexPlan?.(type, ns).catch(() => undefined);
    const crossRefs = Object.entries(typeSchema.fields).filter(([, d]) => d.kind === 'crossRef');
    const withHops =
      plan === undefined || crossRefs.length === 0
        ? withStorage
        : {
            ...withStorage,
            servedAfterHop: Object.fromEntries(
              crossRefs.map(([f]) => [f, nextKeys(plan.indexes, f)])
            )
          };
    // `mutationNames` rather than nothing: a caller that asked for fields still
    // has to know which mutations exist to write at all, and the names cost a
    // line where the inlined contracts cost five copies of the field block.
    if (shape === 'fields') {
      return jsonResponse(200, { ...withHops, mutationNames: Object.keys(mutations).sort() });
    }
    if (shape === 'full') return jsonResponse(200, { ...withHops, mutations });
    const compact = Object.fromEntries(
      Object.entries(mutations).map(([name, def]) => [
        name,
        GENERATED_VERBS.test(name.slice(0, -type.length)) && name.endsWith(type)
          ? compactMutation(def, type, typeSchema.fields)
          : def
      ])
    );
    return jsonResponse(200, {
      ...withHops,
      mutations: compact,
      mutationRefs: mutationRefsLegend(type)
    });
  };
}

/** The verbs autoCRUD generates mutations under: `<verb><Type>`. */
const GENERATED_VERBS = /^(get|create|update|delete|updateMany|deleteMany|purge)$/;

/** How to read the type names a compact mutation carries in place of a field block. */
function mutationRefsLegend(type: string): string {
  return (
    `A string in place of a signature stands for ${type}'s \`fields\` block: '${type}' is one row ` +
    `as \`fields\` declares it ('${type} | null' when no row has the id); '${type} fields' is ` +
    `\`fields\` itself, each field as declared; 'id, plus any subset of ${type} fields' and ` +
    `'any subset of ${type} fields' are patches. ?shape=full inlines every block.`
  );
}

/** A compact mutation: a piece of its signature, or the type reference that replaced it. */
type CompactPiece = FieldDef | string;

/**
 * Replaces each place a generated mutation restates the type's field block
 * with the type's name. Structural, not name-based: a piece that differs from
 * the field block (a plugin's replacement `createTodo`) is kept as declared.
 */
function compactMutation(
  def: MutationSchema,
  type: string,
  fields: Record<string, FieldDef>
): { params: Record<string, CompactPiece> | string; returns: CompactPiece } & Omit<
  MutationSchema,
  'params' | 'returns'
> {
  const isRow = (f: FieldDef): boolean =>
    f.kind === 'struct' && isDeepStrictEqual(f.fields, fields);
  const { id, ...rest } = def.params;
  const params: Record<string, CompactPiece> | string = isDeepStrictEqual(def.params, fields)
    ? `${type} fields`
    : id !== undefined && isDeepStrictEqual(rest, fields)
      ? `id, plus any subset of ${type} fields`
      : Object.fromEntries(
          Object.entries(def.params).map(([k, f]) => [
            k,
            isRow(f) ? `any subset of ${type} fields` : f
          ])
        );
  const returns = isRow(def.returns)
    ? def.returns.nullable === true
      ? `${type} | null`
      : type
    : def.returns;
  return { ...def, params, returns };
}

/**
 * A mutation targets a type when its name is a lowercase verb, optionally
 * followed by `Many`, then exactly the type name (`createTodo`, `purgeTodo`,
 * `updateManyTodo`), or when it returns the
 * type's row — a struct, or a list of structs, carrying exactly the type's
 * fields (`markAgentMessageRead`).
 */
function mutationTargetsType(
  name: string,
  def: MutationSchema,
  type: string,
  fields: Record<string, FieldDef>
): boolean {
  if (name.endsWith(type) && /^[a-z]+(Many)?$/.test(name.slice(0, -type.length))) return true;
  const row = def.returns.kind === 'list' ? def.returns.of : def.returns;
  return row.kind === 'struct' && isDeepStrictEqual(row.fields, fields);
}
