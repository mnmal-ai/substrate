/**
 * Driving the admin-gated `PATCH /substrate/v1/_system/keys` route, and the refusal ->
 * exit-code maps that go with it.
 *
 * The route is the DEFAULT for every mutating subcommand and `--direct` is what
 * an operator has to type, because a direct write leaves the running server's
 * registry stale — for `revoke` that means the credential keeps authenticating.
 */

import type { KeyMutationRefusal, KeyUpdateRefusal } from '@mnmal-ai/substrate-compose';
import type { AdminCliEnv } from './env.js';
import { AdminCliError } from './errors.js';
import { resolveAdminAuth } from './identity.js';

/**
 * Drive `PATCH /substrate/v1/_system/keys`. A write through the engine reaches the
 * running server's key registry; a direct write does not.
 *
 * Refusals come back with the same `code` the CLI's own guards produce,
 * because both sides ask `key-guards`. Statuses are mapped back to the
 * same exit codes so scripts do not care which transport ran.
 */
export async function runKeyPatchViaRoute(
  body: Record<string, unknown>,
  baseUrl: string,
  env: AdminCliEnv,
  exitCodes: Record<string, number>,
  fetchImpl: typeof fetch = fetch
): Promise<Record<string, unknown>> {
  const auth = resolveAdminAuth(env, baseUrl);
  if ('error' in auth)
    throw new AdminCliError(`${body.revoke === true ? 'revoke' : 'update'}: ${auth.error}`, 1);
  const url = `${baseUrl.replace(/\/+$/, '')}/substrate/v1/_system/keys`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: auth.ok },
      body: JSON.stringify(body),
      // A redirect would carry the token to wherever it points.
      redirect: 'error'
    });
  } catch (err) {
    throw new AdminCliError(
      `could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
      1
    );
  }
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof payload.code === 'string' ? payload.code : 'request_failed';
    const message = failureText(payload, res.status);
    throw new AdminCliError(message, exitCodes[code] ?? 1);
  }
  return payload;
}

/**
 * `revoke` refusal code -> CLI exit code. The route maps the same reasons to
 * HTTP statuses. Values are stable: scripts key on them.
 */
export const REVOKE_EXIT_CODES: Record<KeyMutationRefusal['code'], number> = {
  unknown_kid: 2,
  already_revoked: 3,
  last_active_admin: 4
};

/**
 * `update` refusal code -> CLI exit code. Values are stable: scripts key on
 * them. Guards, in the order they fire:
 *   - unknown kid → exit 2; revoked kid → exit 3 (updating a revoked key would
 *     be a quiet way to resurrect a retired identity)
 *   - dropping admin from the last active admin → exit 4, mirroring `revoke`'s
 *     lockout guard. Fires BEFORE the widen gate: it cannot be lifted by a flag,
 *     and one request can trip both.
 *   - a change that GRANTS authority the key lacks → exit 5 unless `--widen`
 *   - granting `admin` → additionally requires `--allow-admin`, mirroring
 *     `register`
 */
export const UPDATE_EXIT_CODES: Record<KeyUpdateRefusal['code'], number> = {
  unknown_kid: 2,
  already_revoked: 3,
  // `checkUpdatable` never returns this — it is inherited from the shared
  // refusal union with revoke. Mapped to the same lockout code so a future
  // rule that does return it cannot fall through to an undefined exit status.
  last_active_admin: 4,
  last_admin_deadmin: 4,
  requires_widen: 5,
  requires_allow_admin: 1,
  // A grant that will not parse is a malformed command, not a refused one.
  invalid_grant: 1
};

/**
 * Drive `GET /substrate/v1/_system/keys` — the authenticated read behind
 * `list --url`, gated by the server's admin check.
 *
 * Pages to exhaustion rather than returning the first page: a silently
 * truncated answer to "which identities exist" is worse than an error.
 */
export async function runKeyListViaRoute(
  baseUrl: string,
  env: AdminCliEnv,
  fetchImpl: typeof fetch = fetch
): Promise<Array<Record<string, unknown>>> {
  const auth = resolveAdminAuth(env, baseUrl);
  if ('error' in auth) throw new AdminCliError(`list: ${auth.error}`, 1);
  const base = `${baseUrl.replace(/\/+$/, '')}/substrate/v1/_system/keys`;
  const keys: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  // Bounded so a server that always answers hasMore cannot spin forever — a
  // pager that cannot terminate is its own outage.
  for (let page = 0; page < 50; page += 1) {
    const url = cursor === undefined ? base : `${base}?cursor=${encodeURIComponent(cursor)}`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: { authorization: auth.ok },
        redirect: 'error'
      });
    } catch (err) {
      throw new AdminCliError(
        `could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
        1
      );
    }
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const message = failureText(payload, res.status);
      // 403 is the answer, not a malfunction: the server verified this caller
      // and said no. Naming the kid is what makes it actionable.
      throw new AdminCliError(
        res.status === 403
          ? `list --url: refused by ${baseUrl} — ${message}\n  This is the server's verdict on the credential you presented, which is exactly what \`list\` without --url cannot tell you.`
          : `list --url: ${message}`,
        res.status === 403 ? 5 : 1
      );
    }
    const batch = payload.keys;
    if (!Array.isArray(batch)) {
      throw new AdminCliError('list --url: response carried no `keys` array', 1);
    }
    keys.push(...(batch as Array<Record<string, unknown>>));
    if (payload.hasMore !== true) return keys;
    cursor = typeof payload.nextCursor === 'string' ? payload.nextCursor : undefined;
    if (cursor === undefined) {
      throw new AdminCliError(
        'list --url: server reported hasMore with no nextCursor — refusing to report a partial list as complete',
        1
      );
    }
  }
  throw new AdminCliError('list --url: pagination did not terminate after 50 pages', 1);
}

/** A refusal body as one line: its `message`, else `code (reason): detail`, else the status. */
function failureText(payload: Record<string, unknown>, status: number): string {
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.code !== 'string') return `HTTP ${status}`;
  const reason = typeof payload.reason === 'string' ? ` (${payload.reason})` : '';
  const detail = typeof payload.detail === 'string' ? `: ${payload.detail}` : '';
  return `${payload.code}${reason}${detail}`;
}
