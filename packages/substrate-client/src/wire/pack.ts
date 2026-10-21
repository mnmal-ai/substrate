/**
 * substrate-pack marker helpers. `decodePackEnvelope` only msgpack-unpacks: `data`
 * values stay positional tuples. `SubstrateClient` does not use it — it decodes
 * the marker's bytes with substrate-pack's `decodeEnvelope` and the request context.
 */

import { unpackFrame } from '@mnmal-ai/substrate-pack';
import type { PackEnvelope } from '@mnmal-ai/substrate-types';

export interface PackMarker {
  __packBytes: Uint8Array;
}

export function isPackMarker(v: unknown): v is PackMarker {
  return typeof v === 'object' && v !== null && '__packBytes' in v;
}

/**
 * Deserialise a pack marker (or raw bytes) into the raw `PackEnvelope`
 * shape. The `data` values are still positional tuples — caller is responsible
 * for positional decoding once it has per-key field context.
 */
export function decodePackEnvelope(markerOrBytes: PackMarker | Uint8Array): PackEnvelope {
  const bytes = isPackMarker(markerOrBytes) ? markerOrBytes.__packBytes : markerOrBytes;
  return unpackFrame(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)) as PackEnvelope;
}
