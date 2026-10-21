/**
 * autoCRUD `purge<T>` resolver. Spec: §5.1 (`purge<T>({ id })` — optional
 * admin-only hard-delete), §4.5 (`purge` on nonexistent row returns
 * `{ deleted: 0 }` without error).
 *
 * Purge is hard-delete: it bypasses the `_deletedAt` tombstone lifecycle and
 * removes the row outright. Downstream edges observe the row as MISSING on
 * subsequent reads; the sweep's non-bridged MISSING branch treats this as
 * deleted and fans policy per §6.3.
 *
 * Admin gate: this resolver does NOT embed a capability check. The gate is a
 * `Policy` composed at install time — see `installAutoCrud(..., { purgeable: true })`
 * which attaches `requireCapability(adminCapability)` by default. Callers can
 * override with any policy.
 *
 * Kill switch: assertHardDeleteAllowed() is the first thing — refusal
 * short-circuits before any state read.
 */

import {
  assertHardDeleteAllowed,
  type Dataset,
  type Id,
  ResolverFrameError,
  type TypedResolver,
  type WriteEvent
} from '@mnmal-ai/substrate-types';
import { coerceId, rejectUnknownParams } from './internal.js';

const KNOWN_PURGE_PARAMS: ReadonlySet<string> = new Set(['id']);

export interface PurgeResolverResult {
  id: Id;
  purged: boolean;
  [field: string]: unknown;
}

export function purgeResolver(
  typeName: string,
  dataset: Dataset
): TypedResolver<PurgeResolverResult> {
  return async (_ctx, args) => {
    rejectUnknownParams('purge', typeName, args.params, KNOWN_PURGE_PARAMS);
    assertHardDeleteAllowed();
    const ds = args.dataset ?? dataset;
    const id = coerceId(args.params?.id);
    if (id === undefined) {
      throw new ResolverFrameError(
        'missing_id',
        `purgeResolver('${typeName}'): params.id is required`,
        { field: 'id' }
      );
    }

    // Capture pre-purge row state for the subscription bus. `includeDeleted`
    // covers the admin-purges-tombstoned-row path so the `remove` event fires
    // against the row's final body, not an empty shape.
    const { rows: existing } = await ds.read(typeName, { id, includeDeleted: true });
    const preRow = existing[0];

    const { deleted } = await ds.purge(typeName, [id]);
    const purged = deleted > 0;

    if (purged && args.onWrite !== undefined) {
      const event: WriteEvent = {
        ns: ds.namespace,
        type: typeName,
        id,
        operation: 'delete',
        ...(preRow !== undefined ? { row: preRow } : {})
      };
      args.onWrite(event);
    }

    return { id, purged };
  };
}
