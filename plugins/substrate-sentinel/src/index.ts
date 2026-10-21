/**
 * @mnmal-ai/substrate-sentinel — coordinator plugin that manages dynamic
 * discovery for Substrate coordinators (Coordinator, CoordinatorNamespace,
 * CoordinatorBridge rows) plus a persistent WS surface for registration and
 * topology watching.
 *
 * Coordinator plugin seam (§5.11):
 *   - `namespaces[0]` — the 3-type autoCRUD surface (see `./namespace.ts`).
 *   - `routes` — `/status` (health dashboard read) and `/ws` (registration +
 *     watcher heartbeat).
 *   - `schedule` — a single `<ns>-liveness` task runs every
 *     `pingIntervalMs` (default 30s), pings every socket, and evicts
 *     coordinators whose last heartbeat is older than `staleThresholdMs`.
 *
 * `createSentinelPlugin` is a pure factory taking a fully-resolved
 * `SentinelPluginConfig`. The structured-config `bootstrap` is the canonical
 * entry. Direct programmatic callers (tests, embedded
 * harnesses) build a full config and call `createSentinelPlugin(config)`.
 */

import type { CoordinatorPlugin } from '@mnmal-ai/substrate/sdk';
import type { SentinelPluginConfig } from './config.js';
import { createLivenessRegistry, runLivenessTick } from './liveness.js';
import { buildSentinelNamespace } from './namespace.js';
import { registerSentinelStatusRoute } from './status-route.js';
import { registerSentinelWsRoute } from './ws-route.js';

export type { SentinelPluginConfig } from './config.js';
export {
  type CoordinatorConnection,
  createLivenessRegistry,
  type LivenessRegistry,
  type LivenessRegistryOptions,
  type LivenessTickResult,
  runLivenessTick
} from './liveness.js';
export { buildSentinelNamespace, SENTINEL_TYPE_NAMES } from './namespace.js';
export { type CoordinatorRecord, registerSentinelStatusRoute } from './status-route.js';
export { registerSentinelWsRoute } from './ws-route.js';

export function createSentinelPlugin(cfg: SentinelPluginConfig): CoordinatorPlugin {
  const registry = createLivenessRegistry({ staleThresholdMs: cfg.staleThresholdMs });

  return {
    name: 'substrate-sentinel',
    contractVersion: '>=1.0.0-alpha.0 <2.0.0',
    namespaces: [buildSentinelNamespace(cfg.namespace)],
    schedule: [
      {
        name: `${cfg.namespace}-liveness`,
        intervalMs: cfg.pingIntervalMs,
        runOnStart: false,
        handler: async (taskCtx): Promise<void> => {
          const result = await runLivenessTick(registry, taskCtx.engine, cfg.namespace);
          taskCtx.metric('sentinel_liveness_tick', result);
        }
      }
    ],
    routes: (router, routeCtx): void => {
      registerSentinelStatusRoute(router, routeCtx, cfg.namespace);
      registerSentinelWsRoute(router, routeCtx, cfg.namespace, registry);
    }
  };
}
