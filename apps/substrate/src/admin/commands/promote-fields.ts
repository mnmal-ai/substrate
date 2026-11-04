/**
 * `substrate-admin promote-fields [--url <base>]` — run the promotion sweep
 * now, through the running server's admin-gated
 * `POST /substrate/v1/_system/promote-fields`, rather than waiting for
 * `SUBSTRATE_PROMOTE_INTERVAL_MS`. It goes through the server because the
 * sweep's audit events must reach its subscribers; there is no `--direct`.
 * Unlike the timed sweep, it retries a field a unique conflict holds back,
 * so an operator who has fixed the data can finish its promotion.
 */

import type { PromotionEvent } from '@mnmal-ai/substrate-types';
import { trimTrailingSlashes } from '@mnmal-ai/substrate-types';
import { validateArgv } from '../argv.js';
import type { AdminCliEnv } from '../env.js';
import { AdminCliError } from '../errors.js';
import { describeAdminTarget, resolveAdminAuth, resolveAdminTarget } from '../identity.js';
import { argvError } from '../usage.js';

export interface PromoteFieldsResult {
  target: string;
  events: PromotionEvent[];
}

/** Parses `argv` (after the subcommand), resolves the server, and runs one sweep there. */
export async function promoteFieldsCommand(
  argv: readonly string[],
  env: AdminCliEnv,
  fetchImpl: typeof fetch = fetch
): Promise<PromoteFieldsResult> {
  validateArgv('promote-fields', argv);
  let url: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--url') continue;
    if (url !== undefined) {
      throw argvError('promote-fields', 'promote-fields: --url specified more than once');
    }
    url = argv[i + 1] ?? '';
    i += 1;
  }
  if (url === '') throw argvError('promote-fields', 'promote-fields: --url requires a base URL');
  const target = resolveAdminTarget(url ?? null, env);
  if (target.kind !== 'route') {
    throw new AdminCliError(
      'promote-fields runs on a running server: pass --url <base> or set SUBSTRATE_URL',
      1
    );
  }
  const auth = resolveAdminAuth(env, target.baseUrl);
  if ('error' in auth) throw new AdminCliError(`promote-fields: ${auth.error}`, 1);
  const endpoint = `${trimTrailingSlashes(target.baseUrl)}/substrate/v1/_system/promote-fields`;
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { authorization: auth.ok, 'content-type': 'application/json' },
      body: '{}',
      redirect: 'error'
    });
  } catch (err) {
    throw new AdminCliError(
      `could not reach ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
      1
    );
  }
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const reason =
      typeof payload.message === 'string'
        ? payload.message
        : typeof payload.code === 'string'
          ? payload.code
          : `HTTP ${res.status}`;
    throw new AdminCliError(`promote-fields: ${reason}`, res.status === 403 ? 5 : 1);
  }
  if (!Array.isArray(payload.events)) {
    throw new AdminCliError('promote-fields: response carried no `events` array', 1);
  }
  return {
    target: describeAdminTarget('promote-fields', target),
    events: payload.events as PromotionEvent[]
  };
}

/** One line per field, after the target line. */
export function formatPromoteFieldsOutput(result: PromoteFieldsResult): string {
  const lines = [result.target];
  if (result.events.length === 0) lines.push('no pending fields');
  for (const e of result.events) {
    // A busy event's error is why it was skipped, not an attempt's failure.
    const outcome =
      e.kind === 'busy' && e.error !== undefined
        ? `busy (${e.error})`
        : `${e.kind} (attempt ${e.attempts})${e.error !== undefined ? ` — ${e.error}` : ''}`;
    lines.push(`${e.namespace}/${e.type}.${e.field}: ${outcome}`);
  }
  return `${lines.join('\n')}\n`;
}
