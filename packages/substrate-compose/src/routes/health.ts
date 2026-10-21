/**
 * GET /health — unauthenticated liveness probe.
 *
 * Returns 200 + `{ status: 'ok', version, uptimeSeconds }` unconditionally
 * when the server is up. Probes and load balancers just need a 200 — the body
 * is a small diagnostic for humans running `curl /health` from the terminal.
 *
 * Deliberately shallow: this endpoint does NOT ping the dataset. If the server
 * process is running, the Fastify event loop is alive, and probes should get
 * an immediate 200. Readiness (dataset reachable, migrations applied) is a
 * separate concern.
 *
 * No auth: probes shouldn't need tokens, and version + uptime are meant to be
 * public.
 */

import type { HttpHandler } from '@mnmal-ai/substrate-types';
import { jsonResponse } from './helpers.js';

export interface HealthDeps {
  version: string;
  /** `Date.now()` timestamp at server start. Set once in compose(). */
  startedAt: number;
}

export function healthRoute(deps: HealthDeps): HttpHandler {
  return async () =>
    jsonResponse(200, {
      status: 'ok',
      version: deps.version,
      uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000)
    });
}
