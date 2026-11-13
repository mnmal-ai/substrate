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
  /** Requests awaiting a response, plus bodies whose reader is waiting for data. */
  holds: number;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason as unknown;
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  return new DOMException('This operation was aborted', 'AbortError');
}

function toHeaderRecord(init: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init).forEach((value, name) => {
    if (!CONNECTION_HEADERS.has(name)) out[name] = value;
  });
  return out;
}

function toBodyBytes(body: RequestInit['body']): Uint8Array | string | undefined {
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
  /** Every session opened, connected or not, so close() can end them all. */
  const sessions = new Set<http2.ClientHttp2Session>();

  function connect(origin: string): Promise<Pooled> {
    const existing = pool.get(origin);
    if (existing !== undefined) return existing;
    const pending = new Promise<Pooled>((resolve, reject) => {
      const session = http2.connect(
        origin,
        origin.startsWith('https:') && opts.ca !== undefined ? { ca: opts.ca as string } : {}
      );
      sessions.add(session);
      session.once('close', () => sessions.delete(session));
      const pooled: Pooled = { session, holds: 0 };
      let connected = false;
      const drop = (): void => {
        if (pool.get(origin) === pending) pool.delete(origin);
      };
      const fail = (err: Error): void => {
        clearTimeout(timer);
        drop();
        if (!connected) reject(err);
      };
      const timer = setTimeout(() => {
        session.destroy();
        fail(new Error(`connect to ${origin} timed out after ${connectTimeoutMs} ms`));
      }, connectTimeoutMs);
      timer.unref();
      session.once('connect', () => {
        clearTimeout(timer);
        connected = true;
        session.unref();
        resolve(pooled);
      });
      session.on('error', fail);
      session.on('goaway', drop);
      session.on('close', () => fail(new Error(`connection to ${origin} closed before it opened`)));
    });
    pending.catch(() => {});
    pool.set(origin, pending);
    return pending;
  }

  /** Forget `pooled` if it is still the origin's session, so the next request opens a new one. */
  function forget(origin: string, pooled: Pooled): void {
    const current = pool.get(origin);
    if (current === undefined) return;
    void current.then(
      (p) => {
        if (p === pooled && pool.get(origin) === current) pool.delete(origin);
      },
      () => {}
    );
  }

  const fetchH2 = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw abortError(signal);
    const url = new URL(input);
    const body = toBodyBytes(init.body);
    const headers = {
      ...toHeaderRecord(init.headers),
      ':method': (init.method ?? 'GET').toUpperCase(),
      ':path': `${url.pathname}${url.search}`
    };
    // A request that races a GOAWAY is safe to send once more, on a fresh session.
    for (let attempt = 0; ; attempt++) {
      const pooled = await untilAborted(connect(url.origin), signal);
      const outcome = await send(pooled, headers, body, init, signal);
      if (outcome.kind === 'response') return outcome.response;
      forget(url.origin, pooled);
      if (outcome.kind === 'retry' && attempt === 0) continue;
      throw outcome.error;
    }
  };

  return Object.assign(fetchH2, {
    async close(): Promise<void> {
      pool.clear();
      await Promise.all(
        [...sessions].map((session) => {
          // One still connecting has nothing to drain.
          if (session.connecting) {
            session.destroy();
            return undefined;
          }
          return session.closed ? undefined : new Promise<void>((r) => session.close(() => r()));
        })
      );
    }
  });
}

type Outcome =
  | { kind: 'response'; response: Response }
  | { kind: 'retry'; error: Error }
  | { kind: 'error'; error: Error };

/** Keep the session ref'd while anyone waits on it; an idle or unread one lets the process exit. */
function hold(p: Pooled): void {
  if (p.holds++ === 0) p.session.ref();
}
function release(p: Pooled): void {
  if (--p.holds === 0 && !p.session.destroyed) p.session.unref();
}

function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      }
    );
  });
}

const RETRYABLE_CODES = new Set(['ERR_HTTP2_GOAWAY_SESSION', 'ERR_HTTP2_INVALID_SESSION']);

function send(
  pooled: Pooled,
  headers: Record<string, string>,
  body: Uint8Array | string | undefined,
  init: RequestInit,
  signal: AbortSignal | undefined
): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    let stream: http2.ClientHttp2Stream;
    try {
      stream = pooled.session.request(headers, { endStream: body === undefined });
    } catch (err) {
      const code = (err as { code?: string }).code;
      resolve({
        kind: code !== undefined && RETRYABLE_CODES.has(code) ? 'retry' : 'error',
        error: err as Error
      });
      return;
    }
    hold(pooled);
    let settled = false;
    const settle = (o: Outcome): void => {
      if (settled) return;
      settled = true;
      release(pooled);
      resolve(o);
    };
    const onAbort = (): void => {
      stream.close(http2.constants.NGHTTP2_CANCEL);
      settle({ kind: 'error', error: abortError(signal as AbortSignal) });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    stream.once('close', () => {
      signal?.removeEventListener('abort', onAbort);
      // Closed before any response: a refused stream (GOAWAY race) is retried once; anything else fails.
      const refused = stream.rstCode === http2.constants.NGHTTP2_REFUSED_STREAM;
      settle({
        kind: refused ? 'retry' : 'error',
        error: new Error(`stream closed before a response (code ${stream.rstCode})`)
      });
    });
    stream.once('error', (err) => settle({ kind: 'error', error: err }));
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
        settle({
          kind: 'error',
          error: new TypeError(`redirect refused: ${status} to ${responseHeaders.get('location')}`)
        });
        return;
      }
      const nullBody =
        status === 204 || status === 205 || status === 304 || headers[':method'] === 'HEAD';
      let response: Response;
      try {
        response = new Response(nullBody ? null : webBody(stream, pooled, signal), {
          status,
          headers: responseHeaders
        });
      } catch (err) {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        settle({ kind: 'error', error: err as Error });
        return;
      }
      if (nullBody) stream.resume();
      settle({ kind: 'response', response });
    });
    if (body !== undefined) stream.end(body);
  });
}

/**
 * The response body as a web stream with backpressure. The session stays ref'd
 * only while the reader is waiting for data, so a body nobody reads lets the
 * process exit. An unread body still holds its HTTP/2 stream open until the
 * server finishes it: read or cancel every body. Cancelling resets the stream.
 * Built by hand rather than with `Readable.toWeb`, which aborts h2 bodies early under Bun.
 */
function webBody(
  stream: http2.ClientHttp2Stream,
  pooled: Pooled,
  signal: AbortSignal | undefined
): ReadableStream<Uint8Array> {
  let done = false;
  let holding = false;
  const setHold = (on: boolean): void => {
    if (on === holding) return;
    holding = on;
    if (on) hold(pooled);
    else release(pooled);
  };
  const finish = (): void => {
    done = true;
    setHold(false);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on('data', (chunk: Buffer) => {
        if (done) return;
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        if ((controller.desiredSize ?? 1) <= 0) {
          stream.pause();
          setHold(false);
        }
      });
      stream.once('end', () => {
        if (done) return;
        finish();
        // A cancel for an abort can still end the stream cleanly; it is not a complete body.
        if (signal?.aborted) controller.error(abortError(signal));
        else controller.close();
      });
      stream.once('error', (err) => {
        if (done) return;
        finish();
        controller.error(signal?.aborted ? abortError(signal) : err);
      });
      stream.once('close', () => {
        // A reset with no 'end' (aborted, cancelled by the server, the session died) is an error, not a short body.
        if (done) return;
        finish();
        controller.error(
          signal?.aborted
            ? abortError(signal)
            : new Error(`stream closed before its end (code ${stream.rstCode})`)
        );
      });
    },
    pull() {
      if (done) return;
      setHold(true);
      stream.resume();
    },
    cancel() {
      finish();
      stream.close(http2.constants.NGHTTP2_CANCEL);
    }
  });
}
