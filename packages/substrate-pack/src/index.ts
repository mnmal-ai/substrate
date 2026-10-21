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
 *     request's selection, and the WS decode plan for pack subscriptions.
 */

// Re-export msgpackr's frame-level codec so WS route layers can pack/unpack
// substrate-pack-negotiated frames without taking a direct msgpackr dependency.
// The wire format — including subscription/stream frames (§8.5) — flows
// through the same codec the envelope uses.
export { pack as packFrame, unpack as unpackFrame } from 'msgpackr';
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
  PackEncodeError
} from './encoder.js';
export {
  type DecodeStreamChunkInput,
  decodeStreamChunk,
  type EncodeStreamChunkInput,
  encodeStreamChunk,
  type PackStreamChunk
} from './stream-chunk.js';
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

/**
 * WebSocket subprotocol advertised in `Sec-WebSocket-Protocol` at handshake
 * time. Connections negotiating this subprotocol receive msgpack frames with
 * positionally-encoded `data`; anything else falls back to JSON.
 */
export const WS_SUBPROTOCOL_SUBSTRATE_PACK = 'substrate-pack';
