/**
 * Transport-agnostic core for explicit embedding fetch, shared by
 * `POST /substrate/v1/embeddings/fetch` and the `recall/fetchEmbeddings` frame
 * mutation. Throws coded errors: `bad_request` → 400, `policy_denied` → 403.
 *
 * Raw vectors leak content geometry, so a denied (namespace, type) scope fails
 * the WHOLE request rather than returning silent empties.
 */

import type { Embedder } from '@mnmal-ai/substrate-embedder';
import type { PolicyDecision } from '@mnmal-ai/substrate-types';
import type { EmbeddingsStore } from './embeddings-store.js';
import { DEFAULT_SALIENCE_CONFIG, type SalienceConfig } from './recall-route.js';
import { type CallerContext, memoCheck, visibleRows } from './row-visibility.js';

/**
 * Per-request ref cap. Bounds both the response payload and the store's
 * batched lookup.
 */
export const EMBEDDINGS_FETCH_MAX_REFS = 500;

export interface FetchRef {
  namespace: string;
  type: string;
  id: string;
}

export interface EmbeddingsFetchInput {
  refs: FetchRef[];
  model?: string;
  /**
   * When `true`, reinforce the rows returned. Defaults to `false`, unlike
   * `/substrate/v1/recall`: a caller naming rows often fetches them to rank them,
   * which is not use. To reinforce what was used, call
   * `POST /substrate/v1/salience/boost`.
   */
  boost?: boolean;
}

export interface EmbeddingsFetchDeps {
  store: EmbeddingsStore;
  /** Supplies the default model id when the input omits `model`. */
  embedder?: Embedder;
  /**
   * Supplies the boost decay half-life. Only `halfLifeHours` is read — the
   * `weight` blend is a recall-ranking concern and fetch does no ranking.
   * Defaults to `DEFAULT_SALIENCE_CONFIG`.
   */
  salience?: SalienceConfig;
  /**
   * Identity-bound read-policy check. A denied (namespace, type) scope throws
   * `{ code: 'policy_denied' }` before any store work. Absent → open.
   */
  checkReadPolicy?: (ns: string, type: string) => PolicyDecision;
  /** The caller's request context, for row-filter obligations. Absent → anonymous. */
  caller?: CallerContext;
  /**
   * Identity-bound write-policy check for the boost only. A denial skips the
   * boost for that scope but does not fail the request. Absent → no boost.
   */
  checkWritePolicy?: (ns: string, type: string) => PolicyDecision;
}

export interface EmbeddingsFetchOutput {
  vectors: Array<{
    namespace: string;
    type: string;
    id: string;
    row: Record<string, unknown>;
    vector: number[];
    /** Per-row salience BEFORE this call's boost, as in `/substrate/v1/recall`. */
    _salience: number;
  }>;
  model: string;
}

function badRequest(message: string): never {
  throw Object.assign(new Error(message), { code: 'bad_request' });
}

/**
 * Validate + normalise a raw fetch payload into an `EmbeddingsFetchInput`.
 * Throws `{ code: 'bad_request' }` on any shape/cap violation.
 */
export function validateFetchInput(raw: unknown): EmbeddingsFetchInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    badRequest('request body must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.refs) || obj.refs.length === 0) {
    badRequest('"refs" must be a non-empty array of { namespace, type, id }');
  }
  if ((obj.refs as unknown[]).length > EMBEDDINGS_FETCH_MAX_REFS) {
    badRequest(`"refs" exceeds the per-request cap of ${EMBEDDINGS_FETCH_MAX_REFS}`);
  }
  const refs: FetchRef[] = [];
  for (const r of obj.refs as unknown[]) {
    if (r === null || typeof r !== 'object') {
      badRequest('each ref must be an object with string namespace, type, id');
    }
    const { namespace, type, id } = r as Record<string, unknown>;
    if (typeof namespace !== 'string' || typeof type !== 'string' || typeof id !== 'string') {
      badRequest('each ref must be an object with string namespace, type, id');
    }
    refs.push({ namespace, type, id });
  }
  if (obj.model !== undefined && typeof obj.model !== 'string') {
    badRequest('"model" must be a string');
  }
  if (obj.boost !== undefined && typeof obj.boost !== 'boolean') {
    badRequest('"boost" must be a boolean');
  }
  return {
    refs,
    ...(obj.model !== undefined ? { model: obj.model as string } : {}),
    ...(obj.boost !== undefined ? { boost: obj.boost as boolean } : {})
  };
}

/**
 * Fetch stored embeddings for the named refs. Resolves the model (explicit
 * input → embedder default → `bad_request`), gates each distinct
 * (namespace, type) scope once against the bound read policy (first denial
 * throws `policy_denied` naming the scope), then runs one batched store
 * lookup. Returns `{ vectors, model }`; refs without an embedding under the
 * resolved model are silently absent (store contract).
 *
 * With `boost: true`, the returned rows are reinforced fire-and-forget, so
 * `_salience` on the response is the value before this call, not after.
 */
export async function handleEmbeddingsFetch(
  input: EmbeddingsFetchInput,
  deps: EmbeddingsFetchDeps
): Promise<EmbeddingsFetchOutput> {
  // One evaluation per scope serves both the gate and the row filters.
  const checkReadPolicy = memoCheck(deps.checkReadPolicy);
  const model = input.model ?? deps.embedder?.modelId;
  if (model === undefined) {
    badRequest('"model" is required when no embedder is configured');
  }

  if (checkReadPolicy !== undefined) {
    const seen = new Set<string>();
    for (const r of input.refs) {
      const scope = `${r.namespace}/${r.type}`;
      if (seen.has(scope)) continue;
      seen.add(scope);
      const decision = checkReadPolicy(r.namespace, r.type);
      if (!decision.allow) {
        throw Object.assign(new Error(`${scope}: ${decision.reason ?? 'policy denied'}`), {
          code: 'policy_denied'
        });
      }
    }
  }

  // Rows a row filter hides are absent, as an unembedded ref is.
  const fetched = visibleRows(
    await deps.store.fetchEmbeddings(input.refs, model),
    checkReadPolicy,
    deps.caller
  );

  // Reinforce only when the caller opted in AND the write policy allows it,
  // per scope. A denial skips the write but still serves the read.
  // Fire-and-forget: no caller reads the write back.
  if (input.boost === true && fetched.length > 0) {
    const writable = new Map<string, boolean>();
    const targets = fetched
      .filter((f) => {
        const scope = `${f.namespace}/${f.type}`;
        const cached = writable.get(scope);
        if (cached !== undefined) return cached;
        const allow = deps.checkWritePolicy?.(f.namespace, f.type).allow ?? false;
        writable.set(scope, allow);
        return allow;
      })
      .map((f) => ({ namespace: f.namespace, type: f.type, id: f.id }));

    if (targets.length > 0) {
      const halfLifeHours = (deps.salience ?? DEFAULT_SALIENCE_CONFIG).halfLifeHours;
      void deps.store.boostSalience(targets, halfLifeHours).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`embeddings-fetch boostSalience failure: ${msg}\n`);
      });
    }
  }

  return {
    vectors: fetched.map((f) => ({
      namespace: f.namespace,
      type: f.type,
      id: f.id,
      row: f.row,
      vector: Array.from(f.vector),
      _salience: f.salience
    })),
    model
  };
}
