/**
 * Status route — `GET /plugins/substrate-sentinel/status`.
 *
 * Reads the current Coordinator set from the configured namespace and returns
 * it as `{ coordinators: CoordinatorRecord[] }`, under the caller's grant and
 * row policy. Engine faults and refusals yield an empty
 * list (dashboards rely on a 200 JSON shape) plus a `sentinel_status_error`
 * metric.
 */

import type {
  EngineHandle,
  Identity,
  PluginRouteContext,
  PluginRouter,
  SubstrateResponse
} from '@mnmal-ai/substrate/sdk';
import { jsonResponse, queryAll } from '@mnmal-ai/substrate/sdk';

export interface CoordinatorRecord {
  id: number | string;
  name: string;
  url: string;
  namespaces: string;
  status: string;
  lastHeartbeat: string;
  registeredAt: string;
  version: string;
}

const COORDINATOR_FIELDS: Record<string, true> = {
  id: true,
  name: true,
  url: true,
  namespaces: true,
  status: true,
  lastHeartbeat: true,
  registeredAt: true,
  version: true
};

async function listCoordinators(
  engine: EngineHandle,
  namespace: string,
  identity: Identity | null
): Promise<Array<CoordinatorRecord>> {
  return queryAll<CoordinatorRecord>(
    engine,
    namespace,
    'Coordinator',
    {},
    COORDINATOR_FIELDS,
    identity
  );
}

export function registerSentinelStatusRoute(
  router: PluginRouter,
  ctx: PluginRouteContext,
  namespace: string
): void {
  router.get('/status', async (req): Promise<SubstrateResponse> => {
    try {
      // As the caller: the route gate only checked `read` in SOME namespace.
      const coordinators = await listCoordinators(ctx.engine, namespace, req.identity ?? null);
      return jsonResponse(200, { coordinators });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.metric('sentinel_status_error', { error: message });
      return jsonResponse(200, { coordinators: [] });
    }
  });
}
