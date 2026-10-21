/**
 * Transport-agnostic core for explicit salience reinforcement.
 *
 * Both `POST /substrate/v1/salience/boost` and the `recall/boost` frame mutation
 * delegate here, including validation (`validateBoostInput`).
 *
 * Errors are coded throws (`Object.assign(new Error(msg), { code })`) — each
 * adapter maps the `code` to its transport status: `bad_request` → 400,
 * `policy_denied` → 403.
 */

import type { PolicyDecision } from '@mnmal-ai/substrate-types';
import type { EmbeddingsStore, SalienceTarget } from './embeddings-store.js';
import { type CallerContext, memoCheck, visibleRefs } from './row-visibility.js';

/** Per-request target cap — bounds the batched store write. */
export const SALIENCE_BOOST_MAX_TARGETS = 500;

export interface SalienceBoostInput {
  targets: SalienceTarget[];
  bump?: number;
}

export interface SalienceBoostDeps {
  store: EmbeddingsStore;
  /** Boost decay half-life in hours (the route supplies its salience config's value). */
  halfLifeHours: number;
  /**
   * Identity-BOUND read-policy check — the transport caller binds its
   * identity before delegating here. A denied (namespace, type) scope throws
   * `{ code: 'policy_denied' }` before any store work. Absent → open.
   */
  checkReadPolicy?: (ns: string, type: string) => PolicyDecision;
  /** The caller's request context, for row-filter obligations. Absent → anonymous. */
  caller?: CallerContext;
  /**
   * Embedding model whose stored bodies row filters are judged on. A target in
   * a row-scoped scope with no body under it is not boosted.
   */
  model?: string;
  /**
   * Identity-BOUND write-policy check. A denied scope throws `policy_denied`
   * as the read gate does.
   *
   * Absent → the boost is REFUSED, deliberately the opposite default to
   * `checkReadPolicy`: an unwired write check must not let unsigned callers
   * reshape stored salience.
   */
  checkWritePolicy?: (ns: string, type: string) => PolicyDecision;
}

function badRequest(message: string): never {
  throw Object.assign(new Error(message), { code: 'bad_request' });
}

/**
 * Validate + normalise a raw boost payload into a `SalienceBoostInput`.
 * Throws `{ code: 'bad_request' }` on any shape/cap violation.
 */
export function validateBoostInput(raw: unknown): SalienceBoostInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    badRequest('request body must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.targets) || obj.targets.length === 0) {
    badRequest('"targets" must be a non-empty array of { namespace, type, id }');
  }
  if ((obj.targets as unknown[]).length > SALIENCE_BOOST_MAX_TARGETS) {
    badRequest(`"targets" exceeds the per-request cap of ${SALIENCE_BOOST_MAX_TARGETS}`);
  }
  const targets: SalienceTarget[] = [];
  for (const t of obj.targets as unknown[]) {
    if (t === null || typeof t !== 'object') {
      badRequest('each target must be an object with string namespace, type, id');
    }
    const { namespace, type, id } = t as Record<string, unknown>;
    if (typeof namespace !== 'string' || typeof type !== 'string' || typeof id !== 'string') {
      badRequest('each target must be an object with string namespace, type, id');
    }
    if (namespace.length === 0 || type.length === 0 || id.length === 0) {
      badRequest('target namespace, type, id must be non-empty strings');
    }
    targets.push({ namespace, type, id });
  }
  if (obj.bump !== undefined) {
    if (typeof obj.bump !== 'number' || !Number.isFinite(obj.bump) || obj.bump <= 0) {
      badRequest('"bump" must be a finite number > 0');
    }
    return { targets, bump: obj.bump };
  }
  return { targets };
}

/** What a boost actually did, as opposed to what it was asked to do. */
export interface SalienceBoostResult {
  ok: true;
  /** Targets the caller named. */
  requested: number;
  /**
   * Targets that matched a stored embedding and were reinforced — the field a
   * caller can assert on, since `requested` counts intent only.
   */
  applied: number;
  /**
   * The targets that matched no embedding row, echoed back so a stale or
   * wrong id is diagnosable rather than a silent no-op.
   */
  missing: SalienceTarget[];
}

/**
 * Reinforce salience for the named targets. Gates each distinct
 * (namespace, type) scope once against the bound read and write policies
 * (first denial throws `policy_denied` naming the scope), then awaits the
 * batched store write.
 */
export async function handleSalienceBoost(
  input: SalienceBoostInput,
  deps: SalienceBoostDeps
): Promise<SalienceBoostResult> {
  // One evaluation per scope serves both the gate and the row filters.
  const checkReadPolicy = memoCheck(deps.checkReadPolicy);
  // Gate each distinct scope once, read first so a caller with no read access
  // learns nothing about writes.
  const seen = new Set<string>();
  for (const t of input.targets) {
    const scope = `${t.namespace}/${t.type}`;
    if (seen.has(scope)) continue;
    seen.add(scope);

    if (checkReadPolicy !== undefined) {
      const decision = checkReadPolicy(t.namespace, t.type);
      if (!decision.allow) {
        throw Object.assign(new Error(`${scope}: ${decision.reason ?? 'policy denied'}`), {
          code: 'policy_denied'
        });
      }
    }

    // Fails closed when unwired — see the field docs. A host that has not
    // bound a write check cannot authorise a write.
    const write = deps.checkWritePolicy?.(t.namespace, t.type) ?? {
      allow: false,
      reason: 'write policy not wired'
    };
    if (!write.allow) {
      throw Object.assign(new Error(`${scope}: ${write.reason ?? 'policy denied'}`), {
        code: 'policy_denied'
      });
    }
  }

  // Awaited (not fire-and-forget): an explicit caller wants confirmation.
  // A row the caller cannot read is not boosted, and is reported as missing
  // so its existence is not disclosed.
  const readable = await visibleRefs(
    input.targets,
    checkReadPolicy,
    deps.caller,
    deps.store,
    deps.model
  );
  const applied = await deps.store.boostSalience(readable, deps.halfLifeHours, input.bump);

  // Difference by identity rather than by index: the store does not specify
  // the order it reports matches in, and the pg RETURNING clause follows the
  // update order, not the input order.
  const hit = new Set(applied.map((t) => `${t.namespace}/${t.type}/${t.id}`));
  const missing = input.targets.filter((t) => !hit.has(`${t.namespace}/${t.type}/${t.id}`));

  return { ok: true, requested: input.targets.length, applied: applied.length, missing };
}
