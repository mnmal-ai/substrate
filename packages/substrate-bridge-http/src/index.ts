/**
 * @mnmal-ai/substrate-bridge-http — `BridgeClient` HTTP implementation.
 *
 * Separate from substrate-core so deployment helpers (e.g.
 * @mnmal-ai/substrate-sentinel-client) don't carry the full engine as a runtime
 * dependency.
 *
 * The companion `BridgeUnreachableError` is thrown by this client and caught
 * by the engine + sweep — it lives in `@mnmal-ai/substrate-types` (alongside the
 * other pure-data error classes) so engine and clients share one declaration.
 */

export { HttpBridgeClient, type HttpBridgeClientOptions } from './http-bridge-client.js';
