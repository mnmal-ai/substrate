/**
 * Liveness bookkeeping for the sentinel's frame-stream peers.
 *
 * This module maintains an application-level liveness protocol over JSON
 * frames for peers that are not `selfLive`:
 *
 *   - The registry tracks every live socket in one of two sets: `coordinators`
 *     (registered HDS instances) or `watchers` (agents tailing topology).
 *   - Each tracked socket records when it was last heard from (`lastSeenMs`),
 *     set on add and refreshed by `markAlive()` on any inbound frame.
 *   - A tick (driven by the plugin's `ScheduledTask`) calls `drainStale`, which
 *     returns every non-`selfLive` socket whose last heartbeat is older than
 *     `staleThresholdMs`, then pings (or heartbeats) the survivors.
 *   - A stale coordinator is evicted: its connection is closed and the
 *     matching `Coordinator` row is updated to `status: 'offline'`. A stale
 *     watcher is dropped.
 *
 * Staleness is measured against a clock, not by counting ticks, so a late
 * scheduler tick or a slow pong cannot evict a peer early. The registry holds
 * no timers; the clock is injectable for tests.
 */

import type { EngineHandle } from '@mnmal-ai/substrate/sdk';
import { makeCtx } from '@mnmal-ai/substrate/sdk';

/**
 * A registered or watching peer. A `selfLive` peer (a frame-stream response) is
 * alive while its response is open and is never drained as stale; it gets
 * zero-length `heartbeat()` frames, which also surface a dead socket as a failed
 * write. Any other peer proves it is alive by answering pings.
 */
export interface PeerConnection {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  readonly selfLive?: boolean;
  heartbeat?(): void;
}

/** Per-coordinator metadata captured on `register`. */
export interface CoordinatorConnection {
  name: string;
  coordinatorId: string;
  url: string;
}

interface CoordinatorEntry {
  conn: PeerConnection;
  meta: CoordinatorConnection;
  lastSeenMs: number;
}

interface WatcherEntry {
  conn: PeerConnection;
  lastSeenMs: number;
}

export interface LivenessRegistryOptions {
  /** Max age of a socket's last heartbeat before it is drained as stale. */
  staleThresholdMs: number;
  /** Clock in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

export interface LivenessRegistry {
  /**
   * Register a newly-online coordinator. Replaces any prior entry for the same
   * conn, and drops and closes any other conn registered for the same row.
   */
  addCoordinator(conn: PeerConnection, meta: CoordinatorConnection): void;
  /** Remove a coordinator (on close or eviction). Returns its metadata if it was present. */
  removeCoordinator(conn: PeerConnection): CoordinatorConnection | undefined;
  /** Register a conn as a topology watcher. Idempotent. */
  addWatcher(conn: PeerConnection): void;
  /** Drop a watcher (on close). */
  removeWatcher(conn: PeerConnection): void;
  /** Record a heartbeat now for any tracked conn (coordinator or watcher). */
  markAlive(conn: PeerConnection): void;
  /** Fan out a JSON event to every watcher. Silently drops on send errors. */
  broadcastEvent(event: Record<string, unknown>): void;
  /**
   * Sweep-tick primitive: returns every tracked conn whose last heartbeat is
   * more than `staleThresholdMs` old. Does not remove them.
   */
  drainStale(): Array<PeerConnection>;
  /** Introspection for tests and the onClose handler. */
  coordinators(): Array<{ conn: PeerConnection; meta: CoordinatorConnection }>;
  /** Introspection for tests. */
  watchers(): Array<PeerConnection>;
}

export function createLivenessRegistry(opts: LivenessRegistryOptions): LivenessRegistry {
  const { staleThresholdMs } = opts;
  const now = opts.now ?? Date.now;
  const coords = new Map<PeerConnection, CoordinatorEntry>();
  const watchers = new Map<PeerConnection, WatcherEntry>();

  return {
    addCoordinator(conn, meta): void {
      // A reconnect reuses the row, so the older socket must stop speaking for
      // it: otherwise its close or eviction marks the live coordinator offline.
      for (const [old, entry] of coords) {
        if (old === conn || entry.meta.coordinatorId !== meta.coordinatorId) continue;
        coords.delete(old);
        try {
          old.close(4409, 'superseded by a newer registration');
        } catch {
          // Already closed.
        }
      }
      coords.set(conn, { conn, meta, lastSeenMs: now() });
    },
    removeCoordinator(conn): CoordinatorConnection | undefined {
      const entry = coords.get(conn);
      if (entry === undefined) return undefined;
      coords.delete(conn);
      return entry.meta;
    },
    addWatcher(conn): void {
      if (watchers.has(conn)) return;
      watchers.set(conn, { conn, lastSeenMs: now() });
    },
    removeWatcher(conn): void {
      watchers.delete(conn);
    },
    markAlive(conn): void {
      const at = now();
      const coord = coords.get(conn);
      if (coord !== undefined) coord.lastSeenMs = at;
      const watcher = watchers.get(conn);
      if (watcher !== undefined) watcher.lastSeenMs = at;
    },
    broadcastEvent(event): void {
      const msg = JSON.stringify(event);
      for (const entry of watchers.values()) {
        try {
          entry.conn.send(msg);
        } catch {
          // Peer socket may have closed between ticks; drop silently.
        }
      }
    },
    drainStale(): Array<PeerConnection> {
      const cutoff = now() - staleThresholdMs;
      const stale: Array<PeerConnection> = [];
      for (const entry of [...coords.values(), ...watchers.values()]) {
        if (entry.conn.selfLive !== true && entry.lastSeenMs < cutoff) stale.push(entry.conn);
      }
      return stale;
    },
    coordinators(): Array<{ conn: PeerConnection; meta: CoordinatorConnection }> {
      return [...coords.values()].map((e) => ({ conn: e.conn, meta: e.meta }));
    },
    watchers(): Array<PeerConnection> {
      return [...watchers.values()].map((e) => e.conn);
    }
  };
}

/** Result snapshot returned from a tick. Metric payload shape. */
export interface LivenessTickResult {
  stalePinged: number;
  markedOffline: number;
}

async function markCoordinatorOffline(
  engine: EngineHandle,
  namespace: string,
  coordinatorId: string
): Promise<void> {
  const key = `${namespace}/updateCoordinator`;
  await engine.mutate({
    frame: {
      [key]: {
        params: { id: coordinatorId, status: 'offline' },
        fields: { id: true, status: true }
      }
    },
    // No caller to attribute the write to, so the sweep names itself; an
    // internal writer with read+mutate, not admin.
    ctx: makeCtx(namespace, 'mutate', {
      kind: 'system',
      id: 'sentinel-liveness',
      grants: { '*': ['read', 'mutate'] }
    })
  });
}

/**
 * Drive one liveness cycle. Returns the number of sockets that were asked to
 * ping this tick, and the number of coordinators evicted (closed + row
 * flipped to offline).
 */
export async function runLivenessTick(
  registry: LivenessRegistry,
  engine: EngineHandle,
  namespace: string
): Promise<LivenessTickResult> {
  // Snapshot the coordinators before the drain so we can classify the stale
  // set into coordinators (evict + mark offline) vs watchers (drop).
  const coordByConn = new Map(registry.coordinators().map((entry) => [entry.conn, entry.meta]));
  const stale = registry.drainStale();

  let markedOffline = 0;
  for (const conn of stale) {
    const meta = coordByConn.get(conn);
    if (meta !== undefined) {
      // Stale coordinator → evict. Close first so `onClose` on the server side
      // has a chance to fire and the broadcast below can run without the
      // evicted coordinator receiving its own offline event.
      try {
        conn.close(4408, 'liveness timeout');
      } catch {
        // Already-closed sockets throw; ignore.
      }
      const removed = registry.removeCoordinator(conn);
      const coordId = removed?.coordinatorId ?? meta.coordinatorId;
      try {
        await markCoordinatorOffline(engine, namespace, coordId);
        markedOffline++;
        registry.broadcastEvent({ event: 'offline', name: meta.name, url: meta.url });
      } catch {
        // Engine faults must not break the tick loop — other coordinators still
        // need to be considered. The scheduler picks up the metric delta.
      }
    } else {
      // Stale watcher → drop without ceremony.
      registry.removeWatcher(conn);
      try {
        conn.close(4408, 'liveness timeout');
      } catch {
        // Ignore.
      }
    }
  }

  // Ping the survivors; a `pong` refreshes their heartbeat via `markAlive`.
  const pingMsg = JSON.stringify({ type: 'ping' });
  const survivors: Array<PeerConnection> = [];
  for (const entry of registry.coordinators()) survivors.push(entry.conn);
  for (const w of registry.watchers()) survivors.push(w);
  let stalePinged = 0;
  for (const conn of survivors) {
    try {
      if (conn.heartbeat !== undefined) conn.heartbeat();
      else conn.send(pingMsg);
      stalePinged++;
    } catch {
      // Peer gone between drain and send; next tick will catch it.
    }
  }

  return { stalePinged, markedOffline };
}
