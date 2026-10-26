/**
 * Filter validator. Spec: §5.2.
 *
 * Pure function, no I/O. Walks a WhereClause / OrderByClause tree against a
 * type's TypeSchema and a dataset's FilterCapabilities. Throws
 * FilterValidationError on the first problem it finds; the engine catches it
 * and surfaces a structured envelope error per-frame-entry.
 *
 * Error codes (see below) are stable — callers can switch on them.
 *
 * It does not evaluate, rewrite, or inject row-level policy predicates into
 * the clause.
 */

// The extension-operator registry lives in @mnmal-ai/substrate-filter so the
// validator and the pg dataset's pre-resolver share one module-scope Map.
// Re-exported here as public API.
import {
  BOOLEAN_OPS as BOOLEAN_OP_LIST,
  CROSSREF_OPS as CROSSREF_OP_LIST,
  clearExtensionOperators,
  getExtensionOperator,
  isJsonPathPredicate,
  JSON_PATH_OPS as JSON_PATH_OP_LIST,
  jsonPathOperandProblem,
  jsonPathProblem,
  LIST_OPS as LIST_OP_LIST,
  NUMBER_OPS as NUMBER_OP_LIST,
  registerExtensionOperator,
  STRING_OPS as STRING_OP_LIST
} from '@mnmal-ai/substrate-filter';
import {
  assertNever,
  type FieldDef,
  type FieldDefList,
  type FieldDefScalar,
  type FieldDefStruct,
  type FieldKind,
  type FilterCapabilities,
  isImpossibleIsoTimestamp,
  METADATA_FILTER_FIELDS,
  type OrderByClause,
  type TypeSchema,
  type WhereClause
} from '@mnmal-ai/substrate-types';

export { clearExtensionOperators, getExtensionOperator, registerExtensionOperator };

export type FilterErrorCode =
  | 'unknown_field'
  | 'unknown_operator'
  | 'type_mismatch'
  /** @deprecated Never produced: filters no longer refuse an unindexed field. Removed next release. */
  | 'unindexed_field'
  | 'orderby_nonscalar'
  | 'capability_unsupported'
  | 'invalid_between'
  | 'invalid_logical';

export class FilterValidationError extends Error {
  override readonly name = 'FilterValidationError';
  readonly code: FilterErrorCode;
  readonly path: string[];

  constructor(code: FilterErrorCode, message: string, path: string[]) {
    super(message);
    this.code = code;
    this.path = path;
  }
}

// Membership-test views over the canonical builtin allowlists in
// @mnmal-ai/substrate-filter. Add operators there, not here.
const NUMBER_OPS = new Set<string>(NUMBER_OP_LIST);
const STRING_OPS = new Set<string>(STRING_OP_LIST);
const BOOLEAN_OPS = new Set<string>(BOOLEAN_OP_LIST);
const CROSSREF_OPS = new Set<string>(CROSSREF_OP_LIST);
// List fields support element-membership only. `has` takes a single
// element matched against the list's declared `of` type.
const LIST_OPS = new Set<string>(LIST_OP_LIST);
// Json fields: operators valid only inside a `{ path: [...] }` predicate.
const JSON_PATH_OPS = new Set<string>(JSON_PATH_OP_LIST);

/**
 * Always-allowed virtual filter fields: the row id and row-metadata columns,
 * which datasets map onto row infrastructure rather than the body. Filterable
 * on any type whether or not its schema declares them.
 */
const METADATA_VIRTUAL_FIELDS: Readonly<Record<string, FieldDef>> = METADATA_FILTER_FIELDS;

/** A declared field, else a metadata field. Own keys only: `constructor` is a caller's field name, not `Object.prototype`'s. */
function lookupField(fields: Record<string, FieldDef>, name: string): FieldDef | undefined {
  if (Object.hasOwn(fields, name)) return fields[name];
  return Object.hasOwn(METADATA_VIRTUAL_FIELDS, name) ? METADATA_VIRTUAL_FIELDS[name] : undefined;
}

/**
 * The suffix for an unknown field that looks like row metadata. The spellings
 * the read path teaches are normalised before validation, so one reaching
 * here is a variant none of them covers.
 */
function metadataHint(fieldName: string): string {
  if (!/^(_metadata|createdBy|updatedBy)(\.|$)/.test(fieldName)) return '';
  return ' — row metadata is filterable as createdAt, updatedAt, createdBy / updatedBy (an identity id, or { kind, id }), or createdById, createdByKind, updatedById, updatedByKind';
}

const LOGICAL_KEYS = new Set(['AND', 'OR', 'NOT']);

/**
 * Walk context. `insideStruct` is set once the walk descends into a struct's
 * sub-schema, where json path predicates are not supported.
 */
interface WalkContext {
  insideStruct?: boolean;
}

/**
 * Widened FieldKind union used inside the validator. `FieldKind` from
 * substrate-types covers the leaf kinds (`scalar.*`, `crossRef`); struct and list
 * are tree-shape kinds the validator handles at outer layers before delegating
 * to op-resolution.
 */
type ValidatorKind = FieldKind | 'struct' | 'list';

function fieldKindOf(def: FieldDef): ValidatorKind {
  switch (def.kind) {
    case 'scalar':
      switch (def.type) {
        case 'number':
          return 'scalar.number';
        case 'string':
          return 'scalar.string';
        case 'boolean':
          return 'scalar.boolean';
        case 'date':
          return 'scalar.date';
        case 'json':
          return 'scalar.json';
        default:
          // Exhausting every `def.type` literal narrows `def` itself to
          // `never` here, so hand the whole def to the guard.
          return assertNever(def);
      }
    case 'crossRef':
      return 'crossRef';
    case 'struct':
      return 'struct';
    case 'list':
      return 'list';
    default:
      return assertNever(def);
  }
}

function opsAllowedFor(kind: ValidatorKind): Set<string> {
  switch (kind) {
    case 'scalar.number':
    case 'scalar.date':
      return NUMBER_OPS;
    case 'scalar.string':
      return STRING_OPS;
    case 'scalar.boolean':
      return BOOLEAN_OPS;
    case 'crossRef':
      return CROSSREF_OPS;
    case 'list':
      return LIST_OPS;
    case 'scalar.json':
      return JSON_PATH_OPS;
    default:
      return new Set<string>();
  }
}

/**
 * The kinds a dataset declares capabilities for. `struct` is deliberately
 * absent: it is a ValidatorKind but not a FieldKind — a struct is walked INTO
 * rather than filtered on, so there is no dataset capability to intersect.
 */
const FIELD_KINDS: readonly FieldKind[] = [
  'scalar.number',
  'scalar.string',
  'scalar.boolean',
  'scalar.date',
  'scalar.json',
  'crossRef',
  'list'
];

/**
 * The operators `validateLeaf` will accept on each field kind for one
 * dataset: the validator's builtin set intersected with the dataset's
 * `capabilities.operators`. Both gates matter; a third-party dataset may
 * declare less than the builtins.
 *
 * Extension operators are excluded: they are valid on every kind and are
 * listed separately by `Engine.listFilterOperators()`.
 */
export function effectiveFilterOperators(
  capabilities: FilterCapabilities
): Record<FieldKind, string[]> {
  const out = {} as Record<FieldKind, string[]>;
  for (const kind of FIELD_KINDS) {
    const builtin = opsAllowedFor(kind);
    out[kind] = (capabilities.operators[kind] ?? []).filter((op) => builtin.has(op)).sort();
  }
  return out;
}

function isPrimitive(v: unknown): boolean {
  return (
    v === null ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    v instanceof Date
  );
}

/**
 * Check the value shape for a given operator against the field's declared
 * kind. Returns on success, throws on failure. Leniency rules — matching how
 * substrates naturally coerce — kept tight on purpose (e.g. a `string` value
 * on a numeric field is a caller bug, not a silent coerce).
 *
 * `nullable` — when true, `null` elements inside `in`/`nin` arrays are
 * accepted (IS NULL membership semantics). Non-nullable fields still reject
 * null array elements.
 */
function validateValueShape(
  fieldKind: FieldKind,
  op: string,
  value: unknown,
  path: string[],
  nullable = false
): void {
  // `in` / `nin` require arrays; individual elements match the base kind.
  if (op === 'in' || op === 'nin') {
    if (!Array.isArray(value)) {
      throw new FilterValidationError(
        'type_mismatch',
        `operator '${op}' requires an array value`,
        path
      );
    }
    for (const elt of value) {
      if (nullable && elt === null) continue;
      validatePrimitiveKind(fieldKind, elt, path, op);
    }
    return;
  }

  // `between` requires a 2-tuple; elements match the base kind.
  if (op === 'between') {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new FilterValidationError(
        'invalid_between',
        "operator 'between' requires a [low, high] tuple",
        path
      );
    }
    validatePrimitiveKind(fieldKind, value[0], path, op);
    validatePrimitiveKind(fieldKind, value[1], path, op);
    return;
  }

  // `eq` / `neq` permit `null` (IS NULL / IS NOT NULL semantics).
  if ((op === 'eq' || op === 'neq') && value === null) return;

  validatePrimitiveKind(fieldKind, value, path, op);
}

function validatePrimitiveKind(
  fieldKind: FieldKind,
  value: unknown,
  path: string[],
  op: string
): void {
  if (!isPrimitive(value)) {
    throw new FilterValidationError(
      'type_mismatch',
      `operator '${op}' expected a primitive value, got ${typeof value}`,
      path
    );
  }
  switch (fieldKind) {
    case 'scalar.number':
      if (typeof value !== 'number') {
        throw new FilterValidationError(
          'type_mismatch',
          `operator '${op}' expected number, got ${typeof value}`,
          path
        );
      }
      return;
    case 'scalar.string':
      if (typeof value !== 'string') {
        throw new FilterValidationError(
          'type_mismatch',
          `operator '${op}' expected string, got ${typeof value}`,
          path
        );
      }
      return;
    case 'scalar.boolean':
      if (typeof value !== 'boolean') {
        throw new FilterValidationError(
          'type_mismatch',
          `operator '${op}' expected boolean, got ${typeof value}`,
          path
        );
      }
      return;
    case 'scalar.date': {
      // Dates may be supplied as Date instances or ISO strings — the substrate
      // coerces at evaluation. Reject bare numbers / booleans explicitly.
      if (!(value instanceof Date) && typeof value !== 'string') {
        throw new FilterValidationError(
          'type_mismatch',
          `operator '${op}' expected Date or ISO string, got ${typeof value}`,
          path
        );
      }
      // Refused here, once for every dataset: memory would roll Feb 30 over to
      // March, and pg's cast would raise.
      const field = path.slice(path[0] === 'where' ? 1 : 0, -1).join('.');
      if (
        (value instanceof Date && Number.isNaN(value.getTime())) ||
        (typeof value === 'string' && isImpossibleIsoTimestamp(value))
      ) {
        throw new FilterValidationError(
          'type_mismatch',
          `operator '${op}' on '${field}': ${String(value)} is not a real date`,
          path
        );
      }
      return;
    }
    case 'crossRef':
      // crossRef.eq takes an id — string or number (mirrors `Id` in types/core).
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new FilterValidationError(
          'type_mismatch',
          `crossRef '${op}' expected id (string or number), got ${typeof value}`,
          path
        );
      }
      return;
  }
}

function validateLeaf(
  fieldName: string,
  fieldDef: FieldDef,
  leaf: unknown,
  path: string[],
  capabilities: FilterCapabilities,
  ctx: WalkContext
): void {
  // Struct fields take nested WhereClause — recurse into the sub-schema.
  if (fieldDef.kind === 'struct') {
    if (leaf === null || typeof leaf !== 'object' || Array.isArray(leaf)) {
      throw new FilterValidationError(
        'type_mismatch',
        `field '${fieldName}' is a struct — expected a nested where clause object`,
        path
      );
    }
    validateWhereAgainstFields(
      leaf as WhereClause,
      (fieldDef as FieldDefStruct).fields,
      path,
      capabilities,
      { ...ctx, insideStruct: true }
    );
    return;
  }

  // list fields: element-membership via `has`. The operand is a
  // single element validated against the list's declared element type. Lists of
  // structs / nested lists / opaque json have no primitive element to match —
  // reject those.
  if (fieldDef.kind === 'list') {
    const listDef = fieldDef as FieldDefList;
    const elementKind = fieldKindOf(listDef.of);
    if (elementKind === 'struct' || elementKind === 'list' || elementKind === 'scalar.json') {
      throw new FilterValidationError(
        'unknown_operator',
        `field '${fieldName}' is a list of ${elementKind} — only lists of scalars / refs support 'has'`,
        path
      );
    }

    if (leaf === null || typeof leaf !== 'object' || Array.isArray(leaf)) {
      throw new FilterValidationError(
        'type_mismatch',
        `field '${fieldName}' expected a predicate object, got ${typeof leaf}`,
        path
      );
    }

    const datasetCapOps = new Set<string>(capabilities.operators.list ?? []);
    const elemNullable =
      listDef.of.kind === 'scalar' && (listDef.of as FieldDefScalar).nullable === true;
    for (const [op, value] of Object.entries(leaf as Record<string, unknown>)) {
      if (!LIST_OPS.has(op)) {
        throw new FilterValidationError(
          'unknown_operator',
          `operator '${op}' is not valid for field '${fieldName}' (kind=list)`,
          [...path, op]
        );
      }
      if (!datasetCapOps.has(op)) {
        throw new FilterValidationError(
          'capability_unsupported',
          `dataset does not support operator '${op}' on field kind 'list'`,
          [...path, op]
        );
      }
      // `has: null` is element-IS-NULL membership — allowed only when the
      // declared element type is nullable; otherwise it's a caller bug.
      if (value === null) {
        if (!elemNullable) {
          throw new FilterValidationError(
            'type_mismatch',
            `operator 'has' on non-nullable list element of '${fieldName}' cannot be null`,
            [...path, op]
          );
        }
        continue;
      }
      validateValueShape(elementKind as FieldKind, op, value, [...path, op], elemNullable);
    }
    return;
  }

  // Scalar / crossRef: validate ops + indexed
  const kind = fieldKindOf(fieldDef) as FieldKind;

  if (kind === 'scalar.json') {
    // pg's struct walk has no json-path branch and no GIN is derived for a
    // nested field, so accepting this would let memory answer what pg refuses.
    if (ctx.insideStruct === true && isJsonPathPredicate(leaf)) {
      throw new FilterValidationError(
        'unknown_operator',
        `json path filters apply to top-level json fields only — '${fieldName}' is inside a struct (kind=scalar.json)`,
        [...path, 'path']
      );
    }
    validateJsonPathLeaf(fieldName, leaf, path, capabilities);
    return;
  }

  if (leaf === null || typeof leaf !== 'object' || Array.isArray(leaf)) {
    throw new FilterValidationError(
      'type_mismatch',
      `field '${fieldName}' expected a predicate object, got ${typeof leaf}`,
      path
    );
  }

  const allowedOps = opsAllowedFor(kind);
  const datasetCapOps = new Set<string>(capabilities.operators[kind] ?? []);

  for (const [op, value] of Object.entries(leaf as Record<string, unknown>)) {
    if (!allowedOps.has(op)) {
      // Built-in operator set doesn't include this key. Check the extension
      // registry before rejecting — substrate plugins (e.g. substrate-recall's
      // embeddingSimilar) register custom operators here at compose-time.
      const extOp = getExtensionOperator(op);
      if (extOp === undefined) {
        throw new FilterValidationError(
          'unknown_operator',
          `operator '${op}' is not valid for field '${fieldName}' (kind=${kind})`,
          [...path, op]
        );
      }
      // Delegate value validation to the extension operator's own validate fn.
      const vResult = extOp.validate(value);
      if (!vResult.ok) {
        throw new FilterValidationError(
          'type_mismatch',
          `operator '${op}' validation failed: ${(vResult as { ok: false; reason: string }).reason}`,
          [...path, op]
        );
      }
      // Extension operators bypass the dataset capability check — they
      // self-declare support at registration time and the substrate is
      // responsible for executing them.
      continue;
    }
    if (!datasetCapOps.has(op)) {
      throw new FilterValidationError(
        'capability_unsupported',
        `dataset does not support operator '${op}' on field kind '${kind}'`,
        [...path, op]
      );
    }
    const nullable = fieldDef.kind === 'scalar' && (fieldDef as FieldDefScalar).nullable === true;
    validateValueShape(kind, op, value, [...path, op], nullable);
  }
}

const JSON_PATH_HINT = 'address inside it with { path: [...], <op>: ... }';

/**
 * A json field is filterable only through a path predicate. `eq`/`in`/`has`
 * compile to containment, which the GIN derived for
 * `field.json({ indexed: true })` serves; anything else scans the
 * (namespace, type) partition. Either way it is accepted.
 */
function validateJsonPathLeaf(
  fieldName: string,
  leaf: unknown,
  path: string[],
  capabilities: FilterCapabilities
): void {
  const obj =
    leaf !== null && typeof leaf === 'object' && !Array.isArray(leaf)
      ? (leaf as Record<string, unknown>)
      : null;
  if (obj !== null && 'path' in obj && !isJsonPathPredicate(obj)) {
    throw new FilterValidationError(
      'type_mismatch',
      `field '${fieldName}': path must be an array of keys (kind=scalar.json)`,
      [...path, 'path']
    );
  }
  if (!isJsonPathPredicate(leaf)) {
    const op = obj !== null ? Object.keys(obj)[0] : undefined;
    if (op !== undefined) {
      throw new FilterValidationError(
        'unknown_operator',
        `operator '${op}' is not valid for field '${fieldName}' (kind=scalar.json — opaque body; ${JSON_PATH_HINT})`,
        [...path, op]
      );
    }
    throw new FilterValidationError(
      'type_mismatch',
      `field '${fieldName}' is json (opaque body) — predicate object cannot apply; ${JSON_PATH_HINT}`,
      path
    );
  }

  const pathProblem = jsonPathProblem(leaf.path);
  if (pathProblem !== null) {
    throw new FilterValidationError(
      'type_mismatch',
      `field '${fieldName}': ${pathProblem} (kind=scalar.json)`,
      [...path, 'path']
    );
  }
  const ops = Object.keys(leaf).filter((k) => k !== 'path');
  if (ops.length === 0) {
    throw new FilterValidationError(
      'type_mismatch',
      `field '${fieldName}': a json path needs at least one operator beside it (kind=scalar.json)`,
      [...path, 'path']
    );
  }

  const datasetCapOps = new Set<string>(capabilities.operators['scalar.json'] ?? []);
  for (const op of ops) {
    const operand = leaf[op];
    if (!JSON_PATH_OPS.has(op)) {
      throw new FilterValidationError(
        'unknown_operator',
        `operator '${op}' is not valid on a json path of field '${fieldName}' (kind=scalar.json)`,
        [...path, op]
      );
    }
    if (!datasetCapOps.has(op)) {
      throw new FilterValidationError(
        'capability_unsupported',
        `dataset does not support operator '${op}' on field kind 'scalar.json'`,
        [...path, op]
      );
    }
    const problem = jsonPathOperandProblem(op, operand);
    if (problem !== null) {
      throw new FilterValidationError(
        op === 'between' ? 'invalid_between' : 'type_mismatch',
        `operator '${op}' on a json path of field '${fieldName}' ${problem}`,
        [...path, op]
      );
    }
  }
}

function validateWhereAgainstFields(
  where: WhereClause,
  fields: Record<string, FieldDef>,
  path: string[],
  capabilities: FilterCapabilities,
  ctx: WalkContext
): void {
  if (where === null || typeof where !== 'object' || Array.isArray(where)) {
    throw new FilterValidationError('type_mismatch', 'where must be an object', path);
  }

  // Detect logical combinators. The rule: if ANY key is a combinator, every
  // key must be a combinator — mixing fields with AND/OR/NOT is ambiguous
  // (intended implicit AND? intended OR sibling? spec says implicit-AND only
  // on a flat field map). Reject the mixed form.
  const keys = Object.keys(where);
  const hasLogical = keys.some((k) => LOGICAL_KEYS.has(k));
  const hasField = keys.some((k) => !LOGICAL_KEYS.has(k));

  if (hasLogical && hasField) {
    throw new FilterValidationError(
      'invalid_logical',
      `mixing logical combinators (AND/OR/NOT) with field keys at the same level is not allowed`,
      path
    );
  }

  if (hasLogical) {
    for (const k of keys) {
      const child = (where as Record<string, unknown>)[k];
      if (k === 'AND' || k === 'OR') {
        if (!Array.isArray(child)) {
          throw new FilterValidationError(
            'invalid_logical',
            `'${k}' expects an array of WhereClause`,
            [...path, k]
          );
        }
        child.forEach((sub, i) => {
          validateWhereAgainstFields(
            sub as WhereClause,
            fields,
            [...path, k, String(i)],
            capabilities,
            ctx
          );
        });
      } else if (k === 'NOT') {
        if (child === null || typeof child !== 'object' || Array.isArray(child)) {
          throw new FilterValidationError('invalid_logical', `'NOT' expects a single WhereClause`, [
            ...path,
            k
          ]);
        }
        validateWhereAgainstFields(child as WhereClause, fields, [...path, k], capabilities, ctx);
      }
    }
    return;
  }

  // Flat field map — each key is a field name; each value is a leaf predicate
  // (or nested WhereClause for struct fields).
  for (const fieldName of keys) {
    // Check the type's declared fields first, then fall back to the
    // metadata virtual field definitions (createdAt, updatedAt, createdById,
    // createdByKind, updatedById, updatedByKind) — these map onto row._metadata
    // at the dataset layer and are always filterable on any autoCRUD type.
    const def = lookupField(fields, fieldName);
    if (!def) {
      // Before failing, check the extension operator registry — substrate
      // plugins (e.g. substrate-recall's `embeddingSimilar`) register row-level
      // operators that appear at the where-clause root rather than nested
      // inside a field key. Validate the value via the operator's own
      // `validate` fn; the dataset layer pre-resolves these to id-IN clauses
      // before the SQL builder sees them.
      const extOp = getExtensionOperator(fieldName);
      if (extOp !== undefined) {
        const vResult = extOp.validate((where as Record<string, unknown>)[fieldName]);
        if (!vResult.ok) {
          throw new FilterValidationError(
            'type_mismatch',
            `operator '${fieldName}' validation failed: ${(vResult as { ok: false; reason: string }).reason}`,
            [...path, fieldName]
          );
        }
        continue;
      }
      throw new FilterValidationError(
        'unknown_field',
        `unknown field '${fieldName}'${metadataHint(fieldName)}`,
        [...path, fieldName]
      );
    }
    validateLeaf(
      fieldName,
      def,
      (where as Record<string, unknown>)[fieldName],
      [...path, fieldName],
      capabilities,
      ctx
    );
  }
}

function validateOrderBy(
  orderBy: unknown,
  fields: Record<string, FieldDef>,
  capabilities: FilterCapabilities
): void {
  if (!capabilities.orderBy) {
    throw new FilterValidationError('capability_unsupported', 'dataset does not support orderBy', [
      'orderBy'
    ]);
  }

  // Reject non-array shapes (e.g. a bare `{ field: dir }`) here; the engine
  // boundary only casts, so `.forEach` below would otherwise throw a TypeError.
  if (!Array.isArray(orderBy)) {
    throw new FilterValidationError(
      'type_mismatch',
      'orderBy must be an array of { field: "asc" | "desc" } entries',
      ['orderBy']
    );
  }

  (orderBy as OrderByClause[]).forEach((clause, i) => {
    if (clause === null || typeof clause !== 'object' || Array.isArray(clause)) {
      throw new FilterValidationError(
        'type_mismatch',
        'each orderBy entry must be a { field: "asc" | "desc" } object',
        ['orderBy', String(i)]
      );
    }
    const entries = Object.entries(clause);
    if (entries.length !== 1) {
      throw new FilterValidationError(
        'type_mismatch',
        'each orderBy entry must have exactly one field',
        ['orderBy', String(i)]
      );
    }
    const [fieldName, dir] = entries[0] as [string, unknown];
    if (dir !== 'asc' && dir !== 'desc') {
      throw new FilterValidationError(
        'type_mismatch',
        `orderBy direction must be 'asc' or 'desc', got ${String(dir)}`,
        ['orderBy', String(i), fieldName]
      );
    }
    // `id` is always orderable — it's the implicit tie-breaker.
    if (fieldName === 'id') return;

    // Row-metadata projection fields (createdAt/updatedAt/createdBy*/updatedBy*)
    // are virtual filter fields — not declared in type schemas — but the dataset
    // layer routes them to indexed native columns. Same fallback as
    // validateWhereAgainstFields.
    const def = lookupField(fields, fieldName);
    if (!def) {
      throw new FilterValidationError(
        'unknown_field',
        `unknown field '${fieldName}' in orderBy${metadataHint(fieldName)}`,
        ['orderBy', String(i), fieldName]
      );
    }
    if (def.kind !== 'scalar') {
      throw new FilterValidationError(
        'orderby_nonscalar',
        `orderBy on non-scalar field '${fieldName}' is not supported (kind=${def.kind})`,
        ['orderBy', String(i), fieldName]
      );
    }
    // scalar.json is an opaque body — no per-key ordering. Reject with the
    // same code as non-scalar fields; the message disambiguates.
    if ((def as FieldDefScalar).type === 'json') {
      throw new FilterValidationError(
        'orderby_nonscalar',
        `orderBy on json field '${fieldName}' is not supported (opaque body)`,
        ['orderBy', String(i), fieldName]
      );
    }
  });
}

export interface ValidateFilterInput {
  where?: WhereClause;
  orderBy?: OrderByClause[];
  /** @deprecated Accepted and ignored: filters never refuse an unindexed field. */
  allowTableScan?: boolean;
  typeSchema: TypeSchema;
  capabilities: FilterCapabilities;
}

export function validateFilter(input: ValidateFilterInput): void {
  if (input.where !== undefined) {
    validateWhereAgainstFields(
      input.where,
      input.typeSchema.fields,
      ['where'],
      input.capabilities,
      {}
    );
  }
  if (input.orderBy !== undefined) {
    validateOrderBy(input.orderBy, input.typeSchema.fields, input.capabilities);
  }
}
