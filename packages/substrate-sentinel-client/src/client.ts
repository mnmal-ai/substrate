/**
 * substrate-sentinel-client — watches a sentinel instance's topology feed and
 * mutates a caller-owned BridgeRegistry on online/offline events.
 *
 *   - GET <sentinel>/substrate/v1/plugins/substrate-sentinel/watch, a stream of
 *     length-prefixed JSON frames
 *   - on {event:'online'}: create HttpBridgeClient, register in bridges,
 *     call engine.refreshBridgeSchemas()
 *   - on {event:'offline'}: unregister bridge + dispose client
 *   - on a refusal or a dropped stream: reconnect with exponential backoff,
 *     reset only after a stream that lasted `reconnectMaxMs`
 *   - stop(): ends the stream + disposes all active bridges
 */

import { HttpBridgeClient } from '@mnmal-ai/substrate-bridge-http';
import { type FetchLike, substrateFetch } from '@mnmal-ai/substrate-client';
import { decodeStreamFrames, FRAMES_JSON_MIME } from '@mnmal-ai/substrate-pack';
import { makeAuthorizationProvider } from '@mnmal-ai/substrate-policy';
import {
  type BridgeClient,
  type BridgeCredentialStore,
  type BridgeRegistry,
  trimTrailingSlashes
} from '@mnmal-ai/substrate-types';

const WATCH_PATH = '/substrate/v1/plugins/substrate-sentinel/watch';

/**
 * Extension of the read-only `BridgeRegistry` from substrate-types with the
 * mutating methods the sentinel client needs. `MemoryBridgeRegistry` from
 * substrate-core satisfies this structurally.
 */
export interface WritableBridgeRegistry extends BridgeRegistry {
  register(ns: string, client: BridgeClient): void;
  unregister(ns: string): void;
}

/**
 * Narrow DI surface for the engine. The concrete `Engine` satisfies
 * this structurally; tests use a lightweight spy.
 */
export interface SentinelClientEngineHandle {
  refreshBridgeSchemas(): Promise<void>;
  /** Defined for a namespace this server hosts, which a bridge must never claim. */
  registryFor(ns: string): unknown;
}

export type MetricSink = (name: string, payload?: unknown) => void;

export interface StartSentinelClientOpts {
  /** The sentinel's http:// or https:// base URL, e.g. `https://sentinel.example:3100`. */
  sentinelUrl: string;
  /** Caller-owned bridge registry; the client mutates it in place. */
  bridges: WritableBridgeRegistry;
  /** Engine handle with `refreshBridgeSchemas()` — called after each register. */
  engine: SentinelClientEngineHandle;
  /**
   * Federation allowlist. A coordinator with no provisioned credential is
   * ignored entirely — discovery supplies a URL, never authority. Required:
   * an absent store would mean accept-anything.
   */
  creds: BridgeCredentialStore;
  /** Fire-and-forget metric sink. Defaults to a no-op. */
  metric?: MetricSink;
  /** Initial reconnect delay in ms. Default 500. */
  reconnectBaseMs?: number;
  /** Reconnect delay cap in ms. Default 30_000. */
  reconnectMaxMs?: number;
  /**
   * Supplies the full `Authorization` header value (e.g. `Bearer <jwt>`) for
   * the watch request, called on each connect. Required against any
   * auth-enabled sentinel, which answers an unsigned watch with 401. Omitted
   * only for a sentinel with no auth configured.
   */
  auth?: () => string;
  /** The fetch the watch request goes through — test seam. Defaults to `substrateFetch`. */
  fetch?: FetchLike;
}

export interface SentinelClientHandle {
  stop(): Promise<void>;
  isConnected(): boolean;
}

const NO_OP_METRIC: MetricSink = () => {};

export function startSentinelClient(opts: StartSentinelClientOpts): SentinelClientHandle {
  const metric = opts.metric ?? NO_OP_METRIC;
  // `watchAuth`, not `auth`: this is the credential for OUR request to the
  // sentinel. `handleOnline` separately mints a per-bridge token for each
  // discovered peer — two different principals, and shadowing one with the
  // other would be an easy way to send the wrong credential somewhere.
  const watchAuth = opts.auth;
  const fetchImpl = opts.fetch ?? substrateFetch;
  const watchUrl = `${trimTrailingSlashes(opts.sentinelUrl)}${WATCH_PATH}`;
  const baseMs = opts.reconnectBaseMs ?? 500;
  const maxMs = opts.reconnectMaxMs ?? 30_000;

  const ownedBridges = new Map<string, HttpBridgeClient>();
  const ctrl = new AbortController();
  let stopped = false;
  let connected = false;
  let currentBackoff = baseMs;

  /** Resolves after `ms`, or at once when stopped. The timer never holds the process open. */
  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref();
      function done(): void {
        clearTimeout(timer);
        ctrl.signal.removeEventListener('abort', done);
        resolve();
      }
      ctrl.signal.addEventListener('abort', done, { once: true });
    });
  }

  /** One watch request, read to its end. */
  async function watchOnce(): Promise<void> {
    const headers: Record<string, string> = { accept: FRAMES_JSON_MIME };
    if (watchAuth !== undefined) headers.authorization = watchAuth();
    const res = await fetchImpl(watchUrl, { method: 'GET', headers, signal: ctrl.signal });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || res.body === null || !type.startsWith(FRAMES_JSON_MIME)) {
      await res.body?.cancel();
      // A 401/403 is the only signal that topology is not being watched.
      metric('sentinel_client_error', {
        status: res.status,
        error: `watch answered ${res.status} ${type}`
      });
      return;
    }
    const openedAt = Date.now();
    connected = true;
    metric('sentinel_client_connected');
    try {
      const utf8 = new TextDecoder();
      for await (const payload of decodeStreamFrames(res.body)) {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(utf8.decode(payload)) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (frame.event === 'online') void handleOnline(frame);
        else if (frame.event === 'offline') handleOffline(frame);
      }
    } finally {
      connected = false;
      // A stream that dropped soon after opening proves nothing, so the delay keeps growing.
      if (Date.now() - openedAt >= maxMs) currentBackoff = baseMs;
    }
  }

  async function run(): Promise<void> {
    while (!stopped) {
      try {
        await watchOnce();
      } catch {
        // A refused connect or a broken stream: both reconnect below.
      }
      if (stopped) return;
      metric('sentinel_client_disconnected');
      const delay = currentBackoff;
      metric('sentinel_client_reconnecting', { delayMs: delay });
      currentBackoff = Math.min(currentBackoff * 2, maxMs);
      await pause(delay);
    }
  }

  async function handleOnline(frame: Record<string, unknown>): Promise<void> {
    const name = typeof frame.name === 'string' ? frame.name : undefined;
    const url = typeof frame.url === 'string' ? frame.url : undefined;
    const namespaces = Array.isArray(frame.namespaces) ? frame.namespaces : [];
    // An unnamed coordinator cannot be matched against the allowlist, so it
    // cannot be trusted.
    if (name === undefined || url === undefined) return;

    const cred = opts.creds.get(name);
    if (cred === undefined) {
      metric('bridge_discovery_rejected', { name, url });
      return; // BEFORE any client construction or refreshBridgeSchemas()
    }
    // The credential is bound to an origin. Without this check a provisioned
    // NAME could redirect a signed bearer (minted per-credential, not
    // per-destination, so replayable) to an attacker's host. Rejected before
    // any client exists, so before any outbound request.
    let advertisedOrigin: string;
    try {
      advertisedOrigin = new URL(url).origin;
    } catch {
      metric('bridge_discovery_origin_mismatch', { name, url, expected: cred.origin });
      return;
    }
    if (advertisedOrigin !== cred.origin) {
      metric('bridge_discovery_origin_mismatch', { name, url, expected: cred.origin });
      return;
    }
    // `lazyKey`: this runs inside the socket message handler, where an
    // unreadable key would surface as an unhandled rejection.
    const auth = makeAuthorizationProvider(cred, { lazyKey: true, audience: cred.origin });

    for (const nsValue of namespaces) {
      if (stopped) return;
      if (typeof nsValue !== 'string' || nsValue.length === 0) continue;
      const ns = nsValue;
      if (opts.bridges.has(ns)) continue;
      if (opts.engine.registryFor(ns) !== undefined) {
        metric('bridge_discovery_local_namespace', { name, ns });
        continue;
      }
      // Named for the COORDINATOR, not the namespace: the client's `name` is
      // what lands in `_completeness.unreachable[]`, and a static bridge puts
      // a coordinator name there. One field, one meaning.
      const client = new HttpBridgeClient({ name, baseUrl: url, auth });
      opts.bridges.register(ns, client);
      ownedBridges.set(ns, client);
      metric('sentinel_client_online', { ns, url });
      try {
        await opts.engine.refreshBridgeSchemas();
      } catch {
        metric('sentinel_client_refresh_failed', { ns });
      }
      // Re-check after await — stop() may have fired during refresh. If so,
      // undo the registration we just made so stop()'s prior iteration didn't
      // miss cleaning this up.
      if (stopped) {
        try {
          opts.bridges.unregister(ns);
        } catch {
          /* tolerate */
        }
        client.dispose();
        ownedBridges.delete(ns);
        return;
      }
    }
  }

  function handleOffline(frame: Record<string, unknown>): void {
    // The sentinel offline broadcast carries { name, url } — no namespaces.
    // Drop only bridges built for that coordinator name AND url: a URL alone
    // could be advertised by anyone, and its offline would cut every peer
    // bridged to it.
    const name = typeof frame.name === 'string' ? frame.name : undefined;
    const raw = typeof frame.url === 'string' ? frame.url : undefined;
    if (name === undefined || raw === undefined) return;
    // HttpBridgeClient strips a trailing slash from baseUrl; match it the same way.
    const url = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    for (const [ns, client] of [...ownedBridges]) {
      if (client.baseUrl !== url || client.name !== name) continue;
      try {
        opts.bridges.unregister(ns);
      } catch {
        // Already gone — tolerate.
      }
      client.dispose();
      ownedBridges.delete(ns);
      metric('sentinel_client_offline', { ns });
    }
  }

  const running = run();

  return {
    isConnected: (): boolean => connected,
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      ctrl.abort();
      for (const [ns, client] of ownedBridges) {
        try {
          opts.bridges.unregister(ns);
        } catch {
          // Registry may have dropped it — tolerate.
        }
        client.dispose();
      }
      ownedBridges.clear();
      await running;
    }
  };
}
