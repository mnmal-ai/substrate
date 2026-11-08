/**
 * A JSON query body large enough to hold the event loop is streamed: the same
 * bytes `JSON.stringify(projectEnvelope(envelope, frame))` gives, built and
 * sent a batch of rows at a time with a macrotask yield between batches.
 */

import type { PackEnvelope } from '@mnmal-ai/substrate-types';
import type { Frame } from './helpers.js';
import { projectionFields, projectValue } from './project-json.js';

/** A JSON body streams once one `data` key holds more rows than this. */
export const STREAM_JSON_ROWS = 20_000;

/** Rows projected and serialised per chunk (a few ms of work). */
const ROWS_PER_CHUNK = 2_000;

/** True when some `data` value is a row list longer than `STREAM_JSON_ROWS`. */
export function streamsJson(envelope: PackEnvelope): boolean {
  return Object.values(envelope.data).some((v) => Array.isArray(v) && v.length > STREAM_JSON_ROWS);
}

export function jsonEnvelopeStream(
  envelope: PackEnvelope,
  frame: Frame
): ReadableStream<Uint8Array> {
  const parts = jsonParts(envelope, frame);
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      // A pull can follow the last one in the same microtask chain; yield so other work runs.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const next = parts.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    }
  });
}

/** `JSON.stringify(projectEnvelope(envelope, frame))` in pieces, a long row list `ROWS_PER_CHUNK` rows per piece. */
export function* jsonParts(envelope: PackEnvelope, frame: Frame): Generator<string> {
  yield '{';
  let sep = '';
  for (const [k, v] of Object.entries(envelope)) {
    if (k !== 'data') {
      const s = JSON.stringify(v);
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
        const s = JSON.stringify(project(value));
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
          .map((r) => JSON.stringify(project(r)) ?? 'null');
        yield `${i === 0 ? '' : ','}${rows.join(',')}`;
      }
      yield ']';
    }
    yield '}';
  }
  yield '}';
}
