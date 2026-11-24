/**
 * Help for `?` and `? Type`, read from the published schema. Field types use
 * the schema overview's spelling, with references always qualified.
 */

import type {
  ActHelp,
  ActionParamDecl,
  FieldDef,
  MutationSchema,
  Schema,
  TypeSchema
} from '@mnmal-ai/substrate-types';

function fieldType(def: FieldDef): string {
  let t: string;
  if (def.kind === 'list') t = `${fieldType(def.of)}[]`;
  else if (def.kind === 'crossRef') t = `→${def.ns}/${def.type}`;
  else if (def.kind === 'struct') t = `{${Object.keys(def.fields).join(', ')}}`;
  else if (def.enum !== undefined)
    t = def.nullable ? `(${def.enum.join('|')})` : def.enum.join('|');
  else t = def.type;
  const readonly = def.kind === 'scalar' && (def.readonly === true || def.serverSet !== undefined);
  return `${t}${def.nullable ? '?' : ''}${readonly ? ' [readonly]' : ''}`;
}

/** Whether autoCRUD create demands the field, as `assertRequiredFields` decides. */
function isRequired(name: string, def: FieldDef): boolean {
  if (name === 'id') return false;
  if (def.kind === 'crossRef') return !(def.nullable ?? def.onDelete === 'set_null');
  if (def.kind !== 'scalar') return false;
  if (def.nullable === true || def.default !== undefined || def.readonly === true) return false;
  return !(def.type === 'date' && (def.serverSet === 'create' || def.serverSet === 'both'));
}

function paramHelp(p: ActionParamDecl): { type: string; required: boolean } {
  if ('list' in p) return { type: `→${p.list}[]`, required: p.optional !== true };
  return { type: fieldType(p.type), required: p.optional !== true && p.default === undefined };
}

const mapValues = <T, U>(o: Record<string, T>, f: (v: T, k: string) => U): Record<string, U> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v, k)]));

/** `?`: every type by namespace, each with its declared action names. */
export function typesHelp(schema: Readonly<Record<string, Schema>>): ActHelp {
  const types: Record<string, Record<string, string[]>> = {};
  for (const ns of Object.keys(schema).sort()) {
    if (ns.startsWith('_system')) continue;
    const nsTypes = (schema[ns] as Schema).types;
    types[ns] = Object.fromEntries(
      Object.keys(nsTypes)
        .sort()
        .map((name) => [
          name,
          Object.entries(nsTypes[name]?.actions ?? {})
            .map(([a, def]) => (def.pending !== undefined ? `${a}*` : a))
            .sort()
        ])
    );
  }
  return { types };
}

/** `? Type`: its declared actions with their params, and its fields. */
export function typeHelp(
  qualified: string,
  type: TypeSchema,
  mutations: Record<string, MutationSchema> = {}
): ActHelp {
  return {
    type: qualified,
    actions: mapValues(type.actions ?? {}, (a) => ({
      kind: a.kind,
      ...(a.mutation !== undefined ? { mutation: a.mutation } : {}),
      // A mutation action also takes that mutation's own params, bar the `id` a reference fills.
      params: {
        ...(a.mutation === undefined
          ? {}
          : mapValues(
              Object.fromEntries(
                Object.entries(mutations[a.mutation]?.params ?? {}).filter(([p]) => p !== 'id')
              ),
              (def, p) => ({ type: fieldType(def), required: isRequired(p, def) })
            )),
        ...mapValues(a.params, paramHelp)
      },
      ...(a.pending !== undefined ? { pending: a.pending } : {})
    })),
    fields: mapValues(type.fields, (def, name) => ({
      type: fieldType(def),
      required: isRequired(name, def)
    }))
  };
}
