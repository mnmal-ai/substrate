/**
 * Opaque cursor encoding. Spec: §5.2.
 *
 * Cursors are base64url-encoded JSON of `{ orderByValues, id, order }` — they may
 * travel in URLs (query strings, Location headers, copy-pasted from logs) and
 * '+' / '/' / '=' would need percent-escaping. base64url avoids that round-
 * trip hazard entirely.
 *
 * Encoding is server-built, server-consumed; callers never inspect the payload.
 * Client sends it back unchanged, server decodes, re-runs the query with
 * `orderBy-tuple > last-seen-tuple` (exclusive, so the next page starts
 * strictly after the cursor row).
 */

import type { Id } from '@mnmal-ai/substrate-types';
import { ResolverFrameError } from '@mnmal-ai/substrate-types';

/**
 * Thrown by `decodeCursor` on a malformed, unsigned (pre-order-signing) or
 * mismatched cursor. A `ResolverFrameError` coded `invalid_cursor`, so the
 * engine reports it as a per-frame refusal rather than failing the request.
 */
export class CursorDecodeError extends ResolverFrameError {
  override readonly name = 'CursorDecodeError';

  constructor(message: string, details: Record<string, unknown> = {}) {
    super('invalid_cursor', message, { field: 'cursor', ...details });
  }
}

/** The normalized orderBy a cursor pages, id tail included: `[[field, dir], …]`. */
export type CursorOrder = ReadonlyArray<readonly [string, 'asc' | 'desc']>;

export interface CursorPayload {
  /**
   * Values of each orderBy field on the last row of the previous page, in
   * orderBy-clause order. Dates serialise via JSON (ISO string); the decoder
   * returns them as-is for the dataset to coerce.
   */
  orderByValues: unknown[];
  /** The final tie-breaker. Always present even when orderBy didn't ask for id. */
  id: Id;
  /**
   * The effective order the cursor was issued under. `decodeCursor` refuses a
   * cursor replayed under any other: its values would pair with the wrong
   * fields and give a silently wrong page.
   */
  order: CursorOrder;
}

export function encodeCursor(input: CursorPayload): string {
  const json = JSON.stringify(input);
  return Buffer.from(json, 'utf8').toString('base64url');
}

const orderText = (order: CursorOrder): string => order.map(([f, d]) => `${f} ${d}`).join(', ');

/** Decodes a cursor and checks it was issued for `expected`, the read's normalized order. */
export function decodeCursor(cursor: string, expected: CursorOrder): CursorPayload {
  let json: string;
  try {
    json = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CursorDecodeError(`cursor is not valid base64url: ${reason}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new CursorDecodeError(`cursor payload is not valid JSON: ${reason}`);
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new CursorDecodeError('cursor payload is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  const values = obj.orderByValues;
  const id = obj.id;
  if (!Array.isArray(values)) {
    throw new CursorDecodeError("cursor payload missing 'orderByValues' array");
  }
  if (typeof id !== 'string' && typeof id !== 'number') {
    throw new CursorDecodeError("cursor payload missing 'id' (string | number)");
  }
  // Only orderable column values ever go in; anything else is forged and must
  // not reach the dataset's comparison builder.
  if (!values.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v))) {
    throw new CursorDecodeError("cursor 'orderByValues' must hold only scalar values");
  }
  const order = obj.order;
  if (
    !Array.isArray(order) ||
    !order.every(
      (p) =>
        Array.isArray(p) &&
        p.length === 2 &&
        typeof p[0] === 'string' &&
        (p[1] === 'asc' || p[1] === 'desc')
    )
  ) {
    throw new CursorDecodeError(
      "cursor carries no 'order' (issued before cursors recorded their order); restart paging without a cursor"
    );
  }
  const issued = order as CursorOrder;
  if (orderText(issued) !== orderText(expected)) {
    throw new CursorDecodeError(
      `cursor was issued for orderBy '${orderText(issued)}' but this read orders by '${orderText(expected)}'; restart paging without a cursor`,
      { issuedFor: orderText(issued), readOrder: orderText(expected) }
    );
  }
  return { orderByValues: values, id, order: issued };
}
