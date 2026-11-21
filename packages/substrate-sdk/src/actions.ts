import {
  type ActionDecl,
  type ActionParamDecl,
  type ActionSetValue,
  type ActionThenDecl,
  BUILT_IN_ACTIONS,
  canonicalVocabValue,
  type FieldDef,
  isIsoTimestamp
} from '@mnmal-ai/substrate-types';
import { isNullableCrossRef } from './autocrud/internal.js';
import { RESERVED_AUTOCRUD_FIELDS } from './autocrud/reserved.js';
import type { TypeInput } from './namespace.js';

const FIELD_KINDS: readonly string[] = ['scalar', 'crossRef', 'struct', 'list'];

/** Throws unless every action declared on `typeName` is well-formed against its fields. */
export function assertTypeActions(typeName: string, input: TypeInput): void {
  const actions = input.actions;
  if (actions === undefined || Object.keys(actions).length === 0) return;
  if (input.autoCrud === false) throw new Error(`${typeName}: actions need autoCRUD`);
  const fields: Record<string, FieldDef> = { ...input.fields, ...RESERVED_AUTOCRUD_FIELDS };
  for (const [name, decl] of Object.entries(actions)) {
    assertAction(typeName, name, decl, fields);
  }
}

function assertAction(
  typeName: string,
  name: string,
  decl: ActionDecl,
  fields: Record<string, FieldDef>
): void {
  const fail: (msg: string) => never = (msg) => {
    throw new Error(`${typeName}.${name}: ${msg}`);
  };
  if ((BUILT_IN_ACTIONS as readonly string[]).includes(name)) {
    fail(`'${name}' is a built-in action`);
  }
  const params = decl.params ?? {};
  const set = decl.set ?? {};
  const then = decl.then ?? [];
  const used = new Set<string>();

  for (const [param, p] of Object.entries(params)) {
    if (!isParamDecl(p)) fail(`param '${param}' has no field type`);
  }

  for (const [field, value] of Object.entries(set)) {
    const def = fields[field];
    if (def === undefined) fail(`set field '${field}' is not a field of ${typeName}`);
    if (def.kind === 'scalar' && (def.readonly === true || def.serverSet !== undefined)) {
      fail(`${typeName}.${field} is server-set`);
    }
    if (isParamRef(value)) {
      if (params[value.param] === undefined) fail(`set uses undeclared param '${value.param}'`);
      used.add(value.param);
    } else if (isNow(value)) {
      if (def.kind !== 'scalar' || def.type !== 'date') fail('{ now: true } needs a date field');
    } else if (!literalFits(def, value)) {
      fail(`'${String(value)}' is not a value of ${typeName}.${field}`);
    }
  }

  for (const t of then) {
    const each = (t as Partial<ActionThenDecl>).each;
    if (each === undefined) fail('then entries need each');
    const param = params[each.param];
    if (param === undefined || !('list' in param)) fail('each needs a list param');
    used.add(each.param);
    const targetType = t.action.slice(0, t.action.lastIndexOf('.'));
    if (targetType !== param.list) {
      fail(`then target ${t.action} does not match list type ${param.list}`);
    }
  }

  for (const param of Object.keys(params)) {
    if (!used.has(param)) fail(`param '${param}' is never used`);
  }

  if ((decl.kind ?? 'update') === 'update') {
    if (Object.keys(set).length === 0 && then.length === 0) fail(`action '${name}' does nothing`);
    return;
  }

  // A create action must cover what autoCRUD create requires.
  for (const [field, def] of Object.entries(fields)) {
    if (field === 'id' || !isRequiredOnCreate(def)) continue;
    const value = set[field];
    const covered = value !== undefined && (!isParamRef(value) || isSupplied(params[value.param]));
    if (!covered) fail(`create action '${name}' leaves required field '${field}' unset`);
  }
}

function isParamDecl(p: ActionParamDecl): boolean {
  if ('list' in p) return typeof p.list === 'string';
  const type: unknown = p.type;
  return (
    typeof type === 'object' &&
    type !== null &&
    FIELD_KINDS.includes((type as { kind?: string }).kind ?? '')
  );
}

/** A param always has a value at run time: required, or defaulted. */
function isSupplied(p: ActionParamDecl | undefined): boolean {
  if (p === undefined) return false;
  return p.optional !== true || ('default' in p && p.default !== undefined);
}

function isParamRef(v: ActionSetValue): v is { param: string } {
  return typeof v === 'object' && v !== null && 'param' in v;
}

function isNow(v: ActionSetValue): v is { now: true } {
  return typeof v === 'object' && v !== null && 'now' in v;
}

/** The fields `assertRequiredFields` demands of an autoCRUD create. */
function isRequiredOnCreate(def: FieldDef): boolean {
  if (def.kind === 'crossRef') return !isNullableCrossRef(def);
  if (def.kind !== 'scalar') return false;
  if (def.nullable === true || def.default !== undefined || def.readonly === true) return false;
  return !(def.type === 'date' && (def.serverSet === 'create' || def.serverSet === 'both'));
}

function literalFits(def: FieldDef, v: string | number | boolean | null): boolean {
  if (v === null)
    return def.kind === 'crossRef'
      ? isNullableCrossRef(def)
      : def.kind === 'scalar' && (def.nullable === true || def.type === 'json');
  if (def.kind === 'crossRef') return typeof v === 'string';
  if (def.kind !== 'scalar') return false;
  switch (def.type) {
    case 'string': {
      if (typeof v !== 'string') return false;
      if (def.enum === undefined || def.strict === false) return true;
      return def.enum.includes(canonicalVocabValue(def, v) as string);
    }
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'int16':
    case 'int32':
    case 'int64':
      return typeof v === 'number' && Number.isSafeInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'date':
      return typeof v === 'string' && isIsoTimestamp(v);
    case 'json':
      return true;
  }
}
