/**
 * Unified WebSocket frame grammar. Spec §8.5.
 *
 * One client→server shape, one server→client shape. §5.4 subscriptions use
 * `subscribe` and `cancel`; §5.5 streaming adds the `stream` op and the
 * `chunk` response kind.
 */

import type { Id } from './core.js';
import type { FieldInput } from './schema.js';

/**
 * Client→server frame. `frame` is a map of qualified keys (`<ns>/<name>`, §4.7)
 * to selection entries. `subscribe` and `stream` require the selection map;
 * `cancel` addresses a prior subscription by `id` and omits `frame`.
 */
export interface WsRequestFrame {
  id: string;
  /**
   * `whoami` carries no `frame` and opens no session. It reports the
   * socket's own authentication, which is a different code path from HTTP's,
   * so asking over HTTP does not answer it.
   */
  op: 'subscribe' | 'stream' | 'cancel' | 'whoami';
  frame?: Record<string, { params?: Record<string, unknown>; fields?: FieldInput }>;
}

/**
 * Response kinds covering the full §5.4 + §5.5 surface. `chunk` carries
 * streaming output; subscription pushes use `snapshot` / `add` / `update` / `remove`
 * plus `end` on cancel and `error` on validation / policy / resolver failure.
 */
export type WsResponseKind =
  | 'snapshot'
  | 'add'
  | 'update'
  | 'remove'
  | 'chunk'
  | 'end'
  | 'error'
  | 'whoami';

/**
 * Server→client frame. `data` is the payload a route layer serialises per the
 * connection's negotiated encoding (named objects → JSON, or positional tuples
 * via substrate-pack). `removedId` replaces `data` for the `remove` kind so remove
 * frames can fire cheaply without re-encoding the dropped row.
 */
export interface WsResponseFrame {
  id: string;
  kind: WsResponseKind;
  schemaVersion?: string;
  data?: unknown;
  shapes?: Record<string, 'single' | 'list'>;
  removedId?: Id;
  errors?: Array<{ message: string; code?: string; path?: string[] }>;
  /** §5.5 streaming: last-chunk marker; also set on `end` from a `cancel`. */
  final?: boolean;
  /** §5.5 streaming: monotonic per-subscription sequence on chunks. */
  sequence?: number;
  /**
   * Frame-level metadata bag. Currently carries `cancelled: true` on `end`
   * frames emitted because a stream was cancelled (vs natural completion),
   * letting the client disambiguate when cancellation races completion. The
   * exact wire key (`_meta.cancelled`) is part of the on-wire contract — do
   * not rename it.
   */
  _meta?: { cancelled?: boolean };
  /**
   * Terminal-cause token on `end` frames. One vocabulary, one token per
   * condition, reused verbatim wherever that condition appears (so the
   * overload token matches the `code` on the preceding `error` frame).
   * Known values: `WS_REASON_SUBSCRIPTION_OVERLOADED` (queue-limit teardown),
   * `WS_REASON_SERVER_RESTART` (graceful shutdown). Absent on a cancel ack.
   * Stays `string` on the wire for forward compatibility — clients must
   * tolerate unknown tokens. Contract: docs/ws-subscription-contract.md.
   */
  reason?: string;
}

/**
 * Terminal-cause vocabulary (docs/ws-subscription-contract.md). The overload
 * token is BOTH the `code` of the terminal `error` frame and the `reason` of
 * the following `end` frame — one token per condition, no second spelling.
 */
export const WS_REASON_SUBSCRIPTION_OVERLOADED = 'subscription_overloaded' as const;
export const WS_REASON_SERVER_RESTART = 'server_restart' as const;

/**
 * Error `code` for a subscribe/stream frame the engine refuses to register
 * because the targeted surface is one-shot-only: a virtual (dataset-less)
 * namespace has no write stream to subscribe to, and a semantic
 * (extension-operator) where-clause has no incremental evaluation.
 */
export const WS_CODE_SUBSCRIPTION_UNSUPPORTED_FRAME = 'subscription_unsupported_frame' as const;
