/**
 * autoCRUD `get<T>` resolver. Spec: §5.1.
 *
 * Requires `params.id`. Returns the matching row or null. Missing id surfaces
 * as a thrown `ResolverFrameError('missing_id', …)` — policy is a separate
 * concern; a missing id is a programmer/client bug, not an authz event. The
 * engine projects the frame error's code into `envelope.errors` so the client
 * gets a clean validation error rather than internal_error / HTTP 500.
 *
 * The `id` param may be a UUID/legacy id OR a numeric short-form id (e.g.
 * "1"). `resolveEntityId` tries the raw id first (common path, one lookup)
 * and falls back to the sidecar if the input looks like a short-form integer.
 * A null result means not found — the resolver returns null.
 */

import type {
  Dataset,
  FieldInput,
  ReadParams,
  Row,
  TypedResolver
} from '@mnmal-ai/substrate-types';
import { ResolverFrameError } from '@mnmal-ai/substrate-types';
import { resolveEntityId } from '../short-id-resolver.js';
import { coerceId, rejectUnknownParams } from './internal.js';

const KNOWN_GET_PARAMS: ReadonlySet<string> = new Set(['id']);

export function getResolver<T extends Row = Row>(
  typeName: string,
  dataset: Dataset
): TypedResolver<T | null> {
  return async (_ctx, args) => {
    rejectUnknownParams('get', typeName, args.params, KNOWN_GET_PARAMS);
    // Prefer the engine-supplied handle (tx view on mutate-path gets-after-writes).
    const ds = args.dataset ?? dataset;
    const id = coerceId(args.params?.id);
    if (id === undefined) {
      throw new ResolverFrameError(
        'missing_id',
        `getResolver('${typeName}'): params.id is required`,
        { field: 'id' }
      );
    }
    const rowId = await resolveEntityId(ds, typeName, id);
    if (rowId === null) return null;
    // Forward the caller's field selection so substrates can narrow the
    // body keys materialised from storage. Substrates MAY ignore — memory
    // dataset has no wire to save.
    const readParams: ReadParams = { id: rowId };
    const fields = args.fields as FieldInput | undefined;
    if (fields !== undefined) readParams.fields = fields;
    const { rows } = await ds.read(typeName, readParams);
    return (rows[0] as T | undefined) ?? null;
  };
}
