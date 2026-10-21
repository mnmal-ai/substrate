/**
 * Auth-posture probe used by `substrate federate enroll`.
 *
 * A token minted against a callee with auth disabled yields a credential that
 * proves nothing, with no signal to the operator — so enroll refuses that
 * case. Anything OTHER than a clear "auth is off" answer reads as
 * `unreachable`, which enroll treats as a warning: a host legitimately may not
 * reach its own public URL (split-horizon DNS), and that is not evidence about
 * auth posture. Guessing either way from an ambiguous response would break one
 * of the two cases.
 */

import { type HttpJsonFn, httpJson } from './http.js';

const PROBE_TIMEOUT_MS = 5_000;

export type AuthPosture = 'enabled' | 'disabled' | 'unreachable';

export interface ProbeOptions {
  httpJson?: HttpJsonFn;
}

export async function probeAuthPosture(
  origin: string,
  opts: ProbeOptions = {}
): Promise<AuthPosture> {
  const call = opts.httpJson ?? httpJson;
  let res: Awaited<ReturnType<HttpJsonFn>>;
  try {
    // /substrate/v1/whoami, not /substrate/v1/onboard: onboard needs a key once auth is on,
    // and a probe runs BEFORE enrolment, with no key to present. whoami answers every caller and carries
    // `authEnabled` at the top level.
    res = await call(`${origin}/substrate/v1/whoami`, { timeoutMs: PROBE_TIMEOUT_MS });
  } catch {
    return 'unreachable';
  }
  if (res.status < 200 || res.status >= 300) return 'unreachable';
  const body = res.body;
  if (body === null || typeof body !== 'object') return 'unreachable';
  const authEnabled = (body as Record<string, unknown>).authEnabled;
  if (authEnabled === true) return 'enabled';
  if (authEnabled === false) return 'disabled';
  return 'unreachable';
}
