/**
 * substrate-sentinel-client — watches a sentinel instance's WS topology stream and
 * mutates a caller-owned BridgeRegistry on online/offline events.
 *
 *   - connect to sentinel WS, send {type:'watch'}
 *   - on {event:'online'}: create HttpBridgeClient, register in bridges,
 *     call engine.refreshBridgeSchemas()
 *   - on {event:'offline'}: unregister bridge + dispose client
 *   - on error/close: reconnect with exponential backoff
 *   - stop(): closes WS + disposes all active bridges
 */

import { HttpBridgeClient } from '@mnmal-ai/substrate-bridge-http';
import { makeAuthorizationProvider } from '@mnmal-ai/substrate-policy';
import type {
  BridgeClient,
  BridgeCredentialStore,
  BridgeRegistry
} from '@mnmal-ai/substrate-types';
import WebSocket from 'ws';

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
  /** Full ws:// or wss:// URL of the sentinel's `/substrate/v1/plugins/substrate-sentinel/ws`. */
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
   * the WS upgrade. Required in practice against any auth-enabled sentinel:
   * `watch` and `register` are privileged frames, so an unauthenticated client
   * connects and is then refused every frame. Omitted only for a sentinel with
   * no auth configured.
   */
  auth?: () => string;
  /**
   * WebSocket factory — test seam. Defaults to a socket carrying {@link auth}.
   * A caller supplying this owns the upgrade entirely, including headers.
   */
  wsFactory?: (url: string) => WebSocket;
}

export interface SentinelClientHandle {
  stop(): Promise<void>;
  isConnected(): boolean;
}

const NO_OP_METRIC: MetricSink = () => {};

export function startSentinelClient(opts: StartSentinelClientOpts): SentinelClientHandle {
  const metric = opts.metric ?? NO_OP_METRIC;
  // `upgradeAuth`, not `auth`: this is the credential for OUR connection to
  // the sentinel. `handleOnline` separately mints a per-bridge token for each
  // discovered peer — two different principals, and shadowing one with the
  // other would be an easy way to send the wrong credential somewhere.
  const upgradeAuth = opts.auth;
  const wsFactory =
    opts.wsFactory ??
    ((url: string) =>
      // exactOptionalPropertyTypes: pass no options object at all rather than
      // `{ headers: undefined }` when unauthenticated.
      upgradeAuth === undefined
        ? new WebSocket(url)
        : new WebSocket(url, { headers: { authorization: upgradeAuth() } }));
  const baseMs = opts.reconnectBaseMs ?? 500;
  const maxMs = opts.reconnectMaxMs ?? 30_000;

  const ownedBridges = new Map<string, HttpBridgeClient>();
  let ws: WebSocket | null = null;
  let stopped = false;
  let connected = false;
  let currentBackoff = baseMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleReconnect(): void {
    if (stopped) return;
    const delay = currentBackoff;
    metric('sentinel_client_reconnecting', { delayMs: delay });
    const timer = setTimeout(() => {
      reconnectTimer = null;
      if (stopped) return;
      currentBackoff = Math.min(currentBackoff * 2, maxMs);
      connect();
    }, delay);
    // Allow process exit while waiting — prevents hanging test harnesses.
    timer.unref();
    reconnectTimer = timer;
  }

  function connect(): void {
    if (stopped) return;
    const socket = wsFactory(opts.sentinelUrl);
    ws = socket;
    socket.once('open', () => {
      connected = true;
      currentBackoff = baseMs;
      metric('sentinel_client_connected');
      socket.send(JSON.stringify({ type: 'watch' }));
    });
    socket.on('message', (buf: Buffer) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
      } catch {
        return;
      }
      if (frame.event === 'online') {
        void handleOnline(frame);
      } else if (frame.event === 'offline') {
        handleOffline(frame);
      } else if (typeof frame.error === 'string') {
        // Sentinel refuses `watch` with `{error:'unauthorized'|'forbidden'}`
        // and leaves the socket open, so `isConnected()` stays true; the
        // metric is the only signal that topology is not being watched.
        metric('sentinel_client_error', { error: frame.error });
      }
    });
    socket.once('close', () => {
      connected = false;
      metric('sentinel_client_disconnected');
      scheduleReconnect();
    });
    socket.once('error', () => {
      // Error always precedes close; handled there.
    });
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

  connect();

  return {
    isConnected: (): boolean => connected,
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      for (const [ns, client] of ownedBridges) {
        try {
          opts.bridges.unregister(ns);
        } catch {
          // Registry may have dropped it — tolerate.
        }
        client.dispose();
      }
      ownedBridges.clear();
      if (ws !== null && ws.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => {
          ws?.once('close', () => resolve());
          ws?.close();
        });
      }
    }
  };
}
