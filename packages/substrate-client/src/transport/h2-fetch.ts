/**
 * A fetch-shaped function over `node:http2`: the transport seam's HTTP/2
 * adapter for Node and Bun (Todo #1850, Decision #625).
 *
 * One `ClientHttp2Session` per origin, opened on first use and shared by every
 * request to it; concurrent first calls share the pending connect. A session is
 * dropped on GOAWAY, close or error, and the next request opens a new one. An
 * idle session is unref'd, so a short-lived process exits without `close()`.
 * `http:` origins use HTTP/2 with prior knowledge (h2c); `https:` origins verify
 * the server against `ca`, or the process's default trust (which includes
 * NODE_EXTRA_CA_CERTS). Certificate checks are never turned off.
 *
 * Imports node builtins only.
 */

import http2 from 'node:http2';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface H2FetchOptions {
  /** PEM of a CA to trust for `https:` origins, beside the default trust. */
  ca?: string | Uint8Array;
  /** Give up on opening a session after this long. Default 10 000 ms. */
  connectTimeoutMs?: number;
}

export type H2Fetch = FetchLike & { close(): Promise<void> };

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** Request headers HTTP/2 forbids (RFC 9113 §8.2.2); fetch callers may still set them. */
const CONNECTION_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
  'host'
]);

interface Pooled {
  session: http2.ClientHttp2Session;
  active: number;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason as unknown;
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  return new DOMException('This operation was aborted', 'AbortError');
}

function toHeaderRecord(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init).forEach((value, name) => {
    if (!CONNECTION_HEADERS.has(name)) out[name] = value;
  });
  return out;
}

function toBodyBytes(body: BodyInit | null | undefined): Uint8Array | string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string' || body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body))
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError(
    'createH2Fetch: only string, ArrayBuffer and typed-array bodies are supported'
  );
}

export function createH2Fetch(opts: H2FetchOptions = {}): H2Fetch {
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const pool = new Map<string, Promise<Pooled>>();

  function connect(origin: string): Promise<Pooled> {
    const existing = pool.get(origin);
    if (existing !== undefined) return existing;
    const pending = new Promise<Pooled>((resolve, reject) => {
      const session = http2.connect(
        origin,
        origin.startsWith('https:') && opts.ca !== undefined ? { ca: opts.ca as string } : {}
      );
      const pooled: Pooled = { session, active: 0 };
      const drop = (): void => {
        if (pool.get(origin) === pending) pool.delete(origin);
      };
      const timer = setTimeout(() => {
        drop();
        session.destroy();
        reject(new Error(`connect to ${origin} timed out after ${connectTimeoutMs} ms`));
      }, connectTimeoutMs);
      timer.unref();
      session.once('connect', () => {
        clearTimeout(timer);
        session.unref();
        resolve(pooled);
      });
      session.on('error', (err) => {
        clearTimeout(timer);
        drop();
        reject(err);
      });
      session.on('goaway', drop);
      session.on('close', drop);
    });
    pending.catch(() => {});
    pool.set(origin, pending);
    return pending;
  }

  const fetchH2 = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw abortError(signal);
    const url = new URL(input);
    const pooled = await connect(url.origin);
    const body = toBodyBytes(init.body);
    const headers = {
      ...toHeaderRecord(init.headers),
      ':method': (init.method ?? 'GET').toUpperCase(),
      ':path': `${url.pathname}${url.search}`
    };

    return new Promise<Response>((resolve, reject) => {
      const stream = pooled.session.request(headers, { endStream: body === undefined });
      if (pooled.active++ === 0) pooled.session.ref();
      let settled = false;
      const release = (): void => {
        if (--pooled.active === 0 && !pooled.session.destroyed) pooled.session.unref();
      };
      stream.once('close', release);
      const onAbort = (): void => {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        if (!settled) {
          settled = true;
          reject(abortError(signal as AbortSignal));
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      stream.once('close', () => signal?.removeEventListener('abort', onAbort));
      stream.once('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      stream.once('response', (h) => {
        const status = Number(h[':status']);
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(h)) {
          if (name.startsWith(':') || value === undefined) continue;
          for (const v of Array.isArray(value) ? value : [String(value)])
            responseHeaders.append(name, v);
        }
        if (
          status >= 300 &&
          status < 400 &&
          responseHeaders.has('location') &&
          init.redirect !== 'manual'
        ) {
          // Substrate never redirects a request; following one would resend the token elsewhere.
          stream.close(http2.constants.NGHTTP2_CANCEL);
          settled = true;
          reject(
            new TypeError(`redirect refused: ${status} to ${responseHeaders.get('location')}`)
          );
          return;
        }
        const nullBody =
          status === 204 || status === 205 || status === 304 || init.method === 'HEAD';
        if (nullBody) stream.resume();
        settled = true;
        resolve(
          new Response(nullBody ? null : webBody(stream), {
            status,
            headers: responseHeaders
          })
        );
      });
      if (body !== undefined) stream.end(body);
    });
  };

  return Object.assign(fetchH2, {
    async close(): Promise<void> {
      const sessions = await Promise.allSettled([...pool.values()]);
      pool.clear();
      await Promise.all(
        sessions.map((s) =>
          s.status === 'fulfilled' && !s.value.session.closed
            ? new Promise<void>((r) => s.value.session.close(() => r()))
            : undefined
        )
      );
    }
  });
}

/**
 * The response body as a web stream, paused while the reader is behind, and
 * cancelling the HTTP/2 stream when the reader cancels. Built by hand rather
 * than with `Readable.toWeb`, which aborts an h2 body early under Bun.
 */
function webBody(stream: http2.ClientHttp2Stream): ReadableStream<Uint8Array> {
  let done = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on('data', (chunk: Buffer) => {
        if (done) return;
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        if ((controller.desiredSize ?? 1) <= 0) stream.pause();
      });
      stream.once('end', () => {
        if (done) return;
        done = true;
        controller.close();
      });
      stream.once('error', (err) => {
        if (done) return;
        done = true;
        controller.error(err);
      });
      stream.once('close', () => {
        // A reset with no 'end' (the server cancelled, the session died) is an error, not a short body.
        if (done) return;
        done = true;
        controller.error(new Error(`stream closed before its end (code ${stream.rstCode})`));
      });
    },
    pull() {
      stream.resume();
    },
    cancel() {
      done = true;
      stream.close(http2.constants.NGHTTP2_CANCEL);
    }
  });
}
