/**
 * Positional encoder. Spec: §7.0, §7.5.
 *
 * Strips field names from the wire. For a selected FieldInput, emits a tuple
 * of values in iteration order; the decoder reconstructs the named object
 * using the same FieldInput plus the schema cached at client init. The win is
 * parse time (§7.5) — msgpackr handles named objects fine, but positional
 * arrays skip the key lookup per cell, which compounds across thousand-row
 * responses.
 *
 * Contract: `encodePositional` is shape-blind. Callers decide single-vs-list
 * via `PackEnvelope.shapes[key]` (§7.2) and pass either a row or an array
 * of rows; the encoder emits the corresponding tuple or array-of-tuples. It does
 * NOT infer list-vs-single from the value shape.
 *
 * Mutation responses use `encodePositionalFromFieldDef` — mutations don't
 * carry a client-sent `FieldInput`, so the FieldDef declared at registration
 * (MutationSchema.returns) drives the encoding directly.
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
import { pack } from 'msgpackr';
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

export interface EncodeContext {
  /** Federated schema map — required when the type has any crossRef fields selected. */
  schemas?: Record<string, Schema>;
  /** Namespace owning the current type. Used to detect crossRef boundary crossings. */
  currentNs: string;
}

export interface EncodeEnvelopeCtx {
  /** Query-path selection map — keyed by envelope key. */
  fieldsByKey: Record<string, FieldInput>;
  /**
   * Mutation-path return-shape map — keyed by envelope key. Mutation responses
   * don't carry a client-sent FieldInput; their shape is declared at registry
   * time as `MutationSchema.returns` and wired through here.
   */
  returnsByKey?: Record<string, FieldDef>;
  /** Query-path type-name map — keyed by envelope key. */
  typeByKey: Record<string, string>;
  schemas: Record<string, Schema>;
  /** Namespace owning each envelope key's type or mutation. */
  currentNsByKey: Record<string, string>;
}

/**
 * @internal — error thrown by the positional encoder on malformed input.
 * Exported, but treat as package-private.
 */
export class PackEncodeError extends Error {
  override readonly name = 'PackEncodeError';
  readonly path: string[];

  constructor(message: string, path: string[]) {
    super(`${message} at ${path.length === 0 ? '<root>' : path.join('.')}`);
    // Copy: the encoder hot loops push/pop one shared path array.
    this.path = path.slice();
  }
}

export function encodePositional(
  value: unknown,
  fields: FieldInput,
  schema: Schema,
  typeName: string,
  ctx: EncodeContext
): unknown {
  if (value === null || value === undefined) return null;
  const fieldMap = resolveFieldMap(schema, typeName, [typeName]);
  // Plan built once per (selection, fieldMap), not per row.
  const plan = getRowPlan(fields, fieldMap);
  if (Array.isArray(value)) {
    return value.map((row) => encodeRowWithPlan(row, plan, schema, [typeName], ctx));
  }
  return encodeRowWithPlan(value, plan, schema, [typeName], ctx);
}

/**
 * Encode a mutation response against its declared `FieldDef` (no client-sent
 * FieldInput). Symmetric to `encodePositional` but driven entirely by the
 * schema descriptor.
 *
 * - `scalar` → value passes through (nullable tolerated)
 * - `struct` → positional tuple over `def.fields` iteration order
 * - `list`   → value is an array; each element encoded against `def.of`
 * - `crossRef` → value is expected to be an id scalar (eq-on-id; we don't
 *   recurse into the target type — mutation returns don't embed sub-rows)
 *
 * @internal — used by `encodeEnvelope` for mutation returns. Treat as
 * package-private.
 */
export function encodePositionalFromFieldDef(
  value: unknown,
  def: FieldDef,
  schema: Schema,
  ctx: EncodeContext,
  path: string[] = []
): unknown {
  if (value === null || value === undefined) return null;
  return encodeFieldDef(value, def, schema, path, ctx);
}

export function encodeEnvelope(envelope: PackEnvelope, ctx: EncodeEnvelopeCtx): Buffer {
  const rewritten: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(envelope.data)) {
    // `{ count }` and `{ groups, truncated? }` carry no rows to position:
    // they ride as named maps, and `shapes[key]` says which.
    if (isAggShape(envelope.shapes[key])) {
      rewritten[key] = value;
      continue;
    }
    const returns = ctx.returnsByKey?.[key];
    if (returns !== undefined) {
      const currentNs = ctx.currentNsByKey[key];
      const schema = currentNs !== undefined ? ctx.schemas[currentNs] : undefined;
      if (currentNs === undefined || schema === undefined) {
        // No namespace/schema resolved — mutation data stays as-is under the
        // outer msgpack wrapper. Matches the "error-only envelope" fallback.
        rewritten[key] = value;
        continue;
      }
      rewritten[key] = encodePositionalForShape(value, returns, schema, envelope.shapes[key], {
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
    rewritten[key] = encodePositional(value, fields, schema, typeName, {
      schemas: ctx.schemas,
      currentNs
    });
  }

  // Everything but `data` passes through. Every sidecar needs an explicit
  // line: an omitted one is dropped silently, and a missing `_completeness`
  // reads as "complete".
  const out: PackEnvelope = {
    schemaVersion: envelope.schemaVersion,
    data: rewritten,
    shapes: envelope.shapes
  };
  if (envelope._meta !== undefined) out._meta = envelope._meta;
  if (envelope._pagination !== undefined) out._pagination = envelope._pagination;
  if (envelope._completeness !== undefined) out._completeness = envelope._completeness;
  if (envelope._diagnostics !== undefined) out._diagnostics = envelope._diagnostics;
  if (envelope.errors !== undefined) out.errors = envelope.errors;
  return Buffer.from(pack(out));
}

/** A shape whose value is a `{ count }` or `{ groups }` map, not rows. */
export function isAggShape(shape: EnvelopeShape | undefined): shape is 'count' | 'groups' {
  return shape === 'count' || shape === 'groups';
}

/**
 * Encode a single envelope value against its declared `returns` FieldDef,
 * honouring the envelope's single-vs-list shape for that key. `single` encodes
 * one row; `list` encodes an array of rows element-by-element.
 *
 * Batched mutate (§5.13): when the shape is `Array<'single' | 'list'>`, the
 * value is itself `Array<unknown>` (one per-frame slot); each slot encodes
 * against the same FieldDef using its own per-frame shape.
 */
function encodePositionalForShape(
  value: unknown,
  def: FieldDef,
  schema: Schema,
  shape: EnvelopeShape | undefined,
  ctx: EncodeContext
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) {
      throw new PackEncodeError('expected array for batched shape', []);
    }
    return value.map((elem, idx) => {
      const perFrameShape = shape[idx];
      return encodePositionalForShape(elem, def, schema, perFrameShape, ctx);
    });
  }
  if (shape === 'list') {
    if (!Array.isArray(value)) {
      throw new PackEncodeError('expected array for list shape', []);
    }
    return value.map((elem, idx) =>
      encodePositionalFromFieldDef(elem, def, schema, ctx, [`[${idx}]`])
    );
  }
  return encodePositionalFromFieldDef(value, def, schema, ctx);
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
    (message, p) => new PackEncodeError(message, p)
  );
}

const ENCODE_PLAN_CACHE: RowPlanCache = new WeakMap();

function getRowPlan(fields: FieldInput, fieldMap: Record<string, FieldDef>): RowPlan {
  return sharedGetRowPlan(ENCODE_PLAN_CACHE, fields, fieldMap);
}

function encodeRowWithPlan(
  row: unknown,
  plan: RowPlan,
  schema: Schema,
  path: string[],
  ctx: EncodeContext
): unknown {
  if (row === null || row === undefined) return null;
  if (typeof row !== 'object' || Array.isArray(row)) {
    throw new PackEncodeError(
      `expected object row, got ${Array.isArray(row) ? 'array' : typeof row}`,
      path
    );
  }
  const rowObj = row as Record<string, unknown>;
  const len = plan.length;
  const tuple: unknown[] = new Array(len);
  // Mutable path stack — push before recursion, pop after. Allocates only on
  // throw (the error class snapshots the path).
  for (let i = 0; i < len; i++) {
    const entry = plan[i] as RowPlan[number];
    const field = entry[0];
    const selection = entry[1];
    const def = entry[2];
    const value = Object.hasOwn(rowObj, field) ? rowObj[field] : undefined;
    path.push(field);
    const slot = entry[3];
    tuple[i] =
      slot === undefined
        ? encodeField(value, selection, def, schema, path, ctx)
        : encodeWalkSlot(value, slot, schema, path, ctx);
    path.pop();
  }
  return tuple;
}

function encodeWalkSlot(
  value: unknown,
  slot: WalkSlot,
  schema: Schema,
  path: string[],
  ctx: EncodeContext
): unknown {
  if (value === null || value === undefined) return null;
  switch (slot.kind) {
    case 'truncated':
      return value;
    case 'agg': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        throw new PackEncodeError('expected object for _agg', path);
      }
      const aggs = value as Record<string, unknown>;
      return slot.names.map((n) => coerceScalar(Object.hasOwn(aggs, n) ? aggs[n] : null));
    }
    case 'nested': {
      if (!Array.isArray(value)) {
        throw new PackEncodeError('expected array for nested selection', path);
      }
      const plan = getRowPlan(slot.fields, resolveFieldMap(schema, slot.type, path));
      return value.map((row, idx) => {
        path.push(`[${idx}]`);
        const out = encodeRowWithPlan(row, plan, schema, path, ctx);
        path.pop();
        return out;
      });
    }
    default:
      return assertNever(slot);
  }
}

function encodeField(
  value: unknown,
  selection: true | FieldInput,
  def: FieldDef | undefined,
  schema: Schema,
  path: string[],
  ctx: EncodeContext
): unknown {
  if (value === null || value === undefined) return null;

  // Undeclared field: pass the value through; a row may carry more keys than
  // the registry knows about.
  if (def === undefined) {
    return selection === true ? coerceScalar(value) : value;
  }

  if (selection === true) return encodeLeaf(value, def, path);

  switch (def.kind) {
    case 'scalar':
      throw new PackEncodeError(`field is a scalar (${def.type}); cannot select sub-fields`, path);
    case 'struct':
      return encodeStruct(value, selection, def, schema, path, ctx);
    case 'list':
      return encodeList(value, selection, def, schema, path, ctx);
    case 'crossRef':
      return encodeCrossRef(value, selection, def, schema, path, ctx);
    default:
      return assertNever(def);
  }
}

function encodeLeaf(value: unknown, def: FieldDef, path: string[]): unknown {
  switch (def.kind) {
    case 'scalar':
      return coerceScalar(value);
    case 'list':
      // `true` on a list is a whole-list selection. For a list-of-scalars this
      // is the natural emission; for list-of-struct it's a deliberate "I want
      // the entire row shape" — we emit as-is rather than throw. The client
      // chose not to project.
      if (!Array.isArray(value)) {
        throw new PackEncodeError('expected array for list field', path);
      }
      return value.map((v) => coerceScalar(v));
    case 'struct':
    case 'crossRef':
      // `true` on a struct or crossRef names no sub-fields: pass the raw
      // value through.
      return value;
    default:
      return assertNever(def);
  }
}

function encodeStruct(
  value: unknown,
  selection: FieldInput,
  def: FieldDefStruct,
  schema: Schema,
  path: string[],
  ctx: EncodeContext
): unknown {
  return encodeRowWithPlan(value, getRowPlan(selection, def.fields), schema, path, ctx);
}

function encodeList(
  value: unknown,
  selection: FieldInput,
  def: FieldDefList,
  schema: Schema,
  path: string[],
  ctx: EncodeContext
): unknown {
  if (!Array.isArray(value)) {
    throw new PackEncodeError('expected array for list field', path);
  }
  const inner = def.of;
  // Per-element plan built once, not per element.
  const innerPlan: RowPlan | undefined =
    inner.kind === 'struct' ? getRowPlan(selection, inner.fields) : undefined;
  const out: unknown[] = [];
  for (let idx = 0; idx < value.length; idx++) {
    const elem = value[idx];
    if (elem === null || elem === undefined) {
      out.push(null);
      continue;
    }
    path.push(`[${idx}]`);
    out.push(encodeListElement(elem, selection, inner, schema, path, ctx, innerPlan));
    path.pop();
  }
  return out;
}

function encodeListElement(
  elem: unknown,
  selection: FieldInput,
  inner: FieldDef,
  schema: Schema,
  elemPath: string[],
  ctx: EncodeContext,
  structPlan?: RowPlan
): unknown {
  switch (inner.kind) {
    case 'scalar':
      // Sub-selection on a list-of-scalar is a shape mismatch; scalars don't
      // have sub-fields.
      throw new PackEncodeError(
        `list element is scalar (${inner.type}); cannot select sub-fields`,
        elemPath
      );
    case 'struct': {
      const plan = structPlan ?? getRowPlan(selection, inner.fields);
      return encodeRowWithPlan(elem, plan, schema, elemPath, ctx);
    }
    case 'list':
      return encodeList(elem, selection, inner, schema, elemPath, ctx);
    case 'crossRef':
      return encodeCrossRef(elem, selection, inner, schema, elemPath, ctx);
    default:
      return assertNever(inner);
  }
}

function encodeCrossRef(
  value: unknown,
  selection: FieldInput,
  def: FieldDefCrossRef,
  schema: Schema,
  path: string[],
  ctx: EncodeContext
): unknown {
  if (def.ns === ctx.currentNs) {
    // In-namespace hop — reuse the current schema.
    const targetFields = resolveFieldMap(schema, def.type, path);
    return encodeRowWithPlan(value, getRowPlan(selection, targetFields), schema, path, ctx);
  }
  const schemas = ctx.schemas;
  if (schemas === undefined) {
    throw new PackEncodeError(
      `cross-namespace crossRef '${def.ns}/${def.type}' requires ctx.schemas`,
      path
    );
  }
  const targetSchema = schemas[def.ns];
  if (targetSchema === undefined) {
    throw new PackEncodeError(
      `cross-namespace crossRef target namespace '${def.ns}' not in ctx.schemas`,
      path
    );
  }
  const targetFields = resolveFieldMap(targetSchema, def.type, path);
  return encodeRowWithPlan(value, getRowPlan(selection, targetFields), targetSchema, path, {
    ...ctx,
    currentNs: def.ns
  });
}

// ---------------------------------------------------------------------------
// FieldDef-driven encoding (mutation returns — no client FieldInput)
// ---------------------------------------------------------------------------

function encodeFieldDef(
  value: unknown,
  def: FieldDef,
  schema: Schema,
  path: string[],
  ctx: EncodeContext
): unknown {
  if (value === null || value === undefined) return null;
  switch (def.kind) {
    case 'scalar':
      return coerceScalar(value);
    case 'struct':
      return encodeStructFromDef(value, def, schema, path, ctx);
    case 'list':
      return encodeListFromDef(value, def, schema, path, ctx);
    case 'crossRef':
      // CrossRef in a mutation-return shape is the referenced id (eq-on-id
      // convention). We don't embed the target row — mutations return ids,
      // not resolved graphs.
      return coerceScalar(value);
    default:
      return assertNever(def);
  }
}

const ENCODE_FIELDDEF_PLAN_CACHE: FieldDefPlanCache = new WeakMap();

function getFieldDefPlan(fields: Record<string, FieldDef>): FieldDefPlan {
  return sharedGetFieldDefPlan(ENCODE_FIELDDEF_PLAN_CACHE, fields);
}

function encodeStructFromDef(
  value: unknown,
  def: FieldDefStruct,
  schema: Schema,
  path: string[],
  ctx: EncodeContext
): unknown {
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new PackEncodeError(
      `expected object for struct, got ${Array.isArray(value) ? 'array' : typeof value}`,
      path
    );
  }
  const rowObj = value as Record<string, unknown>;
  // Iterate declared fields in insertion order — matches what the decoder
  // expects. Extra keys on the value are dropped; missing keys surface as null.
  const plan = getFieldDefPlan(def.fields);
  const len = plan.length;
  const tuple: unknown[] = new Array(len);
  for (let i = 0; i < len; i++) {
    const entry = plan[i] as readonly [string, FieldDef];
    const fieldName = entry[0];
    const sub = entry[1];
    const cell = Object.hasOwn(rowObj, fieldName) ? rowObj[fieldName] : undefined;
    if (cell === undefined) {
      tuple[i] = null;
      continue;
    }
    path.push(fieldName);
    tuple[i] = encodeFieldDef(cell, sub, schema, path, ctx);
    path.pop();
  }
  return tuple;
}

function encodeListFromDef(
  value: unknown,
  def: FieldDefList,
  schema: Schema,
  path: string[],
  ctx: EncodeContext
): unknown {
  if (!Array.isArray(value)) {
    throw new PackEncodeError('expected array for list field', path);
  }
  const out: unknown[] = [];
  for (let idx = 0; idx < value.length; idx++) {
    const elem = value[idx];
    if (elem === null || elem === undefined) {
      out.push(null);
      continue;
    }
    path.push(`[${idx}]`);
    out.push(encodeFieldDef(elem, def.of, schema, path, ctx));
    path.pop();
  }
  return out;
}

/**
 * Identity today — msgpackr round-trips Dates natively. Kept as the single
 * choke point for any future scalar normalisation.
 */
function coerceScalar(value: unknown): unknown {
  return value;
}
