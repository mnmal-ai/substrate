import type { FieldDef, Schema } from '@mnmal-ai/substrate/sdk';
import type {
  NamespacePack,
  NamespaceProfile,
  PackField,
  PackType,
  PackValueRef
} from './types.js';
import { pluralize, splitWords, uniqueSorted } from './words.js';

export interface BuildPackInput {
  namespace: string;
  schema: Schema;
  /** The schema's operator table, keyed `scalar.<type>`, `crossRef`, `list`. */
  operators: Record<string, readonly string[]>;
  profile?: NamespaceProfile;
  /** Safety cap: a profiled field with more distinct values is not used. Default 1000. */
  maxDistinct?: number;
}

/** Longest value worth matching as a whole phrase. */
const MAX_VALUE_LENGTH = 64;

/**
 * A field is vocabulary when its values are labels rather than prose. The
 * test is length, not distinct count: an `area` with hundreds of one-word
 * values is vocabulary, a `title` with a dozen sentences is not.
 */
const MAX_MEAN_WORDS = 3;

/** Server-managed fields every type can filter on, with their value type. */
const METADATA_FIELDS: Record<string, { valueType: string; phrases: string[] }> = {
  createdAt: { valueType: 'date', phrases: ['created', 'created at'] },
  updatedAt: { valueType: 'date', phrases: ['updated', 'updated at'] },
  createdById: { valueType: 'string', phrases: ['created by', 'author'] },
  createdByKind: { valueType: 'string', phrases: ['created by kind'] },
  updatedById: { valueType: 'string', phrases: ['updated by'] },
  updatedByKind: { valueType: 'string', phrases: ['updated by kind'] }
};

/**
 * Builds the NL vocabulary for one namespace. Pure: the same schema, operator
 * table and profile always give byte-identical output, with sorted keys.
 */
export function buildNamespacePack(input: BuildPackInput): NamespacePack {
  const { namespace, schema, operators, profile } = input;
  const maxDistinct = input.maxDistinct ?? 1000;
  const types: Record<string, PackType> = {};
  const refs: PackValueRef[] = [];

  for (const typeName of Object.keys(schema.types).sort()) {
    const declared = schema.types[typeName]?.fields ?? {};
    const fields: Record<string, PackField> = {};
    for (const name of Object.keys(declared).sort()) {
      const def = declared[name] as FieldDef;
      const field = packField(name, def, operators);
      fields[name] = field;
      for (const value of field.enum ?? []) refs.push({ type: typeName, field: name, value });
      // Aliases are indexed verbatim: the parser emits them as written and the
      // server canonicalises them, and expands any implications.
      for (const alias of Object.keys(field.aliases ?? {}))
        refs.push({ type: typeName, field: name, value: alias });
      const observed = profile?.types[typeName]?.[name];
      if (
        observed !== undefined &&
        field.indexed &&
        isStringy(def) &&
        !observed.truncated &&
        observed.values.length <= maxDistinct &&
        areLabels(observed.values)
      ) {
        for (const value of observed.values) refs.push({ type: typeName, field: name, value });
        field.distinct = observed.values.length;
      }
    }
    for (const [name, meta] of Object.entries(METADATA_FIELDS)) {
      if (name in fields) continue;
      fields[name] = {
        name,
        kind: 'metadata',
        valueType: meta.valueType,
        indexed: true,
        operators: [...(operators[`scalar.${meta.valueType}`] ?? [])],
        phrases: meta.phrases
      };
    }
    types[typeName] = { name: typeName, phrases: typePhrases(typeName), fields: sortKeys(fields) };
  }

  return { namespace, schemaVersion: schema.schemaVersion, types, values: indexValues(refs) };
}

function packField(name: string, def: FieldDef, operators: BuildPackInput['operators']): PackField {
  const phrases = uniqueSorted([splitWords(name).join(' '), name.toLowerCase()]);
  switch (def.kind) {
    case 'scalar':
      return {
        name,
        kind: 'scalar',
        valueType: def.type,
        // A handle unless explicitly opted out; unset `indexed` only means no btree.
        indexed: def.indexed !== false,
        operators: [...(operators[`scalar.${def.type}`] ?? [])],
        phrases,
        ...(def.enum !== undefined ? { enum: [...def.enum] } : {}),
        ...(def.aliases !== undefined ? { aliases: { ...def.aliases } } : {})
      };
    case 'crossRef':
      return {
        name,
        kind: 'crossRef',
        target: { namespace: def.ns, type: def.type },
        // Mirrors the reconciler: a crossRef is indexed unless it opts out.
        indexed: def.indexed !== false,
        operators: [...(operators.crossRef ?? [])],
        phrases
      };
    case 'list':
      return {
        name,
        kind: 'list',
        indexed: def.indexed === true,
        operators: [...(operators.list ?? [])],
        phrases
      };
    default:
      return { name, kind: 'struct', indexed: false, operators: [], phrases };
  }
}

function areLabels(values: string[]): boolean {
  if (values.length === 0) return false;
  const words = values.reduce((n, v) => n + v.trim().split(/\s+/).length, 0);
  return words / values.length <= MAX_MEAN_WORDS;
}

/** A string scalar, or a list of string scalars: the fields whose values read as words. */
function isStringy(def: FieldDef): boolean {
  if (def.kind === 'scalar') return def.type === 'string';
  return def.kind === 'list' && def.of.kind === 'scalar' && def.of.type === 'string';
}

function typePhrases(typeName: string): string[] {
  const words = splitWords(typeName);
  const last = words[words.length - 1] ?? typeName.toLowerCase();
  const head = words.slice(0, -1);
  const out = [[...head, last].join(' '), [...head, pluralize(last)].join(' ')];
  if (head.length > 0) out.push(last, pluralize(last));
  return uniqueSorted(out);
}

function indexValues(refs: PackValueRef[]): Record<string, PackValueRef[]> {
  const byKey = new Map<string, Map<string, PackValueRef>>();
  for (const ref of refs) {
    const key = ref.value.trim().toLowerCase();
    if (key.length === 0 || key.length > MAX_VALUE_LENGTH) continue;
    const bucket = byKey.get(key) ?? new Map<string, PackValueRef>();
    bucket.set(`${ref.type}\u0000${ref.field}`, ref);
    byKey.set(key, bucket);
  }
  const out: Record<string, PackValueRef[]> = {};
  for (const key of [...byKey.keys()].sort()) {
    const bucket = byKey.get(key) as Map<string, PackValueRef>;
    out[key] = [...bucket.keys()].sort().map((k) => bucket.get(k) as PackValueRef);
  }
  return out;
}

function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.keys(obj)
      .sort()
      .map((k) => [k, obj[k] as T])
  );
}
