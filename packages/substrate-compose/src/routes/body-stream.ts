/**
 * A query body large enough to hold the event loop is built and sent a batch
 * of rows at a time, with a macrotask yield between batches: the same bytes
 * as the unstreamed body, JSON or substrate-pack.
 */

import {
  type EncodeEnvelopeCtx,
  packEnvelopeParts,
  positionValue,
  withData
} from '@mnmal-ai/substrate-pack';
import { type PackEnvelope, stringifyJson } from '@mnmal-ai/substrate-types';
import type { Frame } from './helpers.js';
import { projectionFields, projectValue } from './project-json.js';

/** A body streams once one `data` key holds more rows than this. */
export const STREAM_ROWS = 20_000;

/** Rows projected and serialised per chunk (a few ms of work). */
const ROWS_PER_CHUNK = 2_000;

/** True when some `data` value is a row list longer than `STREAM_ROWS`. */
export function streamsRows(envelope: PackEnvelope): boolean {
  return Object.values(envelope.data).some((v) => Array.isArray(v) && v.length > STREAM_ROWS);
}

export function jsonEnvelopeStream(
  envelope: PackEnvelope,
  frame: Frame
): ReadableStream<Uint8Array> {
  return partsStream(jsonParts(envelope, frame));
}

/**
 * The substrate-pack body as a stream. Rows are positioned up front, a batch
 * at a time, so an encode error still fails the request before any byte is sent.
 */
export async function packEnvelopeStream(
  envelope: PackEnvelope,
  ctx: EncodeEnvelopeCtx
): Promise<ReadableStream<Uint8Array>> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(envelope.data)) {
    // Only a `list` is row-wise; a batched mutate's array is one slot per frame.
    if (envelope.shapes[key] !== 'list' || !Array.isArray(value)) {
      data[key] = positionValue(envelope, ctx, key);
      continue;
    }
    const rows: unknown[] = [];
    for (let i = 0; i < value.length; i += ROWS_PER_CHUNK) {
      if (i > 0) await nextTurn();
      const part = positionValue(envelope, ctx, key, value.slice(i, i + ROWS_PER_CHUNK));
      for (const r of part as unknown[]) rows.push(r);
    }
    data[key] = rows;
  }
  return partsStream(packEnvelopeParts(withData(envelope, data), ROWS_PER_CHUNK));
}

function partsStream(parts: Iterator<string | Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // A pull can follow the last one in the same microtask chain; yield so other work runs.
      await nextTurn();
      const next = parts.next();
      if (next.done) controller.close();
      else
        controller.enqueue(
          typeof next.value === 'string' ? encoder.encode(next.value) : next.value
        );
    }
  });
}

function nextTurn(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** `JSON.stringify(projectEnvelope(envelope, frame))` in pieces, a long row list `ROWS_PER_CHUNK` rows per piece. */
export function* jsonParts(envelope: PackEnvelope, frame: Frame): Generator<string> {
  yield '{';
  let sep = '';
  for (const [k, v] of Object.entries(envelope)) {
    if (k !== 'data') {
      const s = stringifyJson(v);
      if (s === undefined) continue;
      yield `${sep}${JSON.stringify(k)}:${s}`;
      sep = ',';
      continue;
    }
    yield `${sep}"data":{`;
    sep = ',';
    let dsep = '';
    for (const [key, value] of Object.entries(envelope.data)) {
      const fields = projectionFields(envelope, frame, key);
      const project = (x: unknown): unknown => (fields === undefined ? x : projectValue(x, fields));
      if (!Array.isArray(value) || value.length <= ROWS_PER_CHUNK) {
        const s = stringifyJson(project(value));
        if (s === undefined) continue;
        yield `${dsep}${JSON.stringify(key)}:${s}`;
        dsep = ',';
        continue;
      }
      yield `${dsep}${JSON.stringify(key)}:[`;
      dsep = ',';
      for (let i = 0; i < value.length; i += ROWS_PER_CHUNK) {
        const rows = value
          .slice(i, i + ROWS_PER_CHUNK)
          .map((r) => stringifyJson(project(r)) ?? 'null');
        yield `${i === 0 ? '' : ','}${rows.join(',')}`;
      }
      yield ']';
    }
    yield '}';
  }
  yield '}';
}
