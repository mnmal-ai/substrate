/**
 * Recall route barrel — the surface lives in `./recall/`:
 *
 *   `./recall/types.js` — policy probes, input/output shapes, salience
 *     config, dependency bags
 *   `./recall/handler.js` — `handleRecallRequest`, the transport-agnostic
 *     recall core shared by the HTTP route, the frame surface and the MCP tool
 *   `./recall/route.js` — `POST /substrate/v1/recall` HTTP transport
 *
 * The dense arm is optional: with no embedder the route still answers from the
 * lexical arm, and refuses only when no arm can run.
 */

export { handleRecallRequest } from './recall/handler.js';
export { type RecallRouteConfig, recallRouteHandler } from './recall/route.js';
export {
  bindPolicy,
  DEFAULT_SALIENCE_CONFIG,
  type ExpansionResolver,
  type ReadPolicyCheck,
  type RecallDeps,
  type RecallInput,
  type RecallOutput,
  type RecallRow,
  type RecallTimings,
  type SalienceConfig,
  type SpreadResolver,
  type WritePolicyCheck
} from './recall/types.js';
