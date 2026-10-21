/**
 * Per-client cap on long-lived connections — WS sockets and SSE streams draw
 * from one shared count, so a client cannot dodge it by switching transport.
 * Keyed by identity id when the caller authenticated, otherwise by client IP:
 * with auth off every caller shares the system identity, so the IP is the
 * only thing that tells clients apart. A caller with neither is not capped,
 * since one shared bucket would let any client exhaust it for all of them.
 *
 * IPv6 clients are keyed by their /64 (see `ipCapKey`).
 *
 * The client IP is the peer address unless the peer is in
 * `SUBSTRATE_TRUSTED_PROXIES`: behind an untrusted proxy every anonymous
 * caller shares the proxy's address, and so one bucket.
 */

import type { Identity } from '@mnmal-ai/substrate-types';
import { ipCapKey } from './helpers.js';

/** Most WS sockets plus SSE streams one client may hold open at once. */
export const MAX_CONNECTIONS_PER_CLIENT = 64;

/**
 * Most subscribe/stream sessions one client may hold open at once, across
 * every WS socket and SSE stream. Each one is engine work on every write.
 */
export const MAX_SESSIONS_PER_CLIENT = 1024;

export interface ConnectionLimiter {
  /**
   * A release function, or `null` when the client is at its cap. Release is
   * idempotent. Pass `null` identity for anyone not individually
   * authenticated, the auth-off system actor included.
   */
  acquire(identity: Identity | null | undefined, clientIp: string | undefined): (() => void) | null;
}

export function createConnectionLimiter(max = MAX_CONNECTIONS_PER_CLIENT): ConnectionLimiter {
  const open = new Map<string, number>();
  return {
    acquire(identity, clientIp) {
      let key: string;
      if (identity !== null && identity !== undefined) key = `id:${identity.id}`;
      else if (clientIp !== undefined && clientIp !== '') key = `ip:${ipCapKey(clientIp)}`;
      else return () => {};
      const count = open.get(key) ?? 0;
      if (count >= max) return null;
      open.set(key, count + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (open.get(key) ?? 1) - 1;
        if (left <= 0) open.delete(key);
        else open.set(key, left);
      };
    }
  };
}
