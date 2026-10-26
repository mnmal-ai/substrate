/**
 * Wire format for proposable field definitions. Mirrors `FieldDef` from
 * `@mnmal-ai/substrate-types` one-for-one, but only covers the subset that
 * autoCRUD can serve. Anything outside this surface cannot be proposed
 * and must land through code.
 */

import { field } from '@mnmal-ai/substrate-sdk';
import type {
  FieldDef,
  FieldDefCrossRef,
  FieldDefList,
  FieldDefScalar,
  FieldDefStruct,
  OnDelete
} from '@mnmal-ai/substrate-types';
import { ProposalError } from './errors.js';

export type ScalarType = 'string' | 'number' | 'boolean' | 'date' | 'json';

export interface ScalarSpec {
  kind: 'scalar';
  type: ScalarType;
  indexed?: boolean;
  nullable?: boolean;
  readonly?: boolean;
  enum?: readonly string[];
  aliases?: Record<string, string>;
  strict?: boolean;
  implies?: Record<string, Record<string, unknown>>;
}

export interface CrossRefSpec {
  kind: 'crossRef';
  ns: string;
  type: string;
  onDelete?: OnDelete;
  indexed?: boolean;
  nullable?: boolean;
}

export interface StructSpec {
  kind: 'struct';
  fields: Record<string, FieldSpecJson>;
  nullable?: boolean;
}

export interface ListSpec {
  kind: 'list';
  of: FieldSpecJson;
  nullable?: boolean;
}

export type FieldSpecJson = ScalarSpec | CrossRefSpec | StructSpec | ListSpec;

/**
 * Type and field names a proposal may introduce. They become segments of
 * `<ns>/<Type>` frame keys and autoCRUD operation names, so a '/' or an
 * empty name would register something no caller can address.
 */
export const PROPOSABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** @throws ProposalError `invalid_params` when `value` is not a proposable name */
export function assertProposableName(param: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || !PROPOSABLE_NAME.test(value)) {
    throw new ProposalError(
      'invalid_params',
      `'${param}' must match ${PROPOSABLE_NAME.source}, got ${JSON.stringify(value)}`,
      { param }
    );
  }
}

/**
 * Refuse a crossRef, at any depth in `spec`, whose target `ownsType` rejects.
 *
 * @throws ProposalError `invalid_field_spec` naming the field and the target
 */
export function assertCrossRefsOwned(
  fieldName: string,
  spec: FieldSpecJson,
  ownsType: (ns: string, type: string) => boolean
): void {
  for (const ref of crossRefsIn(spec)) {
    if (!ownsType(ref.ns, ref.type)) {
      throw new ProposalError(
        'invalid_field_spec',
        `Field '${fieldName}' references '${ref.ns}/${ref.type}', which is not a type in a namespace this plugin owns`,
        { fieldName }
      );
    }
  }
}

function crossRefsIn(spec: FieldSpecJson): CrossRefSpec[] {
  switch (spec.kind) {
    case 'crossRef':
      return [spec];
    case 'list':
      return crossRefsIn(spec.of);
    case 'struct':
      return Object.values(spec.fields).flatMap(crossRefsIn);
    default:
      return [];
  }
}

const SCALAR_TYPES: ReadonlySet<ScalarType> = new Set([
  'string',
  'number',
  'boolean',
  'date',
  'json'
]);

export function parseFieldSpec(json: FieldSpecJson): FieldDef {
  switch (json.kind) {
    case 'scalar': {
      if (!SCALAR_TYPES.has(json.type)) {
        throw new Error(`unsupported scalar type: ${String(json.type)}`);
      }
      const def: FieldDefScalar = {
        kind: 'scalar',
        type: json.type,
        // Same default as the SDK's field builders: proposed types behave like code-defined ones.
        indexed: json.indexed ?? false
      };
      if (json.nullable !== undefined) def.nullable = json.nullable;
      if (json.readonly !== undefined) def.readonly = json.readonly;
      if (json.enum !== undefined) def.enum = json.enum;
      if (json.aliases !== undefined || json.strict !== undefined || json.implies !== undefined) {
        if (json.enum === undefined) {
          throw new Error('aliases, strict and implies need an enum to govern');
        }
        // field.vocab owns the vocabulary rules; reuse them rather than restate.
        const vocab = field.vocab(json.enum, {
          ...(json.aliases !== undefined ? { aliases: json.aliases } : {}),
          ...(json.strict !== undefined ? { strict: json.strict } : {}),
          ...(json.implies !== undefined ? { implies: json.implies } : {})
        });
        if (vocab.aliases !== undefined) def.aliases = vocab.aliases;
        if (vocab.strict !== undefined) def.strict = vocab.strict;
        if (vocab.implies !== undefined) def.implies = vocab.implies;
      }
      return def;
    }
    case 'crossRef': {
      if ('onMissing' in json && json.onMissing !== undefined) {
        throw new Error(
          'onMissing is not supported via propose_field; declare it in a hand-authored namespace instead'
        );
      }
      const def: FieldDefCrossRef = {
        kind: 'crossRef',
        ns: json.ns,
        type: json.type,
        onDelete: json.onDelete ?? 'set_null',
        indexed: json.indexed ?? true
      };
      if (json.nullable !== undefined) def.nullable = json.nullable;
      return def;
    }
    case 'struct': {
      const fields: Record<string, FieldDef> = {};
      for (const [name, spec] of Object.entries(json.fields)) {
        if (!PROPOSABLE_NAME.test(name)) throw new Error(`invalid struct field name '${name}'`);
        fields[name] = parseFieldSpec(spec);
      }
      const def: FieldDefStruct = { kind: 'struct', fields };
      if (json.nullable !== undefined) def.nullable = json.nullable;
      return def;
    }
    case 'list': {
      const def: FieldDefList = { kind: 'list', of: parseFieldSpec(json.of) };
      if (json.nullable !== undefined) def.nullable = json.nullable;
      return def;
    }
    default: {
      const exhaustive: never = json;
      throw new Error(`unknown field spec kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function stringifyFieldDef(def: FieldDef): FieldSpecJson {
  switch (def.kind) {
    case 'scalar': {
      const out: ScalarSpec = { kind: 'scalar', type: def.type };
      if (def.indexed !== undefined) out.indexed = def.indexed;
      if (def.nullable !== undefined) out.nullable = def.nullable;
      if (def.readonly !== undefined) out.readonly = def.readonly;
      if (def.enum !== undefined) out.enum = def.enum;
      if (def.aliases !== undefined) out.aliases = { ...def.aliases };
      if (def.strict !== undefined) out.strict = def.strict;
      if (def.implies !== undefined) out.implies = { ...def.implies };
      return out;
    }
    case 'crossRef': {
      const out: CrossRefSpec = { kind: 'crossRef', ns: def.ns, type: def.type };
      if (def.onDelete !== undefined) out.onDelete = def.onDelete;
      // indexed=true is the default for crossRef (applied by parseFieldSpec); omit it so
      // stringify(parse(json)) === json when the caller didn't set indexed explicitly.
      if (def.indexed === false) out.indexed = false;
      if (def.nullable !== undefined) out.nullable = def.nullable;
      return out;
    }
    case 'struct': {
      const fields: Record<string, FieldSpecJson> = {};
      for (const [name, inner] of Object.entries(def.fields)) {
        fields[name] = stringifyFieldDef(inner);
      }
      const out: StructSpec = { kind: 'struct', fields };
      if (def.nullable !== undefined) out.nullable = def.nullable;
      return out;
    }
    case 'list': {
      const out: ListSpec = { kind: 'list', of: stringifyFieldDef(def.of) };
      if (def.nullable !== undefined) out.nullable = def.nullable;
      return out;
    }
    default: {
      const exhaustive: never = def;
      throw new Error(`unknown FieldDef kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Check that `spec` parses, so a proposal can be refused before any row is
 * written for it.
 *
 * @throws ProposalError `invalid_field_spec` naming `fieldName` and the parse failure
 */
export function assertValidFieldSpec(fieldName: string, spec: FieldSpecJson): void {
  assertProposableName('fieldName', fieldName);
  if (typeof spec !== 'object' || spec === null) {
    throw new ProposalError(
      'invalid_field_spec',
      `Spec for field '${fieldName}' must be an object`,
      {
        fieldName
      }
    );
  }
  try {
    parseFieldSpec(spec);
  } catch (cause) {
    throw new ProposalError(
      'invalid_field_spec',
      `Invalid spec for field '${fieldName}': ${cause instanceof Error ? cause.message : String(cause)}`,
      { fieldName }
    );
  }
}
