/**
 * @mnmal-ai/substrate-pack — binary wire codec. Spec: §7.
 *
 * Positional encoding + msgpack envelope serialisation for Substrate responses.
 * The encoder strips field names from the wire; the decoder reconstructs them
 * using the same `FieldInput` the client sent plus the schema cached at init.
 *
 * Consumers:
 *   - Server: routes call `encodeEnvelope` when the request advertises
 *     `Accept: application/vnd.substrate.pack`; JSON otherwise.
 *   - Client: `@mnmal-ai/substrate-client` calls `decodeEnvelope` with the
 *     request's selection, and the decode plan for pack subscriptions.
 */

export { acceptsPack, PACK_MIME } from './content-type.js';
export {
  type DecodeContext,
  type DecodeEnvelopeCtx,
  decodeEnvelope,
  decodePositional,
  decodePositionalFromFieldDef,
  PackDecodeError,
  SchemaDriftError
} from './decoder.js';
export {
  type EncodeContext,
  type EncodeEnvelopeCtx,
  encodeEnvelope,
  encodePositional,
  encodePositionalFromFieldDef,
  PackEncodeError,
  packEnvelopeParts,
  positionValue,
  withData
} from './encoder.js';
// Re-export msgpackr's frame-level codec so frame-stream route layers can pack/unpack
// substrate-pack-negotiated frames without taking a direct msgpackr dependency.
// The wire format — including subscription/stream frames (§8.5) — flows
// through the same codec the envelope uses.
export { pack as packFrame, unpack as unpackFrame } from './msgpackr.js';
export { MUTATION_ACK_FIELDS, mutationReturns } from './mutation-returns.js';
export {
  type DecodeStreamChunkInput,
  decodeStreamChunk,
  type EncodeStreamChunkInput,
  encodeStreamChunk,
  type PackStreamChunk
} from './stream-chunk.js';
export {
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_STREAM_IDLE_MS,
  decodeStreamFrames,
  encodeStreamFrame,
  FRAMES_JSON_MIME,
  FRAMES_PACK_MIME,
  FrameStreamError,
  type FrameStreamErrorCode,
  framesEncodingFromAccept,
  HEARTBEAT_FRAME,
  withIdleTimeout
} from './stream-frames.js';
export {
  applyDecodePlanInPlace,
  buildDecodePlan,
  type DecodePlanEntry,
  decodeWsEnvelope,
  encodeWsFrame,
  type FrameSpecEntry,
  isPlainRequestData,
  type WireMode
} from './wire.js';
