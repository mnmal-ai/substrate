/**
 * substrate-sentinel-client config. Env-driven, narrow surface.
 *
 *   - SUBSTRATE_SENTINEL_URL                — ws:// or wss:// URL of the sentinel
 *                                         instance's WS endpoint. Empty / unset
 *                                         returns null (opt-in).
 *   - SUBSTRATE_SENTINEL_CREDENTIAL               — JSON { keyPath, kid } the client signs
 *                                         its WS upgrade with. REQUIRED whenever
 *                                         the URL is set.
 *   - SUBSTRATE_SENTINEL_RECONNECT_BASE_MS  — initial reconnect delay (default 500)
 *   - SUBSTRATE_SENTINEL_RECONNECT_MAX_MS   — backoff cap (default 30_000)
 */

import type { BridgeCredential } from '@mnmal-ai/substrate-types';
import { parsePositiveInt } from '@mnmal-ai/substrate-types';

/**
 * Signing half of a {@link BridgeCredential}. No `origin`: origin binding
 * exists to gate URLs arriving off the wire, and the sentinel URL is
 * operator-supplied config, not discovered.
 */
export type SentinelCredential = Pick<BridgeCredential, 'keyPath' | 'kid'>;

export interface SentinelClientConfig {
  url: string;
  cred: SentinelCredential;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
}

function parseCred(raw: string | undefined): SentinelCredential {
  // Fail-closed. Sentinel's `watch` and `register` are privileged, so a
  // credential-less client would be refused every frame while reporting
  // itself healthy.
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      'SUBSTRATE_SENTINEL_URL is set but SUBSTRATE_SENTINEL_CREDENTIAL is not — ' +
        'sentinel requires an authenticated client'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `SUBSTRATE_SENTINEL_CREDENTIAL: invalid JSON — ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('SUBSTRATE_SENTINEL_CREDENTIAL: must be a JSON object of { keyPath, kid }');
  }
  const e = parsed as Record<string, unknown>;
  if (typeof e.keyPath !== 'string' || e.keyPath.length === 0) {
    throw new Error("SUBSTRATE_SENTINEL_CREDENTIAL: missing string 'keyPath'");
  }
  if (typeof e.kid !== 'string' || e.kid.length === 0) {
    throw new Error("SUBSTRATE_SENTINEL_CREDENTIAL: missing string 'kid'");
  }
  return { keyPath: e.keyPath, kid: e.kid };
}

const DEFAULT_RECONNECT_BASE_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SentinelClientConfig | null {
  const rawUrl = env.SUBSTRATE_SENTINEL_URL;
  if (rawUrl === undefined || rawUrl.length === 0) return null;
  if (!rawUrl.startsWith('ws://') && !rawUrl.startsWith('wss://')) {
    throw new Error('SUBSTRATE_SENTINEL_URL must be a ws:// or wss:// URL');
  }
  return {
    url: rawUrl,
    cred: parseCred(env.SUBSTRATE_SENTINEL_CREDENTIAL),
    reconnectBaseMs: parsePositiveInt(
      env.SUBSTRATE_SENTINEL_RECONNECT_BASE_MS,
      'SUBSTRATE_SENTINEL_RECONNECT_BASE_MS',
      DEFAULT_RECONNECT_BASE_MS
    ),
    reconnectMaxMs: parsePositiveInt(
      env.SUBSTRATE_SENTINEL_RECONNECT_MAX_MS,
      'SUBSTRATE_SENTINEL_RECONNECT_MAX_MS',
      DEFAULT_RECONNECT_MAX_MS
    )
  };
}
