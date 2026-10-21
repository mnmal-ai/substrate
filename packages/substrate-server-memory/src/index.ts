/**
 * @mnmal-ai/substrate-server-memory — in-process reference SubstrateServer.
 *
 * Zero runtime deps beyond @mnmal-ai/substrate-types. No socket, no TCP, no port.
 * Integration tests call `server.inject(req)` and receive a `SubstrateResponse`.
 */

export {
  AlreadyStartedError,
  MemorySubstrateServer,
  UnknownWsPathError
} from './memory-server.js';
export {
  createMemoryWsPair,
  type MemoryWsClient,
  WsClosedError
} from './memory-ws-connection.js';
export { matchRoute } from './route-matcher.js';
