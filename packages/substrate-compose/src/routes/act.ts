/**
 * POST /substrate/v1/act and GET /substrate/v1/act/results/:id.
 *
 * Both sit behind `read`; the engine's per-step grant check still demands
 * `mutate` for every write. An anonymous caller admitted by the read gate is
 * refused here, since acting and result ownership need a credential.
 */

import type {
  ActHandle,
  ActRequest,
  HttpHandler,
  SubstrateRequest,
  SubstrateResponse
} from '@mnmal-ai/substrate-types';
import { noCredentialResponse } from '../compose/auth-middleware.js';
import { buildContext, error400, jsonResponse, parseJsonBody } from './helpers.js';

const MAX_IDEMPOTENCY_KEY = 256;

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** The first malformed field's message, or the request. */
function parseActBody(value: unknown): ActRequest | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'body must be an object';
  }
  const b = value as Record<string, unknown>;
  const { sketch, mode, namespace, idempotencyKey } = b;
  const stepsOk =
    Array.isArray(sketch) &&
    sketch.every((s) => typeof s === 'object' && s !== null && !Array.isArray(s));
  if (!isNonEmptyString(sketch) && !stepsOk) {
    return 'sketch must be a non-empty string or an array of step objects';
  }
  if (mode !== undefined && mode !== 'write' && mode !== 'dry-run') {
    return "mode must be 'write' or 'dry-run'";
  }
  if (namespace !== undefined && !isNonEmptyString(namespace)) {
    return 'namespace must be a non-empty string';
  }
  if (
    idempotencyKey !== undefined &&
    (!isNonEmptyString(idempotencyKey) || idempotencyKey.length > MAX_IDEMPOTENCY_KEY)
  ) {
    return `idempotencyKey must be a non-empty string of at most ${MAX_IDEMPOTENCY_KEY} characters`;
  }
  return b as unknown as ActRequest;
}

/** Auth on and no identity: an admitted anonymous read, which cannot act. */
const anonymousRefusal = (
  req: SubstrateRequest,
  authEnabled: boolean | undefined
): SubstrateResponse | null =>
  (authEnabled ?? req.authEnabled) === true && req.identity === undefined
    ? noCredentialResponse()
    : null;

export function actRoute(
  engine: ActHandle,
  trustedProxies: Set<string>,
  authEnabled?: boolean
): HttpHandler {
  return async (req) => {
    const refused = anonymousRefusal(req, authEnabled);
    if (refused !== null) return refused;
    const parsed = parseJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const request = parseActBody(parsed.value);
    if (typeof request === 'string') return error400(request);
    const response = await engine.act({
      ...request,
      ctx: buildContext(req, trustedProxies, authEnabled),
      ...(req.signal !== undefined ? { signal: req.signal } : {})
    });
    return jsonResponse(200, response);
  };
}

export function actResultRoute(
  engine: ActHandle,
  _trustedProxies: Set<string>,
  authEnabled?: boolean
): HttpHandler {
  return async (req) => {
    const refused = anonymousRefusal(req, authEnabled);
    if (refused !== null) return refused;
    const id = req.params.id;
    const record =
      id === undefined || id === '' ? undefined : await engine.actResult(id, req.identity ?? null);
    // One body for an unknown id and another caller's id.
    if (record === undefined)
      return jsonResponse(404, { code: 'not_found', message: 'no such result' });
    return jsonResponse(200, record);
  };
}
