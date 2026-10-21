/**
 * Opaque cursor encoding. Spec: §5.2.
 *
 * Cursors are base64url-encoded JSON of `{ orderByValues, id }` — they may
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

/**
 * @internal — thrown by `decodeCursor` on malformed input. Re-exported so
 * consumers can catch it by class, but treated as package-private.
 */
export class CursorDecodeError extends Error {
  override readonly name = 'CursorDecodeError';
}

export interface CursorPayload {
  /**
   * Values of each orderBy field on the last row of the previous page, in
   * orderBy-clause order. Dates serialise via JSON (ISO string); the decoder
   * returns them as-is for the dataset to coerce.
   */
  orderByValues: unknown[];
  /** The final tie-breaker. Always present even when orderBy didn't ask for id. */
  id: Id;
}

export function encodeCursor(input: CursorPayload): string {
  const json = JSON.stringify(input);
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
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
  return { orderByValues: values, id };
}
