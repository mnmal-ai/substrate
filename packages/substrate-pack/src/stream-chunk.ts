/**
 * `PackStreamChunk` codec. Spec: §7.4.
 *
 * A self-contained sub-envelope for one row in a stream. Each chunk carries:
 *   - `schemaVersion` — for drift detection against the caller's cached schema
 *   - `streamId`      — correlates chunks to the originating request (same id
 *                       the unified WS frame family uses, for symmetry across
 *                       transports)
 *   - `sequence`      — monotonic from 0, per-stream
 *   - `shape: 'single'` — chunks are always single rows (§7.4)
 *   - `data`          — positional encoding of the row via the client's sent
 *                       `FieldInput` + schema (same encoder the one-shot
 *                       envelope uses)
 *   - `final?`        — true on the last chunk (optional; alternative closure
 *                       is a dedicated terminal frame on the transport)
 *   - `_meta?`        — reserved envelope channel (§7.3)
 *
 * The §5.5 WebSocket route does NOT emit this envelope — WS streaming rides
 * on `WsResponseFrame` (kind: 'chunk'). This is the canonical codec for other
 * transports and standalone chunk decoding (§7.4, §2.5 protocol neutrality).
 */

import type { FieldInput, Schema } from '@mnmal-ai/substrate-types';
import { pack, unpack } from 'msgpackr';
import { decodePositional } from './decoder.js';
import { encodePositional } from './encoder.js';

/**
 * Per §7.4. `shape` is fixed to `'single'`; chunks never carry a list.
 */
export interface PackStreamChunk {
  schemaVersion: string;
  streamId: string;
  sequence: number;
  shape: 'single';
  data: unknown;
  final?: boolean;
  _meta?: Record<string, unknown>;
}

export interface EncodeStreamChunkInput {
  schemaVersion: string;
  streamId: string;
  sequence: number;
  /** Named-object row (the shape resolvers yield). */
  row: unknown;
  /** Selection tree as sent by the client; drives positional field ordering. */
  fields: FieldInput;
  /** Schema of the stream's owning namespace — matches `schemas[currentNs]`. */
  schema: Schema;
  /** Type name the stream resolver targets (e.g. `'Todo'`). */
  typeName: string;
  /** Owning namespace. Used for crossRef boundary detection in the encoder. */
  currentNs: string;
  /** Optional full federated schema map — required if the type has crossRefs. */
  schemas?: Record<string, Schema>;
  final?: boolean;
  meta?: Record<string, unknown>;
}

export interface DecodeStreamChunkInput {
  /** Selection tree used to encode — drives the same iteration order on decode. */
  fields: FieldInput;
  schema: Schema;
  typeName: string;
  currentNs: string;
  schemas?: Record<string, Schema>;
}

/**
 * Pack a chunk into a msgpack buffer. The row is positionally encoded first,
 * then the whole sub-envelope is serialised in one pass.
 */
export function encodeStreamChunk(input: EncodeStreamChunkInput): Buffer {
  const encoded = encodePositional(input.row, input.fields, input.schema, input.typeName, {
    currentNs: input.currentNs,
    ...(input.schemas !== undefined ? { schemas: input.schemas } : {})
  });
  const chunk: PackStreamChunk = {
    schemaVersion: input.schemaVersion,
    streamId: input.streamId,
    sequence: input.sequence,
    shape: 'single',
    data: encoded
  };
  if (input.final !== undefined) chunk.final = input.final;
  if (input.meta !== undefined) chunk._meta = input.meta;
  return Buffer.from(pack(chunk));
}

/**
 * Unpack a chunk and reconstruct the named-object row using the same selection
 * tree + schema the encoder saw. `schemaVersion`, `sequence`, `final`, and
 * `_meta` round-trip unchanged.
 */
export function decodeStreamChunk<T = unknown>(
  bytes: Buffer | Uint8Array,
  input: DecodeStreamChunkInput
): PackStreamChunk & { data: T } {
  const raw = unpack(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)) as PackStreamChunk;
  const decoded = decodePositional<T>(raw.data, input.fields, input.schema, input.typeName, {
    currentNs: input.currentNs,
    ...(input.schemas !== undefined ? { schemas: input.schemas } : {})
  });
  const out: PackStreamChunk & { data: T } = {
    schemaVersion: raw.schemaVersion,
    streamId: raw.streamId,
    sequence: raw.sequence,
    shape: 'single',
    data: decoded
  };
  if (raw.final !== undefined) out.final = raw.final;
  if (raw._meta !== undefined) out._meta = raw._meta;
  return out;
}
