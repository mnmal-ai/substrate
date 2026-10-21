/**
 * Engine-call helpers for coordinator/plugin authors.
 *
 * Run an internal engine query or build a request context from inside a
 * plugin route or scheduled task, so coordinators share one implementation.
 *
 * Depends only on `@mnmal-ai/substrate-types`; this package must not take a
 * runtime dependency on `substrate-core`.
 */

import {
  type EngineHandle,
  formatQualifiedKey,
  type Identity,
  type PackEnvelope,
  type RequestContext
} from '@mnmal-ai/substrate-types';

/**
 * Build a minimal `Partial<RequestContext>` for a plugin's engine call.
 *
 * PASS THE CALLER'S IDENTITY WHENEVER THERE IS ONE. Omitting it yields the
 * SYSTEM ACTOR (`identity: null`), which the engine's per-frame namespace gate
 * waves through unconditionally — correct for genuinely system-initiated work
 * (a scheduled sweep, a liveness probe), and a privilege escalation for
 * anything a caller asked for. A plugin route that omits it lets a caller reach
 * namespaces their grant does not cover, because the route gate checks a
 * capability without a namespace and the engine gate then checks a namespace
 * without an identity.
 *
 * The distinction is WHO ASKED, not which plugin.
 */
export function makeCtx(
  namespace: string,
  operation: 'query' | 'mutate',
  identity: Identity | null = null
): Partial<RequestContext> {
  return {
    identity,
    namespace,
    operation,
    now: new Date(),
    headers: {},
    meta: {}
  };
}

/**
 * A frame the engine REFUSED, surfaced as a throw rather than as an empty result.
 *
 * Substrate returns a partial-success envelope: a rejected frame comes back with its
 * key ABSENT from `data` and the reason in `errors`. Without this, `queryOne` /
 * `queryAll` would render a refusal as `null` / `[]`, indistinguishable from a
 * query that matched nothing.
 */
export class EngineQueryError extends Error {
  override readonly name = 'EngineQueryError';
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Throw when the envelope carries an error, so a refusal cannot read as absence. */
function assertNoFrameError(env: PackEnvelope, key: string): void {
  const err = env.errors?.[0];
  if (err !== undefined) {
    throw new EngineQueryError(err.code ?? 'query_failed', err.message ?? `${key} was refused`);
  }
}

/** Expand a list of field names into the `{ field: true }` selection map. */
export function selectAll(fields: readonly string[]): Record<string, true> {
  const out: Record<string, true> = {};
  for (const f of fields) out[f] = true;
  return out;
}

/** Accept either a field-name list or an already-built selection map. */
function toSelection(fields: readonly string[] | Record<string, true>): Record<string, true> {
  return Array.isArray(fields) ? selectAll(fields) : (fields as Record<string, true>);
}

/**
 * Run an internal engine query and return the row list (empty when the frame
 * resolves to nothing). `fields` may be a name list or a prebuilt selection map.
 */
export async function queryAll<T>(
  engine: EngineHandle,
  namespace: string,
  typeName: string,
  params: Record<string, unknown>,
  fields: readonly string[] | Record<string, true>,
  identity: Identity | null = null
): Promise<Array<T>> {
  const key = formatQualifiedKey(namespace, typeName);
  const env: PackEnvelope = await engine.query({
    frame: { [key]: { params, fields: toSelection(fields) } },
    ctx: makeCtx(namespace, 'query', identity)
  });
  assertNoFrameError(env, key);
  const rows = env.data[key];
  if (rows === undefined || rows === null) return [];
  return rows as Array<T>;
}

/**
 * Run an internal engine query expecting at most one row; returns the first
 * row or null. `fields` may be a name list or a prebuilt selection map.
 */
export async function queryOne<T>(
  engine: EngineHandle,
  namespace: string,
  typeName: string,
  params: Record<string, unknown>,
  fields: readonly string[] | Record<string, true>,
  identity: Identity | null = null
): Promise<T | null> {
  const key = formatQualifiedKey(namespace, typeName);
  const env: PackEnvelope = await engine.query({
    frame: { [key]: { params, fields: toSelection(fields) } },
    ctx: makeCtx(namespace, 'query', identity)
  });
  assertNoFrameError(env, key);
  const rows = env.data[key];
  if (rows === undefined || rows === null) return null;
  if (Array.isArray(rows)) return (rows[0] as T | undefined) ?? null;
  return rows as T;
}
