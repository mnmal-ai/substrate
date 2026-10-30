/**
 * Positional decoder. Spec: §7.0, §7.2.
 *
 * Mirror of `encoder.ts`. Rebuilds named objects from positional tuples using
 * the same `FieldInput` the client originally sent plus the schema cached at
 * init. Single-vs-list dispatch is driven by `PackEnvelope.shapes[key]`
 * (§7.2) — no inference from the tuple shape.
 *
 * Schema drift (§7.1) is detected here when the caller passes
 * `expectedSchemaVersion`: the decoder throws `SchemaDriftError` before
 * decoding any data value, so drift fails loudly instead of corrupting row
 * shapes. Refetch-and-retry is the caller's job. Without
 * `expectedSchemaVersion` no check is made.
 */

import {
  assertNever,
  type EnvelopeShape,
  type FieldDef,
  type FieldDefCrossRef,
  type FieldDefList,
  type FieldDefStruct,
  type FieldInput,
  type PackEnvelope,
  type Schema
} from '@mnmal-ai/substrate-types';
import { unpack } from 'msgpackr';
import {
  type FieldDefPlan,
  type FieldDefPlanCache,
  type RowPlan,
  type RowPlanCache,
  getFieldDefPlan as sharedGetFieldDefPlan,
  getRowPlan as sharedGetRowPlan,
  resolveFieldMap as sharedResolveFieldMap,
  type WalkSlot
} from './_plan-cache.js';
import { isAggShape } from './encoder.js';

export interface DecodeContext {
  schemas?: Record<string, Schema>;
  currentNs: string;
}

export interface DecodeEnvelopeCtx {
  fieldsByKey: Record<string, FieldInput>;
  /**
   * Mutation-path return-shape map — symmetric to `EncodeEnvelopeCtx.returnsByKey`.
   * A key listed here is decoded using `decodePositionalFromFieldDef` instead
   * of the client-sent FieldInput.
   */
  returnsByKey?: Record<string, FieldDef>;
  typeByKey: Record<string, string>;
  schemas: Record<string, Schema>;
  currentNsByKey: Record<string, string>;
  /**
   * Expected schema version — §7.1 drift check. When set, the decoder
   * compares `envelope.schemaVersion` before decoding any data value; a
   * mismatch throws `SchemaDriftError`. When undefined the drift check is
   * skipped (callers without a cached version, e.g. server self-roundtrip,
   * shouldn't fail on their own envelopes).
   */
  expectedSchemaVersion?: string;
}

/**
 * @internal — error thrown by the positional decoder on malformed input.
 * Exported, but treat as package-private; signature may change without a
 * major bump.
 */
export class PackDecodeError extends Error {
  override readonly name = 'PackDecodeError';
  readonly path: string[];

  constructor(message: string, path: string[]) {
    super(`${message} at ${path.length === 0 ? '<root>' : path.join('.')}`);
    // Copy: the decoder hot loops push/pop one shared path array.
    this.path = path.slice();
  }
}

/**
 * §7.1 loud-failure. Thrown by `decodeEnvelope` when the caller supplied an
 * `expectedSchemaVersion` that disagrees with the envelope's declared version.
 * Carries both sides of the mismatch so the caller can decide whether to
 * refetch the federated schema and retry or surface the error.
 */
export class SchemaDriftError extends Error {
  override readonly name = 'SchemaDriftError';

  constructor(
    readonly envelopeSchemaVersion: string,
    readonly expectedSchemaVersion: string
  ) {
    super(
      `schema drift: envelope schemaVersion '${envelopeSchemaVersion}' does not match expected '${expectedSchemaVersion}'`
    );
  }
}

export function decodePositional<T = unknown>(
  encoded: unknown,
  fields: FieldInput,
  schema: Schema,
  typeName: string,
  ctx: DecodeContext
): T {
  if (encoded === null || encoded === undefined) return null as T;
  const fieldMap = resolveFieldMap(schema, typeName, [typeName]);
  // A single row is a tuple (array). A list is an array-of-arrays. We can't
  // tell from the value alone, so the caller hands us either — `shapes[key]`
  // at the envelope level drove that choice.
  return decodeValueByArity(encoded, fields, fieldMap, schema, [typeName], ctx) as T;
}

/**
 * Decode a mutation response against its declared `FieldDef`. Symmetric to
 * `encodePositionalFromFieldDef`.
 *
 * @internal — used by `decodeEnvelope` for mutation returns. Treat as
 * package-private.
 */
export function decodePositionalFromFieldDef<T = unknown>(
  encoded: unknown,
  def: FieldDef,
  schema: Schema,
  ctx: DecodeContext,
  path: string[] = []
): T {
  if (encoded === null || encoded === undefined) return null as T;
  return decodeFieldDef(encoded, def, schema, path, ctx) as T;
}

export function decodeEnvelope(bytes: Buffer | Uint8Array, ctx: DecodeEnvelopeCtx): PackEnvelope {
  const raw = unpack(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)) as PackEnvelope;
  // Drift guard runs BEFORE any data decoding: a mismatched schemaVersion
  // means every positional tuple could be shaped against a field order this
  // decoder doesn't know. §7.1 "loud error, not silent corruption".
  if (ctx.expectedSchemaVersion !== undefined && raw.schemaVersion !== ctx.expectedSchemaVersion) {
    throw new SchemaDriftError(raw.schemaVersion, ctx.expectedSchemaVersion);
  }
  const rewritten: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw.data)) {
    // `{ count }` / `{ groups }` ride as named maps (see the encoder).
    if (isAggShape(raw.shapes[key])) {
      rewritten[key] = value;
      continue;
    }
    const returns = ctx.returnsByKey?.[key];
    if (returns !== undefined) {
      const currentNs = ctx.currentNsByKey[key];
      const schema = currentNs !== undefined ? ctx.schemas[currentNs] : undefined;
      if (currentNs === undefined || schema === undefined) {
        rewritten[key] = value;
        continue;
      }
      rewritten[key] = decodeByShapeFromDef(value, returns, schema, raw.shapes[key], {
        schemas: ctx.schemas,
        currentNs
      });
      continue;
    }
    const fields = ctx.fieldsByKey[key];
    const typeName = ctx.typeByKey[key];
    const currentNs = ctx.currentNsByKey[key];
    if (fields === undefined || typeName === undefined || currentNs === undefined) {
      rewritten[key] = value;
      continue;
    }
    const schema = ctx.schemas[currentNs];
    if (schema === undefined) {
      rewritten[key] = value;
      continue;
    }
    const rawShape = raw.shapes[key];
    // Query path: a batched (array) shape never appears here — arrays are
    // mutate-only (§5.13) and flow through the `returnsByKey` branch above.
    // Narrow defensively so the type holds; the array arm is unreachable
    // under the documented transport contract.
    const shape = Array.isArray(rawShape) || isAggShape(rawShape) ? undefined : rawShape;
    rewritten[key] = decodeByShape(value, fields, schema, typeName, shape, {
      schemas: ctx.schemas,
      currentNs
    });
  }
  const out: PackEnvelope = {
    schemaVersion: raw.schemaVersion,
    data: rewritten,
    shapes: raw.shapes
  };
  // Every sidecar needs an explicit line: an omitted one is dropped silently,
  // and a missing `_completeness` reads as "complete".
  if (raw._meta !== undefined) out._meta = raw._meta;
  if (raw._pagination !== undefined) out._pagination = raw._pagination;
  if (raw._completeness !== undefined) out._completeness = raw._completeness;
  if (raw._diagnostics !== undefined) out._diagnostics = raw._diagnostics;
  if (raw.errors !== undefined) out.errors = raw.errors;
  return out;
}

function decodeByShape(
  value: unknown,
  fields: FieldInput,
  schema: Schema,
  typeName: string,
  shape: 'single' | 'list' | undefined,
  ctx: DecodeContext
): unknown {
  if (value === null || value === undefined) return null;
  const fieldMap = resolveFieldMap(schema, typeName, [typeName]);
  // Plan built once per (selection, fieldMap), not per row.
  const plan = getRowPlan(fields, fieldMap);
  if (shape === 'list') {
    if (!Array.isArray(value)) {
      throw new PackDecodeError('expected array for list shape', [typeName]);
    }
    return value.map((elem) => decodeRowWithPlan(elem, plan, schema, [typeName], ctx));
  }
  return decodeRowWithPlan(value, plan, schema, [typeName], ctx);
}

function decodeByShapeFromDef(
  value: unknown,
  def: FieldDef,
  schema: Schema,
  shape: EnvelopeShape | undefined,
  ctx: DecodeContext
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(shape)) {
    // Batched mutate (§5.13): value is an array of per-frame slots; shape is
    // a parallel array of per-frame shapes. Decode each slot independently.
    if (!Array.isArray(value)) {
      throw new PackDecodeError('expected array for batched shape', []);
    }
    return value.map((elem, idx) => decodeByShapeFromDef(elem, def, schema, shape[idx], ctx));
  }
  if (shape === 'list') {
    if (!Array.isArray(value)) {
      throw new PackDecodeError('expected array for list shape', []);
    }
    return value.map((elem, idx) =>
      decodePositionalFromFieldDef(elem, def, schema, ctx, [`[${idx}]`])
    );
  }
  return decodePositionalFromFieldDef(value, def, schema, ctx);
}

function resolveFieldMap(
  schema: Schema,
  typeName: string,
  path: string[]
): Record<string, FieldDef> {
  return sharedResolveFieldMap(
    schema,
    typeName,
    path,
    (message, p) => new PackDecodeError(message, p)
  );
}

/**
 * Decide whether `value` is a single tuple or a list of tuples based on its
 * shape plus the FieldInput — used only by the top-level `decodePositional`
 * helper (the envelope decoder uses `shapes[key]` directly). Heuristic:
 * - null → null
 * - Array where the first element is itself an array → list of rows
 * - Array otherwise → single row (tuple)
 *
 * This heuristic is the ambiguity §7.2 calls out, so callers SHOULD go through
 * `decodeEnvelope` to use explicit shape metadata.
 */
function decodeValueByArity(
  value: unknown,
  fields: FieldInput,
  fieldMap: Record<string, FieldDef>,
  schema: Schema,
  path: string[],
  ctx: DecodeContext
): unknown {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    throw new PackDecodeError('expected array (tuple) for positional row', path);
  }
  const plan = getRowPlan(fields, fieldMap);
  if (value.length > 0 && Array.isArray(value[0])) {
    return value.map((elem) => decodeRowWithPlan(elem, plan, schema, path, ctx));
  }
  return decodeRowWithPlan(value, plan, schema, path, ctx);
}

const DECODE_PLAN_CACHE: RowPlanCache = new WeakMap();

function getRowPlan(fields: FieldInput, fieldMap: Record<string, FieldDef>): RowPlan {
  return sharedGetRowPlan(DECODE_PLAN_CACHE, fields, fieldMap);
}

function decodeRowWithPlan(
  tuple: unknown,
  plan: RowPlan,
  schema: Schema,
  path: string[],
  ctx: DecodeContext
): unknown {
  if (tuple === null || tuple === undefined) return null;
  if (!Array.isArray(tuple)) {
    throw new PackDecodeError('expected array (tuple) for row', path);
  }
  const out: Record<string, unknown> = {};
  const len = plan.length;
  // Mutable path stack — push before recursion, pop after. Allocates only on
  // throw (the error class snapshots the path).
  for (let i = 0; i < len; i++) {
    const entry = plan[i] as RowPlan[number];
    const field = entry[0];
    const selection = entry[1];
    const def = entry[2];
    const cell = tuple[i] ?? null;
    const slot = entry[3];
    // `_truncated` is absent, not null, on a row whose lists were not cut.
    if (slot?.kind === 'truncated' && cell === null) continue;
    path.push(field);
    out[field] =
      slot === undefined
        ? decodeField(cell, selection, def, schema, path, ctx)
        : decodeWalkSlot(cell, slot, schema, path, ctx);
    path.pop();
  }
  return out;
}

function decodeWalkSlot(
  cell: unknown,
  slot: WalkSlot,
  schema: Schema,
  path: string[],
  ctx: DecodeContext
): unknown {
  if (cell === null || cell === undefined) return null;
  switch (slot.kind) {
    case 'truncated':
      return cell;
    case 'agg': {
      if (!Array.isArray(cell)) throw new PackDecodeError('expected array for _agg', path);
      return Object.fromEntries(slot.names.map((n, i) => [n, cell[i] ?? null]));
    }
    case 'nested': {
      if (!Array.isArray(cell)) {
        throw new PackDecodeError('expected array for nested selection', path);
      }
      const plan = getRowPlan(slot.fields, resolveFieldMap(schema, slot.type, path));
      return cell.map((tuple, idx) => {
        path.push(`[${idx}]`);
        const out = decodeRowWithPlan(tuple, plan, schema, path, ctx);
        path.pop();
        return out;
      });
    }
    default:
      return assertNever(slot);
  }
}

function decodeField(
  cell: unknown,
  selection: true | FieldInput,
  def: FieldDef | undefined,
  schema: Schema,
  path: string[],
  ctx: DecodeContext
): unknown {
  if (cell === null || cell === undefined) return null;
  if (def === undefined) return cell;
  if (selection === true) return decodeLeaf(cell, def, path);
  switch (def.kind) {
    case 'scalar':
      throw new PackDecodeError(`field is a scalar (${def.type}); cannot select sub-fields`, path);
    case 'struct':
      return decodeStruct(cell, selection, def, schema, path, ctx);
    case 'list':
      return decodeList(cell, selection, def, schema, path, ctx);
    case 'crossRef':
      return decodeCrossRef(cell, selection, def, schema, path, ctx);
    default:
      return assertNever(def);
  }
}

function decodeLeaf(cell: unknown, def: FieldDef, path: string[]): unknown {
  switch (def.kind) {
    case 'scalar':
      return cell;
    case 'list':
      if (!Array.isArray(cell)) {
        throw new PackDecodeError('expected array for list leaf', path);
      }
      return cell;
    case 'struct':
    case 'crossRef':
      return cell;
    default:
      return assertNever(def);
  }
}

function decodeStruct(
  cell: unknown,
  selection: FieldInput,
  def: FieldDefStruct,
  schema: Schema,
  path: string[],
  ctx: DecodeContext
): unknown {
  return decodeRowWithPlan(cell, getRowPlan(selection, def.fields), schema, path, ctx);
}

function decodeList(
  cell: unknown,
  selection: FieldInput,
  def: FieldDefList,
  schema: Schema,
  path: string[],
  ctx: DecodeContext
): unknown {
  if (!Array.isArray(cell)) {
    throw new PackDecodeError('expected array for list field', path);
  }
  const inner = def.of;
  // Per-element plan built once, not per element.
  const innerPlan: RowPlan | undefined =
    inner.kind === 'struct' ? getRowPlan(selection, inner.fields) : undefined;
  const out: unknown[] = [];
  for (let idx = 0; idx < cell.length; idx++) {
    const elem = cell[idx];
    if (elem === null || elem === undefined) {
      out.push(null);
      continue;
    }
    path.push(`[${idx}]`);
    out.push(decodeListElement(elem, selection, inner, schema, path, ctx, innerPlan));
    path.pop();
  }
  return out;
}

function decodeListElement(
  elem: unknown,
  selection: FieldInput,
  inner: FieldDef,
  schema: Schema,
  elemPath: string[],
  ctx: DecodeContext,
  structPlan?: RowPlan
): unknown {
  switch (inner.kind) {
    case 'scalar':
      throw new PackDecodeError(
        `list element is scalar (${inner.type}); cannot select sub-fields`,
        elemPath
      );
    case 'struct': {
      const plan = structPlan ?? getRowPlan(selection, inner.fields);
      return decodeRowWithPlan(elem, plan, schema, elemPath, ctx);
    }
    case 'list':
      return decodeList(elem, selection, inner, schema, elemPath, ctx);
    case 'crossRef':
      return decodeCrossRef(elem, selection, inner, schema, elemPath, ctx);
    default:
      return assertNever(inner);
  }
}

function decodeCrossRef(
  cell: unknown,
  selection: FieldInput,
  def: FieldDefCrossRef,
  schema: Schema,
  path: string[],
  ctx: DecodeContext
): unknown {
  if (def.ns === ctx.currentNs) {
    const targetFields = resolveFieldMap(schema, def.type, path);
    return decodeRowWithPlan(cell, getRowPlan(selection, targetFields), schema, path, ctx);
  }
  const schemas = ctx.schemas;
  if (schemas === undefined) {
    throw new PackDecodeError(
      `cross-namespace crossRef '${def.ns}/${def.type}' requires ctx.schemas`,
      path
    );
  }
  const targetSchema = schemas[def.ns];
  if (targetSchema === undefined) {
    throw new PackDecodeError(
      `cross-namespace crossRef target namespace '${def.ns}' not in ctx.schemas`,
      path
    );
  }
  const targetFields = resolveFieldMap(targetSchema, def.type, path);
  return decodeRowWithPlan(cell, getRowPlan(selection, targetFields), targetSchema, path, {
    ...ctx,
    currentNs: def.ns
  });
}

// ---------------------------------------------------------------------------
// FieldDef-driven decoding (mutation returns — no client FieldInput)
// ---------------------------------------------------------------------------

function decodeFieldDef(
  value: unknown,
  def: FieldDef,
  schema: Schema,
  path: string[],
  ctx: DecodeContext
): unknown {
  if (value === null || value === undefined) return null;
  switch (def.kind) {
    case 'scalar':
      return value;
    case 'struct':
      return decodeStructFromDef(value, def, schema, path, ctx);
    case 'list':
      return decodeListFromDef(value, def, schema, path, ctx);
    case 'crossRef':
      // CrossRef in a mutation return is the id (eq-on-id convention). We
      // don't reconstruct the target row.
      return value;
    default:
      return assertNever(def);
  }
}

const DECODE_FIELDDEF_PLAN_CACHE: FieldDefPlanCache = new WeakMap();

function getFieldDefPlan(fields: Record<string, FieldDef>): FieldDefPlan {
  return sharedGetFieldDefPlan(DECODE_FIELDDEF_PLAN_CACHE, fields);
}

function decodeStructFromDef(
  value: unknown,
  def: FieldDefStruct,
  schema: Schema,
  path: string[],
  ctx: DecodeContext
): unknown {
  if (!Array.isArray(value)) {
    throw new PackDecodeError('expected array (tuple) for struct', path);
  }
  const out: Record<string, unknown> = {};
  const plan = getFieldDefPlan(def.fields);
  const len = plan.length;
  for (let i = 0; i < len; i++) {
    const entry = plan[i] as readonly [string, FieldDef];
    const fieldName = entry[0];
    const sub = entry[1];
    const cell = value[i] ?? null;
    path.push(fieldName);
    out[fieldName] = decodeFieldDef(cell, sub, schema, path, ctx);
    path.pop();
  }
  return out;
}

function decodeListFromDef(
  value: unknown,
  def: FieldDefList,
  schema: Schema,
  path: string[],
  ctx: DecodeContext
): unknown {
  if (!Array.isArray(value)) {
    throw new PackDecodeError('expected array for list field', path);
  }
  const out: unknown[] = [];
  for (let idx = 0; idx < value.length; idx++) {
    const elem = value[idx];
    if (elem === null || elem === undefined) {
      out.push(null);
      continue;
    }
    path.push(`[${idx}]`);
    out.push(decodeFieldDef(elem, def.of, schema, path, ctx));
    path.pop();
  }
  return out;
}
