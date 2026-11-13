/**
 * The sentinel's frame-stream routes:
 *
 *   - `POST /register` (the plugin router gates it on `mutate`) takes the
 *     register body `{ name, url, namespaces, version?, bridges? }`. A refusal is
 *     an HTTP status with `{ error }`. Otherwise the answer is a stream of
 *     length-prefixed JSON frames: first the register reply, then nothing but
 *     heartbeats. The registrant is online for as long as the response stays
 *     open, and closing it marks the registrant offline.
 *   - `GET /watch` (gated on `read`) streams `{ ok: true, watching: true }` and
 *     then every `{ event: 'online' | 'offline', … }` broadcast.
 *
 * A peer here is alive while its response is open: the liveness tick sends it
 * zero-length heartbeat frames, and a dead socket surfaces as the response
 * closing.
 */

import { FRAMES_JSON_MIME, HEARTBEAT_FRAME } from '@mnmal-ai/substrate/pack';
import type {
  Identity,
  PluginRouteContext,
  PluginRouter,
  SubstrateRequest,
  SubstrateResponse
} from '@mnmal-ai/substrate/sdk';
import { jsonResponse } from '@mnmal-ai/substrate/sdk';
import {
  grantsCapability,
  handleClose,
  handleRegister,
  handleWatch,
  parseFrame
} from './coordinators.js';
import type { LivenessRegistry, PeerConnection } from './liveness.js';

const HEADERS: Record<string, string> = {
  'content-type': FRAMES_JSON_MIME,
  'cache-control': 'no-store',
  'x-accel-buffering': 'no'
};

/** Queued bytes past which a reader that stopped reading is dropped. */
const MAX_QUEUED_BYTES = 1024 * 1024;

const utf8 = new TextEncoder();

/** A JSON message as one length-prefixed frame. */
function frameOf(message: string): Uint8Array {
  const payload = utf8.encode(message);
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}

/**
 * A response body that is a liveness peer. `onEnd` runs once, whichever side
 * ends it: the client disconnecting, the request aborting, or `close()` from
 * the registry (a superseding registration, an eviction, shutdown).
 */
export function framePeer(onEnd: (peer: PeerConnection) => unknown): {
  peer: PeerConnection;
  body: ReadableStream<Uint8Array>;
  /** True once the response has ended, whichever side ended it. */
  ended: () => boolean;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    onEnd(peer);
  };
  const enqueue = (bytes: Uint8Array): void => {
    if (ended || controller === undefined) return;
    if ((controller.desiredSize ?? 0) < -MAX_QUEUED_BYTES) {
      peer.close();
      return;
    }
    try {
      controller.enqueue(bytes);
    } catch {
      end();
    }
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      cancel() {
        controller = undefined;
        end();
      }
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 })
  );
  const peer: PeerConnection = {
    send: (message) => enqueue(frameOf(message)),
    heartbeat: () => enqueue(HEARTBEAT_FRAME),
    // error, not close: a stalled reader's queue is dropped and the response aborts,
    // rather than holding the socket (and server.stop) until it reads.
    close: () => {
      if (!ended) {
        try {
          controller?.error(new Error('sentinel feed closed'));
        } catch {
          // Already closed by the reader.
        }
      }
      end();
    }
  };
  return { peer, body, ended: () => ended };
}

function refuse(status: number, error: string): SubstrateResponse {
  return jsonResponse(status, { error });
}

/** 401 without an identity, 403 without `capability` in `namespace`, else undefined. */
function gate(
  identity: Identity | undefined,
  namespace: string,
  capability: 'read' | 'mutate'
): SubstrateResponse | undefined {
  if (identity === undefined) return refuse(401, 'unauthorized');
  if (!grantsCapability(identity, namespace, capability)) return refuse(403, 'forbidden');
  return undefined;
}

/** Registers the routes; the returned function ends every open response. */
export function registerSentinelStreamRoutes(
  router: PluginRouter,
  ctx: PluginRouteContext,
  namespace: string,
  registry: LivenessRegistry
): () => Promise<void> {
  /** One peer per open response, so the route ends them all at shutdown. */
  const open = new Set<PeerConnection>();
  /** Offline writes in flight, which shutdown waits for while the engine is still up. */
  const closing = new Set<Promise<unknown>>();

  const track = (req: SubstrateRequest, identity: Identity | null) => {
    const close = (p: PeerConnection): Promise<void> => {
      const done = handleClose(ctx.engine, namespace, identity, registry, p)
        .catch(() => {
          // Close-path faults cannot be surfaced to the peer.
        })
        .finally(() => closing.delete(done));
      closing.add(done);
      return done;
    };
    const fp = framePeer((p) => {
      open.delete(p);
      void close(p);
    });
    open.add(fp.peer);
    if (req.signal?.aborted === true) fp.peer.close();
    else req.signal?.addEventListener('abort', () => fp.peer.close(), { once: true });
    return { ...fp, close };
  };

  router.post('/register', async (req): Promise<SubstrateResponse> => {
    const refused = gate(req.identity, namespace, 'mutate');
    if (refused !== undefined) return refused;
    const frame = parseFrame(req.body ?? Buffer.alloc(0));
    if (frame === undefined) return refuse(400, 'invalid JSON');
    const identity = req.identity ?? null;
    const { peer, body, ended, close } = track(req, identity);
    // Already gone: registering now would supersede a live stream for nothing.
    if (ended()) return { status: 499 };
    try {
      const refusal = await handleRegister(ctx.engine, namespace, identity, registry, peer, frame);
      if (refusal !== undefined) {
        open.delete(peer);
        return refuse(refusal.status, refusal.error);
      }
    } catch {
      peer.close();
      return refuse(500, 'register failed');
    }
    // The client left while the register was in flight: its close ran before the
    // peer was tracked, so close again or the coordinator stays online with no stream.
    if (ended()) await close(peer);
    return { status: 200, headers: HEADERS, body };
  });

  router.get('/watch', async (req): Promise<SubstrateResponse> => {
    const refused = gate(req.identity, namespace, 'read');
    if (refused !== undefined) return refused;
    const { peer, body, ended } = track(req, req.identity ?? null);
    if (!ended()) handleWatch(registry, peer);
    return { status: 200, headers: HEADERS, body };
  });

  // The plugin's onStop awaits this: an open response would otherwise hold server.stop(),
  // and the offline writes must land before the engine stops.
  return async () => {
    for (const peer of [...open]) peer.close();
    await Promise.all([...closing]);
  };
}
