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
import { type Engine, effectiveFilterOperators } from '@mnmal-ai/substrate-core';
import {
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
        ...operatorContract(engine, defaultNamespace)
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

/** Projections available on the scoped type route. */
const TYPE_SHAPES = ['full', 'fields'] as const;

/**
 * GET /substrate/v1/schema/:namespace/:type — one type's write contract.
 *
 * Returns the type's field defs plus only the mutations that target it (the
 * `create<Type>` / `update<Type>` / … param + return shapes), so a caller
 * learns exactly what a write may carry in one cheap round-trip.
 *
 * `?shape=fields` drops the mutations, which for autoCRUD types restate the
 * field block five times over, and returns only their names. An unknown
 * `shape` is refused rather than ignored, so a wrong guess cannot look like
 * it worked.
 */
export function schemaForTypeRoute(engine: Engine): HttpHandler {
  return async (req) => {
    const ns = req.params.namespace;
    const type = req.params.type;
    if (ns === undefined || ns === '' || type === undefined || type === '') {
      return jsonResponse(400, { error: 'namespace and type path segments are required' });
    }
    const shape = req.query.shape ?? 'full';
    if (!(TYPE_SHAPES as readonly string[]).includes(shape)) {
      return jsonResponse(400, {
        error: `unknown shape '${shape}'`,
        detail:
          "The `shape` query parameter selects a projection of this type's contract. An unrecognised value is refused rather than ignored, so a wrong guess cannot look like it worked.",
        allowedShapes: [...TYPE_SHAPES],
        hint: `Use GET /substrate/v1/schema/${ns}/${type}?shape=fields for the field defs alone, or omit \`shape\` for the full write contract.`
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
    const base = {
      schemaVersion: schema.schemaVersion,
      namespace: ns,
      type,
      fields: typeSchema.fields,
      // Each field carries its `kind`; `operators` is keyed by kind. The join
      // is the caller's, which keeps the map one copy per response rather than
      // one per field.
      ...operatorContract(engine, ns)
    };
    // `mutationNames` rather than nothing: a caller that asked for fields still
    // has to know which mutations exist to write at all, and the names cost a
    // line where the inlined contracts cost five copies of the field block.
    return jsonResponse(
      200,
      shape === 'fields'
        ? { ...base, mutationNames: Object.keys(mutations).sort() }
        : { ...base, mutations }
    );
  };
}

/**
 * A mutation targets a type when its name is a lowercase verb followed by
 * exactly the type name (`createTodo`, `purgeTodo`), or when it returns the
 * type's row — a struct, or a list of structs, carrying exactly the type's
 * fields (`markAgentMessageRead`).
 */
function mutationTargetsType(
  name: string,
  def: MutationSchema,
  type: string,
  fields: Record<string, FieldDef>
): boolean {
  if (name.endsWith(type) && /^[a-z]+$/.test(name.slice(0, -type.length))) return true;
  const row = def.returns.kind === 'list' ? def.returns.of : def.returns;
  return row.kind === 'struct' && isDeepStrictEqual(row.fields, fields);
}
