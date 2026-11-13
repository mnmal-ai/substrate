import { decodeStreamFrames, FRAMES_JSON_MIME } from '@mnmal-ai/substrate-pack';
import type {
  NlAskRequest,
  NlAskResult,
  NlOutcome,
  NlServedPack,
  NlTrailEvent,
  NlWireEvent
} from '@mnmal-ai/substrate-types';
import { NetworkError } from './errors.js';
import { FRAMES_UNSUPPORTED } from './transport/frames.js';
import type { HttpTransport } from './transport/http.js';

export type { NlAskRequest, NlAskResult, NlOutcome, NlServedPack, NlTrailEvent, NlWireEvent };

export interface NlApi {
  ask(req: NlAskRequest, opts?: { signal?: AbortSignal }): AsyncIterable<NlWireEvent>;
  askJson(req: NlAskRequest, opts?: { signal?: AbortSignal }): Promise<NlAskResult>;
  pack(namespace: string, opts?: { signal?: AbortSignal }): Promise<NlServedPack>;
}

export function createNlApi(t: HttpTransport): NlApi {
  const packs = new Map<string, { etag: string; body: NlServedPack }>();
  return {
    async *ask(req, opts = {}) {
      const res = await t.raw('/substrate/v1/nl', {
        method: 'POST',
        body: req,
        accept: FRAMES_JSON_MIME,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {})
      });
      const type = res.headers.get('content-type') ?? '';
      if (!type.startsWith(FRAMES_JSON_MIME) || res.body === null) {
        await res.body?.cancel();
        throw new NetworkError(
          `POST /substrate/v1/nl answered '${type}', not ${FRAMES_JSON_MIME}: the server predates frame streams`,
          null,
          { status: res.status, code: FRAMES_UNSUPPORTED }
        );
      }
      const utf8 = new TextDecoder();
      for await (const payload of decodeStreamFrames(res.body)) {
        const ev = JSON.parse(utf8.decode(payload)) as { event: string; data: unknown };
        if (ev.event === 'error') {
          const e = ev.data as { code?: string; message?: string };
          throw new NetworkError(`${e.code ?? 'error'}: ${e.message ?? ''}`, ev.data);
        }
        // An unknown event name is a server newer than this client, passed through.
        yield ev as NlWireEvent;
      }
    },
    async askJson(req, opts = {}) {
      const res = await t.raw('/substrate/v1/nl', {
        method: 'POST',
        body: req,
        accept: 'application/json',
        ...(opts.signal !== undefined ? { signal: opts.signal } : {})
      });
      return (await res.json()) as NlAskResult;
    },
    async pack(namespace, opts = {}) {
      const prior = packs.get(namespace);
      const url = `/substrate/v1/nl/pack/${encodeURIComponent(namespace)}`;
      const res = await t.raw(url, {
        method: 'GET',
        allow304: true,
        ...(prior !== undefined ? { headers: { 'if-none-match': prior.etag } } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {})
      });
      if (res.status === 304) {
        if (prior !== undefined) return structuredClone(prior.body);
        throw new NetworkError(`GET ${url} returned 304 with no cached pack to reuse`, null);
      }
      const body = (await res.json()) as NlServedPack;
      const etag = res.headers.get('etag');
      if (etag !== null) packs.set(namespace, { etag, body: structuredClone(body) });
      return structuredClone(body);
    }
  };
}
