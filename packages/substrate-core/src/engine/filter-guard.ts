/**
 * Pre-dispatch filter validation (§5.2) for non-virtual `type` entries on a
 * query: validates where/orderBy and projected fields against the type's
 * schema and dataset capabilities before the resolver runs. Mutations and
 * virtual entries are exempt; their params are resolver-interpreted.
 *
 * Returns `true` when dispatch may proceed, `false` when an error was recorded
 * into the envelope. Errors other than `FilterValidationError` propagate.
 */

import {
  computedFieldOwner,
  hasComputedFields,
  whereContainsOperator
} from '@mnmal-ai/substrate-filter';
import type {
  Dataset,
  FrameEntry,
  OrderByClause,
  PackEnvelope,
  WhereClause
} from '@mnmal-ai/substrate-types';
import { METADATA_FILTER_FIELDS } from '@mnmal-ai/substrate-types';
import {
  FilterValidationError,
  type ValidateFilterInput,
  validateFilter
} from '../filter/validator.js';
import { addError } from './internals.js';

/**
 * Projection keys that are legitimate without being declared fields: `id` is
 * always projectable, `_metadata` is the server-managed metadata projection,
 * and the row-metadata columns are addressable directly.
 */
const PROJECTION_VIRTUAL_KEYS = new Set(['_metadata', ...Object.keys(METADATA_FILTER_FIELDS)]);

export interface FilterGuardDeps {
  schemaFor(ns: string): { types: Record<string, ValidateFilterInput['typeSchema'] | undefined> };
  invalidateSchemaCaches(ns: string): void;
  metric(name: string, payload?: unknown): void;
}

export interface FilterGuardInput {
  envelope: PackEnvelope;
  key: string;
  entry: FrameEntry;
  ns: string;
  name: string;
  operation: 'query' | 'mutate';
  entryKind: 'type' | 'mutation';
  isVirtual: boolean;
  dataset: Pick<Dataset, 'capabilities'> | undefined;
}

export function runFilterGuard(deps: FilterGuardDeps, input: FilterGuardInput): boolean {
  const { envelope, key, entry, ns, name, operation, entryKind, isVirtual, dataset } = input;
  if (!(operation === 'query' && entryKind === 'type' && !isVirtual && dataset)) return true;

  const params = entry.params;
  const where = params?.where as WhereClause | undefined;
  const orderBy = params?.orderBy as OrderByClause[] | undefined;
  const allowTableScan = params?._allowTableScan === true;

  // Computed projections (_score/_vector) require their computing operator in
  // the where-clause, so this runs even when where is absent.
  // hasComputedFields() is only a fast-path; the per-field owner check is
  // authoritative.
  const requested =
    hasComputedFields() && entry.fields !== undefined ? Object.keys(entry.fields) : [];
  for (const f of requested) {
    const owner = computedFieldOwner(f);
    if (owner === undefined) continue;
    if (where === undefined || !whereContainsOperator(where, owner)) {
      addError(
        envelope,
        [key, f],
        `field '${f}' is computed by operator '${owner}' — add it to the where-clause to project it`,
        'computed_field_unavailable'
      );
      deps.metric('engine_computed_field_unavailable', { key, field: f });
      return false;
    }
  }

  // An undeclared projection key materialises as `null` on every row, so it
  // is reported (diagnostic + metric) rather than silent. Deliberately not
  // rejected: during a rolling deploy a newer client legitimately projects a
  // field a not-yet-restarted server does not know.
  if (entry.fields !== undefined) {
    const typeSchema = deps.schemaFor(ns).types[name];
    if (typeSchema) {
      const unknown = Object.keys(entry.fields).filter(
        (f) =>
          !(f in typeSchema.fields) &&
          !PROJECTION_VIRTUAL_KEYS.has(f) &&
          computedFieldOwner(f) === undefined
      );
      if (unknown.length > 0) {
        envelope._diagnostics ??= {};
        envelope._diagnostics[key] = { unknownProjectionFields: unknown };
        deps.metric('engine_unknown_projection_field', { key, fields: unknown });
      }
    }
  }

  if (where !== undefined || orderBy !== undefined) {
    try {
      let typeSchema = deps.schemaFor(ns).types[name];
      if (typeSchema === undefined) {
        // Rebuild once in case the per-ns schema cache predates a
        // post-construction registration whose invalidator was never wired.
        deps.invalidateSchemaCaches(ns);
        typeSchema = deps.schemaFor(ns).types[name];
      }
      if (typeSchema === undefined) {
        // Registered but absent from the published schema (e.g. a type
        // proposed at runtime). Record the skip and let it through rather
        // than refuse: the substrate still rejects predicates it cannot
        // honour, so refusing here would only break those types' queries.
        deps.metric('engine_filter_validation_skipped', { key, reason: 'type_not_in_schema' });
        envelope._diagnostics ??= {};
        envelope._diagnostics[key] = {
          ...(envelope._diagnostics[key] ?? {}),
          filterValidationSkipped: `type '${name}' is registered but absent from the '${ns}' schema`
        };
      } else {
        validateFilter({
          ...(where !== undefined ? { where } : {}),
          ...(orderBy !== undefined ? { orderBy } : {}),
          allowTableScan,
          typeSchema,
          capabilities: dataset.capabilities
        });
      }
    } catch (err) {
      if (err instanceof FilterValidationError) {
        addError(envelope, [key, ...err.path], err.message, err.code);
        deps.metric('engine_filter_validation_error', {
          key,
          code: err.code,
          path: err.path
        });
        return false;
      }
      throw err;
    }
  }
  return true;
}
