/** Server response frames as the subscribe and stream iterables yield them. */

import { SubscribeError } from '../errors.js';
import type { ReconnectSchedulerOpts } from '../reconnect.js';

/** A server response frame, as WS or a frame stream delivers it. */
export interface FrameMessage {
  kind: string;
  data?: unknown;
  shapes?: Record<string, unknown>;
  removedId?: string;
  errors?: Array<{ message: string; code?: string; path?: string[] }>;
  final?: boolean;
  sequence?: number;
  reason?: string;
}

export interface WsOverloadResubscribeOpts {
  /** Master switch. Default true. `false` restores terminal-on-overload. */
  enabled?: boolean;
  /** Retry budget per overload streak. Default 3. */
  maxAttempts?: number;
  /** Exponential backoff between retries. Defaults mirror reconnect. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Fraction 0..1 of symmetric noise on each delay. Default 0.1. */
  jitter?: number;
  /**
   * A subscription that stays healthy this long after its last overload gets
   * a fresh retry budget. Reset-on-recovery alone would let a thrashing
   * consumer loop forever. Default 60_000.
   */
  healthyResetMs?: number;
}

export const DEFAULT_RECONNECT: ReconnectSchedulerOpts = {
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  jitter: 0.1
};

export const DEFAULT_OVERLOAD_RESUBSCRIBE: Required<WsOverloadResubscribeOpts> = {
  enabled: true,
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  jitter: 0.1,
  healthyResetMs: 60_000
};

/** Events emitted by the subscribe/stream AsyncIterable. */
export type SubscribeEvent<T = unknown> =
  | { kind: 'snapshot'; data: T; shapes?: Record<string, string> }
  | { kind: 'add'; data: T; shapes?: Record<string, string> }
  | { kind: 'update'; data: T; shapes?: Record<string, string> }
  | { kind: 'remove'; removedId: string }
  | { kind: 'chunk'; data: T; shapes?: Record<string, string>; sequence?: number }
  | { kind: 'end'; final?: boolean; reason?: string }
  | { kind: 'error'; errors: Array<{ message: string; code?: string }> };

/** Convert a server frame to a SubscribeEvent, or null if unrecognised. */
export function msgToEvent(msg: FrameMessage): SubscribeEvent | null {
  switch (msg.kind) {
    case 'snapshot':
    case 'add':
    case 'update':
      return {
        kind: msg.kind,
        data: msg.data,
        ...(msg.shapes !== undefined ? { shapes: msg.shapes as Record<string, string> } : {})
      } as SubscribeEvent;
    case 'chunk':
      return {
        kind: 'chunk',
        data: msg.data,
        ...(msg.shapes !== undefined ? { shapes: msg.shapes as Record<string, string> } : {}),
        ...(msg.sequence !== undefined ? { sequence: msg.sequence } : {})
      };
    case 'remove':
      return { kind: 'remove', removedId: msg.removedId ?? '' };
    case 'end':
      return {
        kind: 'end',
        ...(msg.final !== undefined ? { final: msg.final } : {}),
        ...(msg.reason !== undefined ? { reason: msg.reason } : {})
      };
    case 'error': {
      const errors = msg.errors ?? [{ message: 'unknown error', code: 'unknown' }];
      const first = errors[0] ?? { message: 'unknown error', code: 'unknown' };
      // Throw SubscribeError — it will propagate from next()
      throw new SubscribeError(first.message, first.code ?? 'unknown');
    }
    default:
      return null;
  }
}
