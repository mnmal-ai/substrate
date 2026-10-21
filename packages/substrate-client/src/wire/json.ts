/**
 * JSON wire decode path. JSON envelopes are pure passthrough — the server
 * already expanded positional tuples into named objects before serialising to
 * JSON. The envelope is checked for a `schemaVersion` and returned unchanged.
 */

import type { PackEnvelope } from '@mnmal-ai/substrate-types';

export { decodePackEnvelope, isPackMarker, type PackMarker } from './pack.js';

export function decodeJsonEnvelope(env: PackEnvelope): PackEnvelope {
  if (typeof env.schemaVersion !== 'string') {
    throw new Error('Malformed envelope: missing schemaVersion');
  }
  return env;
}
