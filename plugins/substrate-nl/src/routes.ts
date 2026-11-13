import { FRAMES_JSON_MIME, framesEncodingFromAccept } from '@mnmal-ai/substrate/pack';
import type { HttpHandler, SubstrateResponse } from '@mnmal-ai/substrate/sdk';
import { error400, jsonResponse, parseJsonBody } from '@mnmal-ai/substrate/sdk';
import type { NlEngineAccess } from './access.js';
import { FRAMES_HEADERS, frameBytes, toEventStream, toJson } from './ask/encode.js';
import type { AskRequest } from './ask/events.js';
import { runAsk } from './ask/run.js';
import type { Judge } from './judge/judge.js';
import type { PackService } from './pack/service.js';
import { validAsOf } from './parse/time.js';

export interface NlRouteDeps {
  engine: NlEngineAccess;
  packs: PackService;
  judge?: Judge;
  judgeTimeoutMs?: number;
  now?: () => Date;
  /** Receives the real engine error; clients only ever see a fixed message. */
  log?: (err: unknown) => void;
}

const VARY = { vary: 'authorization' };
const engineFailure = (
  req: { signal?: AbortSignal },
  err: unknown,
  log: (err: unknown) => void
): SubstrateResponse => {
  if (req.signal?.aborted === true) return { status: 499 };
  log(err);
  return jsonResponse(502, { error: 'NL query failed', code: 'nl_engine_error' });
};

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Longest question parsed; the same bound recall puts on its query text. */
const MAX_QUESTION_CHARS = 8192;

export function askHandler(deps: NlRouteDeps): HttpHandler {
  const log = deps.log ?? ((err: unknown) => console.error('substrate-nl:', err));
  return async (req) => {
    const parsed = parseJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.value as Record<string, unknown> | null;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return error400(
        'body must be a JSON object: { namespace, question, project?, type?, asOf? }'
      );
    }
    if (!str(body.namespace)) return error400('body.namespace must be a non-empty string');
    if (!str(body.question)) return error400('body.question must be a non-empty string');
    if (body.question.length > MAX_QUESTION_CHARS)
      return error400(`body.question is longer than ${MAX_QUESTION_CHARS} characters`);
    for (const k of ['project', 'type'] as const) {
      if (body[k] !== undefined && !str(body[k]))
        return error400(`body.${k} must be a non-empty string when given`);
    }
    if (body.asOf !== undefined && !validAsOf(body.asOf))
      return jsonResponse(400, {
        error:
          'body.asOf must be an ISO-8601 date-time with an offset, e.g. 2026-10-02T12:00:00-05:00',
        code: 'invalid_params'
      });
    const ask: AskRequest = {
      namespace: body.namespace,
      question: body.question,
      ...(str(body.project) ? { project: body.project } : {}),
      ...(str(body.type) ? { type: body.type } : {}),
      ...(validAsOf(body.asOf) ? { asOf: body.asOf } : {})
    };
    let served: Awaited<ReturnType<PackService['get']>>;
    try {
      served = await deps.packs.get(ask.namespace, req);
    } catch (err) {
      return engineFailure(req, err, log);
    }
    if (served === undefined)
      return jsonResponse(404, {
        error: `unknown namespace '${ask.namespace}'`,
        code: 'nl_unknown_namespace'
      });
    if (ask.type !== undefined && !Object.hasOwn(served.pack.types, ask.type))
      return error400(`unknown type '${ask.type}'`);
    const frames = framesEncodingFromAccept(req.headers.accept);
    // NL events are a few small objects, so frames are JSON only.
    if (frames === 'pack')
      return jsonResponse(406, {
        error: `NL streams ${FRAMES_JSON_MIME} only`,
        code: 'not_acceptable'
      });
    const events = runAsk(ask, req, {
      pack: served.pack,
      engine: deps.engine,
      ...(deps.judge !== undefined ? { judge: deps.judge } : {}),
      ...(deps.judgeTimeoutMs !== undefined ? { judgeTimeoutMs: deps.judgeTimeoutMs } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {})
    });
    if (frames === 'json') {
      return {
        status: 200,
        headers: FRAMES_HEADERS,
        body: toEventStream(events, frameBytes, undefined, log)
      };
    }
    try {
      return jsonResponse(200, await toJson(events));
    } catch (err) {
      return engineFailure(req, err, log);
    }
  };
}

export function packHandler(deps: NlRouteDeps): HttpHandler {
  const log = deps.log ?? ((err: unknown) => console.error('substrate-nl:', err));
  return async (req) => {
    const ns = req.params.ns ?? '';
    let served: Awaited<ReturnType<PackService['get']>>;
    try {
      served = await deps.packs.get(ns, req);
    } catch (err) {
      return engineFailure(req, err, log);
    }
    if (served === undefined)
      return jsonResponse(404, {
        error: `unknown namespace '${ns}'`,
        code: 'nl_unknown_namespace'
      });
    if (req.headers['if-none-match'] === served.etag) {
      return { status: 304, headers: { etag: served.etag, ...VARY } };
    }
    return jsonResponse(200, served.pack, {
      etag: served.etag,
      'cache-control': 'private, no-cache',
      ...VARY
    });
  };
}
