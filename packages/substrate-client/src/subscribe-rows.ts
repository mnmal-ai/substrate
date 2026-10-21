/**
 * Pure subscribe-event → typed-row-set fold, shared by `SubstrateClient.watch` and
 * the cache store.
 *
 * The `data` envelope shape per event kind:
 *   - snapshot : data = { '<ns>/<Type>': Row[] }   — the full current set
 *   - add      : data = { '<ns>/<Type>': Row }      — one newly-matching row
 *   - update   : data = { '<ns>/<Type>': Row }      — one changed row (by id)
 *   - remove   : { removedId: string }              — no data envelope
 *   - end / error / chunk : no row change (terminal / streaming kinds)
 *
 * Rows are correlated by their `id` field (string-coerced), so any frame fed to
 * the fold must select `id` — `SubstrateClient.watch` injects it via
 * `augmentFramesWithId`. `add` appends (no de-dup) and ignores the query's
 * `orderBy`.
 */

import { SubscribeError } from './errors.js';
import type { SubscribeEvent } from './transport/ws.js';

function rowSlot(data: unknown, qualifiedKey: string): unknown {
  if (data === null || typeof data !== 'object') return undefined;
  return (data as Record<string, unknown>)[qualifiedKey];
}

function rowId(row: unknown): string {
  return String((row as { id?: unknown }).id);
}

/**
 * Fold one subscribe event into `current`, returning the next row list. Pure:
 * the caller owns terminal-kind delivery and the "select id" contract.
 *
 * Returns the SAME array reference when the event does not change the set (an
 * `update` whose row carries no `id`, or a non-row kind), so callers can cheaply
 * skip redundant writes / yields by identity.
 */
export function reduceSubscribeRows<T>(
  current: T[],
  qualifiedKey: string,
  event: SubscribeEvent
): T[] {
  switch (event.kind) {
    case 'snapshot': {
      const slot = rowSlot(event.data, qualifiedKey);
      if (Array.isArray(slot)) return [...(slot as T[])];
      return slot === undefined || slot === null ? [] : [slot as T];
    }
    case 'add':
      return [...current, rowSlot(event.data, qualifiedKey) as T];
    case 'update': {
      const row = rowSlot(event.data, qualifiedKey) as { id?: unknown } | undefined;
      if (row === undefined || row.id === undefined) return current;
      const targetId = String(row.id);
      return current.map((r) => (rowId(r) === targetId ? (row as T) : r));
    }
    case 'remove':
      return current.filter((r) => rowId(r) !== String(event.removedId));
    default:
      return current; // end / error / chunk — no row change
  }
}

/**
 * Fold a single-key subscription's event stream into a live row-set: yields the
 * current `T[]` after every snapshot / add / update / remove. Completes on `end`
 * (or when the source iterator completes); throws `SubscribeError` on an `error`
 * event — matching the raw `subscribe` contract, where the transport throws on
 * error frames.
 *
 * A delta that does not change the set (e.g. an `update` whose row has no id) is
 * not re-yielded. Cancellation: breaking the consuming `for await` (or calling
 * `.return()`) propagates to the source iterable's `return()` through the inner
 * `for await`, cancelling the underlying WS subscription.
 */
export async function* watchRows<T>(
  events: AsyncIterable<SubscribeEvent>,
  qualifiedKey: string
): AsyncGenerator<T[]> {
  let rows: T[] = [];
  for await (const event of events) {
    if (event.kind === 'end') return;
    if (event.kind === 'error') {
      const first = event.errors[0];
      throw new SubscribeError(first?.message ?? 'subscribe error', first?.code ?? 'unknown');
    }
    const next = reduceSubscribeRows(rows, qualifiedKey, event);
    if (next === rows) continue; // chunk / unrecognised / no-op delta
    rows = next;
    yield rows;
  }
}
