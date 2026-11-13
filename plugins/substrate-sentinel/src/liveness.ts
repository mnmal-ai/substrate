/**
 * The sentinel's open peers and the heartbeat that keeps them honest.
 *
 * The registry tracks every open frame-stream response in one of two sets:
 * `coordinators` (registered instances) or `watchers` (agents tailing the
 * topology). A peer is online for exactly as long as its response is open, so
 * there is nothing to age out: closing the response runs the route's close
 * path, which marks a coordinator offline.
 *
 * The plugin's `ScheduledTask` calls `runLivenessTick`, which writes a
 * zero-length heartbeat frame to every peer. That keeps idle proxies from
 * reaping the connection, and a write to a dead socket surfaces as the
 * response closing.
 */

/** A registered or watching peer: one open frame-stream response. */
export interface PeerConnection {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  heartbeat(): void;
}

/** Per-coordinator metadata captured on `register`. */
export interface CoordinatorConnection {
  name: string;
  coordinatorId: string;
  url: string;
}

export interface LivenessRegistry {
  /**
   * Register a newly-online coordinator. Replaces any prior entry for the same
   * conn, and drops and closes any other conn registered for the same row.
   */
  addCoordinator(conn: PeerConnection, meta: CoordinatorConnection): void;
  /** Remove a coordinator (on close). Returns its metadata if it was present. */
  removeCoordinator(conn: PeerConnection): CoordinatorConnection | undefined;
  /** Register a conn as a topology watcher. Idempotent. */
  addWatcher(conn: PeerConnection): void;
  /** Drop a watcher (on close). */
  removeWatcher(conn: PeerConnection): void;
  /** Fan out a JSON event to every watcher. Silently drops on send errors. */
  broadcastEvent(event: Record<string, unknown>): void;
  /** Introspection for tests and the close handler. */
  coordinators(): Array<{ conn: PeerConnection; meta: CoordinatorConnection }>;
  /** Introspection for tests. */
  watchers(): Array<PeerConnection>;
}

export function createLivenessRegistry(): LivenessRegistry {
  const coords = new Map<PeerConnection, CoordinatorConnection>();
  const watchers = new Set<PeerConnection>();

  return {
    addCoordinator(conn, meta): void {
      // A reconnect reuses the row, so the older stream must stop speaking for
      // it: otherwise its close marks the live coordinator offline.
      for (const [old, entry] of coords) {
        if (old === conn || entry.coordinatorId !== meta.coordinatorId) continue;
        coords.delete(old);
        try {
          old.close(4409, 'superseded by a newer registration');
        } catch {
          // Already closed.
        }
      }
      coords.set(conn, meta);
    },
    removeCoordinator(conn): CoordinatorConnection | undefined {
      const meta = coords.get(conn);
      coords.delete(conn);
      return meta;
    },
    addWatcher(conn): void {
      watchers.add(conn);
    },
    removeWatcher(conn): void {
      watchers.delete(conn);
    },
    broadcastEvent(event): void {
      const msg = JSON.stringify(event);
      for (const conn of watchers) {
        try {
          conn.send(msg);
        } catch {
          // Peer closed between ticks; drop silently.
        }
      }
    },
    coordinators(): Array<{ conn: PeerConnection; meta: CoordinatorConnection }> {
      return [...coords].map(([conn, meta]) => ({ conn, meta }));
    },
    watchers(): Array<PeerConnection> {
      return [...watchers];
    }
  };
}

/** Result snapshot returned from a tick. Metric payload shape. */
export interface LivenessTickResult {
  heartbeats: number;
}

/** Send every open peer a heartbeat frame. */
export function runLivenessTick(registry: LivenessRegistry): LivenessTickResult {
  let heartbeats = 0;
  for (const conn of [...registry.coordinators().map((e) => e.conn), ...registry.watchers()]) {
    try {
      conn.heartbeat();
      heartbeats++;
    } catch {
      // Peer gone between the snapshot and the write; its close path cleans up.
    }
  }
  return { heartbeats };
}
