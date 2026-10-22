/**
 * autoCRUD `create<T>` resolver. Spec: §5.1.
 *
 * Accepts the entity body via `params`. Generates a UUID id when absent.
 * `_deletedAt` is stripped at the dataset layer — no sanitation needed here.
 *
 * Design call: id generation is `crypto.randomUUID()` rather than monotonic
 * counters so two engines pointed at the same dataset (future) don't collide.
 *
 * When `options.fields` is supplied, any field with `readonly: true` is
 * rejected if the caller includes it in params — shortId is the primary use
 * case. The engine allocates shortId post-write and binds
 * it in the same transaction via `ds.allocateShortId` / `ds.bindShortId`.
 */

import { randomUUID } from 'node:crypto';
import type {
  Dataset,
  FieldDef,
  Id,
  Row,
  RowMetadata,
  TypedResolver
} from '@mnmal-ai/substrate-types';
import { normaliseVocabValues, ResolverFrameError } from '@mnmal-ai/substrate-types';
import {
  applyScalarDefaults,
  assertEnumValues,
  assertNoClientServerFields,
  assertNoNullOnNonNullable,
  assertNoUnknownFields,
  assertRequiredFields,
  assertScalarTypes,
  coerceId,
  dropUndefinedParams,
  resolveIdentity
} from './internal.js';

export interface CreateResolverOptions {
  /** Type field definitions. Used to detect readonly fields and drive shortId allocation. */
  fields?: Record<string, FieldDef>;
}

export function createResolver<T extends Row = Row>(
  typeName: string,
  dataset: Dataset,
  options: CreateResolverOptions = {}
): TypedResolver<T> {
  return async (ctx, args) => {
    // Prefer the engine-supplied handle (§5.3 / G1 tx view); the closed-over
    // dataset is a fallback for direct-resolver unit tests.
    const ds = args.dataset ?? dataset;
    // Own a shallow copy — applyScalarDefaults mutates it to fill omitted
    // defaults, and the caller's bag must not be mutated out from under them.
    const params = dropUndefinedParams(args.params ?? {});

    // Reject client-supplied server fields (Tier-1: row metadata;
    // Tier-2: serverSet date fields). Must run before any other validation so
    // the error code is unambiguous.
    if (options.fields) {
      assertNoClientServerFields(params, options.fields, 'create');
    }

    // Reject caller-supplied values for readonly fields. shortId is the main
    // case: it is engine-allocated, not caller-controlled. Throw a
    // ResolverFrameError so the engine surfaces it as env.errors without
    // rolling back the whole frame (consistent with other per-key rejections).
    if (options.fields) {
      for (const [fieldName, def] of Object.entries(options.fields)) {
        // `readonly` lives on FieldDefScalar only (see substrate-types/schema.ts).
        // Guard on kind so the property access is type-safe rather than cast.
        if (def.kind === 'scalar' && def.readonly === true && fieldName in params) {
          throw new ResolverFrameError(
            'readonly_field',
            `Cannot set read-only field '${fieldName}' (engine-allocated)`,
            { field: fieldName }
          );
        }
      }
    }

    // Controlled-vocabulary guard. Runs after readonly/server-field checks so
    // their codes take precedence; covers memory + pg uniformly.
    if (options.fields) {
      Object.assign(params, normaliseVocabValues(params, options.fields));
      assertEnumValues(params, options.fields);
    }

    // Contract guard: the declared FieldDef map is the allow-list. Reject any
    // undeclared top-level key so a typo or stale field name fails loud instead
    // of being silently spread into the row body. Runs LAST so the readonly /
    // server-field / enum guards keep their more-specific codes.
    if (options.fields) {
      assertNoUnknownFields(params, options.fields, 'create');
    }

    // Fill create-time defaults, then enforce required scalars. A `default`
    // makes omission legitimate (e.g. archived → false); a non-nullable scalar
    // with neither a supplied value nor a default is required, and its absence
    // fails loud (`missing_required_field`) rather than writing a partial row.
    if (options.fields) {
      assertNoNullOnNonNullable(params, options.fields, 'create');
      assertScalarTypes(params, options.fields, 'create');
      applyScalarDefaults(params, options.fields);
      assertRequiredFields(params, options.fields);
    }

    const id: Id = coerceId(params.id) ?? randomUUID();
    // Tier-1 row metadata — server-populated on every create.
    const at = ctx.now.toISOString();
    const actor = resolveIdentity(ctx);
    const _metadata: RowMetadata = {
      createdAt: at,
      updatedAt: at,
      createdBy: actor,
      updatedBy: actor
    };

    const row: Row = { ...params, id, _metadata } as Row;
    // Insert-only: a row with this id, live or deleted, is never overwritten,
    // and of two concurrent creates with one id exactly one lands.
    // WriteResult.rows[0] carries the substrate's canonical view (post any
    // reserved-field sanitisation), so no follow-up read is needed.
    const { rows: writtenRows } = await ds.write(typeName, [row], { insertOnly: true });
    const storedRow = writtenRows[0];
    if (storedRow === undefined) {
      throw new ResolverFrameError('id_exists', `create${typeName}: a row with id '${id}' exists`, {
        field: 'id'
      });
    }

    // If the type has a readonly shortId field, allocate and bind it in the
    // same transaction. The engine wraps the whole mutate frame in a G1 tx
    // (when called via engine.mutate), so ds is already the tx-scoped handle
    // — no extra withTransaction needed. Direct-call harness paths (unit
    // tests that call createResolver without the engine) bypass this and
    // run write + allocate + bind as independent awaits; those paths are
    // for unit coverage only and do not need atomicity.
    //
    // Allocation is shortId-specific by name today — if future engine-
    // allocated fields are added, duplicate this block for each one rather
    // than trying to generify on `readonly: true` alone (allocation strategy
    // differs per field).
    let finalRow: Row = storedRow;
    const shortIdDef = options.fields?.shortId;
    if (shortIdDef?.kind === 'scalar' && shortIdDef.readonly === true) {
      const shortId = await ds.allocateShortId(typeName);
      await ds.bindShortId(typeName, shortId, String(storedRow.id));
      finalRow = { ...storedRow, shortId };
    }

    // §5.4 subscription hook — announce the committed row. The engine batches
    // these during `withTransaction` and fans out only on tx commit.
    args.onWrite?.({
      ns: ds.namespace,
      type: typeName,
      id: finalRow.id,
      operation: 'create',
      row: finalRow
    });
    return finalRow as T;
  };
}
