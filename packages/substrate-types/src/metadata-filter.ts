/**
 * Row-metadata filter names. Every type can be filtered and ordered on its
 * row's id and server-managed metadata, which datasets serve from native
 * columns rather than the body. The canonical names are the columns
 * (`createdById`, `createdByKind`, …); the spellings the read path teaches —
 * `createdBy` / `updatedBy` as returned under `_metadata`, the `_metadata`
 * nesting itself, and `createdBy.id`-style paths — are normalised onto them
 * before validation, so a caller that filters on what it read is not refused.
 */

import type { FieldDef } from './schema.js';

/** The canonical metadata filter columns, filterable and orderable on every type. */
export const METADATA_FILTER_FIELDS: Readonly<Record<string, FieldDef>> = {
  id: { kind: 'scalar', type: 'string', indexed: true },
  createdAt: { kind: 'scalar', type: 'date', indexed: true },
  updatedAt: { kind: 'scalar', type: 'date', indexed: true },
  createdById: { kind: 'scalar', type: 'string', indexed: true },
  createdByKind: { kind: 'scalar', type: 'string', indexed: true },
  updatedById: { kind: 'scalar', type: 'string', indexed: true },
  updatedByKind: { kind: 'scalar', type: 'string', indexed: true },
  /** Commit order on an `ordering: 'visible'` type; null on every other type. */
  seq: { kind: 'scalar', type: 'number', indexed: true }
};

/**
 * The author names `_metadata` returns, and the columns behind each half of
 * their `{ kind, id }` value. A plain operand on the author name matches the id.
 */
export const METADATA_AUTHOR_FIELDS = {
  createdBy: { id: 'createdById', kind: 'createdByKind' },
  updatedBy: { id: 'updatedById', kind: 'updatedByKind' }
} as const;

type AuthorName = keyof typeof METADATA_AUTHOR_FIELDS;
type Where = Record<string, unknown>;

const isAuthor = (name: string): name is AuthorName => Object.hasOwn(METADATA_AUTHOR_FIELDS, name);
const isRecord = (v: unknown): v is Where =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Metadata names valid under `_metadata`: the columns other than `id`, and the author names. */
const isMetadataName = (name: string): boolean =>
  (name !== 'id' && Object.hasOwn(METADATA_FILTER_FIELDS, name)) || isAuthor(name);

/** A dotted or `_metadata`-prefixed name resolved to a column or author name, if it is one. */
function resolveName(name: string): string | undefined {
  const parts = name.split('.');
  if (parts[0] === '_metadata') parts.shift();
  if (parts.length === 1 && parts[0] !== undefined && isMetadataName(parts[0])) return parts[0];
  const [head, half] = parts;
  if (
    parts.length === 2 &&
    head !== undefined &&
    isAuthor(head) &&
    (half === 'id' || half === 'kind')
  ) {
    return METADATA_AUTHOR_FIELDS[head][half];
  }
  return undefined;
}

/** The clause matching an author object `{ kind?, id? }`, or undefined when it names neither. */
function authorObjectClause(author: AuthorName, value: unknown): Where | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((k) => k !== 'id' && k !== 'kind')) return undefined;
  const cols = METADATA_AUTHOR_FIELDS[author];
  const clause: Where = {};
  if ('id' in value) clause[cols.id] = { eq: value.id };
  if ('kind' in value) clause[cols.kind] = { eq: value.kind };
  return clause;
}

/** Collects normalised keys; a second predicate on one column is ANDed, never overwritten. */
class Builder {
  readonly out: Where = {};
  readonly extra: Where[] = [];

  put(key: string, pred: unknown): void {
    if (Object.hasOwn(this.out, key)) this.extra.push({ [key]: pred });
    else this.out[key] = pred;
  }

  // One AND of everything: field keys beside an AND are refused by the validator.
  result(): Where {
    if (this.extra.length === 0) return this.out;
    if (Object.keys(this.out).length === 0) return { AND: this.extra };
    return { AND: [this.out, ...this.extra] };
  }
}

function putAuthor(b: Builder, author: AuthorName, pred: unknown): void {
  const cols = METADATA_AUTHOR_FIELDS[author];
  if (!isRecord(pred)) {
    b.put(cols.id, pred);
    return;
  }
  const keys = Object.keys(pred);
  // Sub-field form: `{ id: <pred>, kind: <pred> }`.
  if (keys.length > 0 && keys.every((k) => k === 'id' || k === 'kind')) {
    if ('id' in pred) b.put(cols.id, pred.id);
    if ('kind' in pred) b.put(cols.kind, pred.kind);
    return;
  }
  // Path form: `{ path: ['id' | 'kind'], <op>: … }`.
  const path = pred.path;
  if (Array.isArray(path) && path.length === 1 && (path[0] === 'id' || path[0] === 'kind')) {
    const { path: _path, ...ops } = pred;
    b.put(cols[path[0] as 'id' | 'kind'], ops);
    return;
  }
  const idPred: Where = {};
  for (const [op, operand] of Object.entries(pred)) {
    if ((op === 'eq' || op === 'neq') && authorObjectClause(author, operand) !== undefined) {
      const clause = authorObjectClause(author, operand) as Where;
      b.extra.push(op === 'eq' ? clause : { NOT: clause });
      continue;
    }
    if ((op === 'in' || op === 'nin') && Array.isArray(operand)) {
      const objects = operand.map((v) => authorObjectClause(author, v));
      if (objects.some((c) => c !== undefined)) {
        const ids = operand.filter((_, i) => objects[i] === undefined);
        const any: Where[] = [
          ...(ids.length > 0 ? [{ [cols.id]: { in: ids } }] : []),
          ...objects.filter((c): c is Where => c !== undefined)
        ];
        b.extra.push(op === 'in' ? { OR: any } : { NOT: { OR: any } });
        continue;
      }
    }
    idPred[op] = operand;
  }
  if (Object.keys(idPred).length > 0) b.put(cols.id, idPred);
}

function putResolved(b: Builder, name: string, pred: unknown): void {
  if (isAuthor(name)) putAuthor(b, name, pred);
  else b.put(name, pred);
}

/**
 * Rewrites every metadata spelling in a `where` clause onto the canonical
 * columns, through AND / OR / NOT. A name the type declares as a field of its
 * own is left alone, and so is anything that is not a metadata spelling, for
 * the validator to judge.
 */
export function normaliseMetadataWhere(
  where: unknown,
  fieldDefs: Record<string, FieldDef>
): unknown {
  if (!isRecord(where)) return where;
  const b = new Builder();
  for (const [key, value] of Object.entries(where)) {
    if ((key === 'AND' || key === 'OR') && Array.isArray(value)) {
      b.out[key] = value.map((w) => normaliseMetadataWhere(w, fieldDefs));
    } else if (key === 'NOT') {
      b.out[key] = normaliseMetadataWhere(value, fieldDefs);
    } else if (Object.hasOwn(fieldDefs, key)) {
      b.put(key, value);
    } else if (key === '_metadata' && isRecord(value)) {
      for (const [inner, pred] of Object.entries(value)) {
        const name = resolveName(inner);
        if (name === undefined) b.put(`_metadata.${inner}`, pred);
        else putResolved(b, name, pred);
      }
    } else {
      const name = resolveName(key);
      if (name === undefined) b.put(key, value);
      else putResolved(b, name, value);
    }
  }
  return b.result();
}

/** Rewrites metadata spellings in an `orderBy` list; an author name sorts by its id. */
export function normaliseMetadataOrderBy(
  orderBy: unknown,
  fieldDefs: Record<string, FieldDef>
): unknown {
  if (!Array.isArray(orderBy)) return orderBy;
  return orderBy.map((entry) => {
    if (!isRecord(entry)) return entry;
    const out: Where = {};
    for (const [key, dir] of Object.entries(entry)) {
      const name = Object.hasOwn(fieldDefs, key) ? undefined : resolveName(key);
      const column = name !== undefined && isAuthor(name) ? METADATA_AUTHOR_FIELDS[name].id : name;
      out[column ?? key] = dir;
    }
    return out;
  });
}
