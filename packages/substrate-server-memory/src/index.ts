/**
 * @mnmal-ai/substrate-server-memory — in-process reference SubstrateServer.
 *
 * Zero runtime deps beyond @mnmal-ai/substrate-types. No socket, no TCP, no port.
 * Integration tests call `server.inject(req)` and receive a `SubstrateResponse`.
 */

export { AlreadyStartedError, MemorySubstrateServer } from './memory-server.js';
export { matchRoute } from './route-matcher.js';
