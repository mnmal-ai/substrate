/**
 * The transport-agnostic recall core. `handleRecallRequest` is shared by the
 * HTTP route, the `recall/Hit` frame surface and the `recall` MCP tool.
 */

import { cosineSimilarity } from '../cosine.js';
import { type EmbeddingsStore, matchesRowFilter, rowFilterProblem } from '../embeddings-store.js';
import type { ExpansionNeighbour, ExpansionSourceRow } from '../expansion-resolver.js';
import { HANDLE_FIELDS } from '../labelling.js';
import { fillVisible, memoCheck, visibleRefs, visibleRows } from '../row-visibility.js';
import { armRanks, fuseByRank } from '../rrf.js';
import type { SpreadSourceRow } from '../spread-resolver.js';
import {
  DEFAULT_SALIENCE_CONFIG,
  type RecallDeps,
  type RecallInput,
  type RecallOutput,
  type RecallRow
} from './types.js';

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** Longest accepted recall query text, on every surface. */
export const MAX_RECALL_QUERY_CHARS = 8192;

export async function handleRecallRequest(
  input: RecallInput,
  deps: RecallDeps
): Promise<RecallOutput> {
  const {
    embedder,
    store,
    lexicalStore,
    lexicalSources,
    embedSources,
    salience = DEFAULT_SALIENCE_CONFIG,
    spreadResolver = null,
    expansionResolver = null,
    expansionEnabled = true,
    stats,
    checkWritePolicy,
    caller
  } = deps;
  const checkReadPolicy = memoCheck(deps.checkReadPolicy);
  // Which arms can run is decided here, once, for all three surfaces, and
  // before namespace resolution: a caller who omitted `namespace` against a
  // server with nothing to search with should be told the server cannot
  // search, not sent to fix a parameter that would change nothing.
  //
  // The dense arm needs an embedder AND a store. The lexical arm needs
  // neither: its index is written independently of the embedder.
  const denseArm = embedder !== undefined && store !== undefined;
  const lexicalWhyIfOff: 'no-store' | 'disabled-by-request' =
    lexicalStore === undefined ? 'no-store' : 'disabled-by-request';
  const lexicalArm = lexicalStore !== undefined && input.lexical !== false;
  if (!denseArm && !lexicalArm) {
    // Two codes because the fixes differ: an operator wires an arm, a caller
    // drops `lexical: false`. Only the second is retryable by the caller.
    const denseDetail = embedder === undefined ? 'no embedder' : 'no EmbeddingsStore';
    throw Object.assign(
      new Error(
        `recall has no arm to run. dense: off (${denseDetail}). lexical: off ` +
          `(${lexicalWhyIfOff}). Wire an embedder + EmbeddingsStore, wire a ` +
          'LexicalStore and declare `lexical.source` on the type, or drop ' +
          '`lexical: false` from the request.'
      ),
      { code: lexicalWhyIfOff === 'no-store' ? 'embedder_unavailable' : 'no_retrieval_arm' }
    );
  }

  // No default namespace: a guessed one silently searches a namespace that may
  // not exist, and the empty result is indistinguishable from a miss.
  const namespace = input.namespace ?? process.env.SUBSTRATE_NAMESPACE;
  if (namespace === undefined || namespace === '') {
    throw Object.assign(
      new Error(
        'recall: no namespace to search. Pass `namespace` on the request, or set SUBSTRATE_NAMESPACE ' +
          'in the server environment. There is no default — guessing one silently searches ' +
          'a namespace that may not exist and returns an empty result that looks like a miss.'
      ),
      { code: 'missing_namespace' }
    );
  }
  // Validated here, once, for every surface: the MCP tool passes its input
  // through unparsed.
  const where = input.where;
  if (where !== undefined) {
    const problem = rowFilterProblem(where);
    if (problem !== null) {
      throw Object.assign(new Error(`"where" ${problem}`), { code: 'bad_request' });
    }
  }
  const rowFields = input.rowFields;
  if (rowFields !== undefined) {
    const problem = rowFieldsProblem(rowFields);
    if (problem !== null) {
      throw Object.assign(new Error(`"rowFields" ${problem}`), { code: 'bad_request' });
    }
  }
  // No default type either, for the same reason as namespace.
  const type = input.type;
  if (type === undefined || type === '') {
    throw Object.assign(
      new Error('recall: pass `type`, the type to search. There is no default.'),
      {
        code: 'bad_request'
      }
    );
  }
  // The HTTP route and the frame reject this already; the MCP tool passes its
  // input through unparsed, so a missing query threw a raw TypeError below and
  // an empty one reached the embedder, which answers "" with no vector.
  if (typeof input.query !== 'string' || input.query.trim() === '') {
    throw Object.assign(new Error('recall: pass `query`, the text to search for.'), {
      code: 'bad_request'
    });
  }
  // Every arm embeds or tokenises the whole text, so its length is the cost.
  if (input.query.length > MAX_RECALL_QUERY_CHARS) {
    throw Object.assign(
      new Error(`recall: query is longer than ${MAX_RECALL_QUERY_CHARS} characters`),
      { code: 'bad_request' }
    );
  }
  const k = clamp(input.k ?? 10, 1, 100);
  const threshold = typeof input.threshold === 'number' ? input.threshold : 0;
  const lexicalThreshold =
    typeof input.lexicalThreshold === 'number' ? input.lexicalThreshold : threshold;

  // Read-policy gate on the primary scope, before any embedder/store work, so
  // a denied caller costs nothing and triggers no salience boost. Throws
  // rather than returning empty: the denial is actionable.
  const decision = checkReadPolicy?.(namespace, type);
  if (decision !== undefined) {
    if (!decision.allow) {
      throw Object.assign(new Error(decision.reason ?? 'policy denied'), {
        code: 'policy_denied'
      });
    }
  }

  // A type declaring no `embed.source` has no vectors, so knn cannot match.
  // Reported as `denseWhy: 'no-source'` rather than refused, mirroring the
  // lexical arm. An absent or empty registry says nothing about the type, so
  // both still run the arm.
  const embedSourceMissing =
    embedSources !== undefined &&
    embedSources.size() > 0 &&
    embedSources.get(namespace, type) === undefined;
  const denseRan = denseArm && !embedSourceMissing;
  // Deployment faults first: an operator with no embedder wired needs to hear
  // that before hearing about one type's declaration.
  const denseWhy: 'ran' | 'no-embedder' | 'no-store' | 'no-source' = denseRan
    ? 'ran'
    : !denseArm
      ? embedder === undefined
        ? 'no-embedder'
        : 'no-store'
      : 'no-source';

  const t0 = performance.now();
  const returnVector = input.returnVector === true;
  // `t1`/`t2` collapse onto `t0` when the dense arm did not run, so the
  // timings report zero rather than a number invented for a step that never
  // happened. `arms.dense` is what says which reading a zero is.
  let t1 = t0;
  let t2 = t0;
  let vector: Float32Array | undefined;
  let candidates: RecallRow[] = [];
  if (denseRan && embedder !== undefined && store !== undefined) {
    vector = await embedder.embed(input.query);
    t1 = performance.now();

    const knnInput: Parameters<EmbeddingsStore['knnSearch']>[0] = {
      namespace,
      type,
      model: embedder.modelId,
      vector,
      k,
      salienceHalfLifeHours: salience.halfLifeHours
    };
    if (threshold > 0) knnInput.threshold = threshold;
    if (returnVector) knnInput.returnVector = true;
    if (where !== undefined) knnInput.rowFilter = where;
    // Build initial candidate pool from knn results.
    candidates = await fillVisible(
      k,
      decision,
      async (n) =>
        (await store.knnSearch({ ...knnInput, k: n })).map(
          (r): RecallRow => ({
            row: r.row,
            namespace,
            type,
            score: r.score,
            _salience: r.salience,
            _blendedScore: r.score,
            ...(returnVector && r.vector !== undefined ? { vector: r.vector } : {})
          })
        ),
      (rows) => visibleRows(rows, checkReadPolicy, caller)
    );
    t2 = performance.now();
  }

  // Expansion: walk opt-in crossRefs from the knn top-K, score the
  // neighbours' embeddings by cosine against the query vector, merge, re-rank
  // and keep top-K. Gated on `expand: true`, the plugin kill-switch and a
  // resolver; dense-arm work, so it narrows on the values it uses.
  if (
    input.expand === true &&
    expansionEnabled &&
    expansionResolver !== null &&
    vector !== undefined &&
    embedder !== undefined &&
    store !== undefined
  ) {
    try {
      const sources: ExpansionSourceRow[] = candidates.map((c) => ({
        namespace,
        type,
        id: String(c.row.id ?? ''),
        row: c.row
      }));
      const neighbours = await expansionResolver(sources);
      if (neighbours.length > 0) {
        const fetched = await store.fetchEmbeddings(
          neighbours.map((n) => ({ namespace: n.namespace, type: n.type, id: n.id })),
          embedder.modelId
        );
        const seenKeys = new Set(sources.map((s) => `${s.namespace}/${s.type}/${s.id}`));
        const byKey = new Map<string, ExpansionNeighbour>();
        for (const n of neighbours) {
          byKey.set(`${n.namespace}/${n.type}/${n.id}`, n);
        }
        // Neighbours are judged as rows in their own right: a denied type or
        // a row its row filters hide drops silently.
        const readable = new Set(visibleRows(fetched, checkReadPolicy, caller));
        for (const f of fetched) {
          const neighbour = byKey.get(`${f.namespace}/${f.type}/${f.id}`);
          // Cross-namespace expansion is always rejected. A different type is
          // admitted only for backward walks on edges declaring
          // `expandCrossType: true` (`neighbour.allowsCrossType`).
          if (f.namespace !== namespace) continue;
          if (f.type !== type && neighbour?.allowsCrossType !== true) continue;
          if (!readable.has(f)) continue;
          if (where !== undefined && !matchesRowFilter(f.row, where)) continue;
          const fkey = `${f.namespace}/${f.type}/${String(f.row.id ?? '')}`;
          if (seenKeys.has(fkey)) continue;
          seenKeys.add(fkey);
          const cos = cosineSimilarity(vector, f.vector);
          const candidate: RecallRow = {
            row: f.row,
            namespace: f.namespace,
            type: f.type,
            score: cos,
            _salience: 0,
            _blendedScore: cos,
            // The neighbour vector the cosine was computed from.
            ...(returnVector ? { vector: Array.from(f.vector) } : {})
          };
          if (neighbour !== undefined) {
            // Every expansion seed has the request's (namespace, type).
            candidate._expandedFrom = { namespace, type, id: neighbour.seedId };
          }
          candidates.push(candidate);
        }
        candidates.sort((a, b) => b.score - a.score);
        candidates = candidates.slice(0, k);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`recall route expansion failure: ${msg}\n`);
      stats?.recordExpansionFailure();
    }
  }

  // Blend salience into ranking. At weight 0 (the default) `_blendedScore`
  // already equals `score`, so the candidates are reused as-is.
  const weight = salience.weight;
  let blended: RecallRow[];
  if (weight > 0) {
    blended = candidates.map((c) => ({
      ...c,
      _blendedScore: c.score * (1 + weight * Math.log(1 + Math.max(0, c._salience)))
    }));
    blended.sort((a, b) => b._blendedScore - a._blendedScore);
  } else {
    blended = candidates;
  }

  // Lexical arm, fused by rank AFTER the salience blend so the dense order
  // already carries salience.
  //
  // When fusion runs, `score` is the RRF sum rather than a cosine: a
  // lexical-only row has no cosine. `arms` tells the caller which it holds;
  // `explain` recovers the components.
  let fusedRows: RecallRow[] = blended;
  let lexicalRan = false;
  let lexicalWhy: 'ran' | 'no-store' | 'no-source' | 'disabled-by-request' = 'no-store';
  if (lexicalStore !== undefined) {
    if (input.lexical === false) {
      lexicalWhy = 'disabled-by-request';
    } else if (
      lexicalSources !== undefined &&
      lexicalSources.size() > 0 &&
      lexicalSources.get(namespace, type) === undefined
    ) {
      // The type declares no `lexical.source`, so the arm cannot match.
      // Reported rather than refused, even when no arm is left: refusing
      // would need the type known before namespace resolution.
      lexicalWhy = 'no-source';
    } else {
      const hits = await fillVisible(
        k,
        decision,
        (n) =>
          lexicalStore.search({
            namespace,
            type,
            query: input.query,
            k: n,
            ...(where !== undefined ? { rowFilter: where } : {})
          }),
        (found) =>
          visibleRows(
            found.map((hit) => ({ namespace, type, row: hit.row, hit })),
            checkReadPolicy,
            caller
          ).map((v) => v.hit)
      );
      lexicalRan = true;
      lexicalWhy = 'ran';
      const denseIds = blended.map((r) => String((r.row as { id?: unknown }).id ?? ''));
      const lex = await floorLexicalHits(hits, new Set(denseIds), lexicalThreshold, {
        namespace,
        type,
        vector,
        store,
        model: embedder?.modelId
      });
      const lexicalIds = lex.map((h) => h.rowId);

      if (lexicalIds.length === 0) {
        // Nothing to fuse, so keep the cosine scores: fusing would rewrite
        // them as RRF values and break consumers' cosine-calibrated floors.
        // The explain fields are still attached for diagnosis.
        fusedRows = blended.map((r, i) => ({
          ...r,
          ...(input.explain === true
            ? { _arms: armRanks(denseIds[i] as string, denseIds, lexicalIds), _denseScore: r.score }
            : {})
        }));
      } else {
        const fused = fuseByRank([denseIds, lexicalIds]);

        const byId = new Map<string, RecallRow>();
        for (const [i, r] of blended.entries()) byId.set(denseIds[i] as string, r);
        // Lexical-only rows carry a placeholder dense score of 0; `_denseScore`
        // reports `null` for them, since 0 is a real cosine.
        const denseRanked = new Set(denseIds);
        for (const h of lex) {
          if (byId.has(h.rowId)) continue;
          byId.set(h.rowId, {
            row: h.row,
            namespace,
            type,
            score: 0,
            _salience: 0,
            _blendedScore: 0
          });
        }

        fusedRows = [...fused.entries()]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .slice(0, k)
          .flatMap(([id, fusedScore]) => {
            const base = byId.get(id);
            if (base === undefined) return [];
            const denseScore = denseRanked.has(id) ? base.score : null;
            return [
              {
                ...base,
                score: fusedScore,
                _blendedScore: fusedScore,
                ...(input.explain === true
                  ? { _arms: armRanks(id, denseIds, lexicalIds), _denseScore: denseScore }
                  : {})
              }
            ];
          });
      }
    }
  }

  // Fire-and-forget salience boost on returned rows; awaiting would add
  // latency, and losing an attention-signal write is acceptable.
  //
  // Expanded rows are context and are excluded from boost and spreading;
  // `extractTargets` would also stamp them with the wrong (namespace, type).
  const directRows = fusedRows.filter((r) => r._expandedFrom === undefined);
  const targets = extractTargets(namespace, type, directRows);

  // The boost is a write and is gated by write policy. It defaults on here,
  // unlike embeddings/fetch, because recall's result set is itself evidence
  // of use. Fails closed when unwired; a denial skips the boost, not the recall.
  const mayWrite = (ns: string, ty: string): boolean => checkWritePolicy?.(ns, ty).allow ?? false;

  // boost defaults true; an explicit `boost:false` runs recall read-only
  // (the consumer reinforces on use via /substrate/v1/salience/boost instead).
  // `store !== undefined` is the dense arm again: salience lives in the
  // embeddings store, so a lexical-only deployment has nothing to boost.
  if (
    input.boost !== false &&
    targets.length > 0 &&
    store !== undefined &&
    mayWrite(namespace, type)
  ) {
    void store.boostSalience(targets, salience.halfLifeHours).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`recall route boostSalience failure: ${msg}\n`);
    });

    // Activation spreading: boost opt-in crossRef neighbours (forward and
    // backward, depth 1) with the damping multiplier. Also fire-and-forget.
    if (spreadResolver !== null && salience.spreadDamping > 0) {
      const sources: SpreadSourceRow[] = directRows.map((r) => ({
        namespace,
        type,
        id: String(r.row.id ?? ''),
        row: r.row
      }));
      void Promise.resolve()
        .then(async () => {
          const spreadTargets = await spreadResolver(sources);
          if (spreadTargets.length === 0) return;
          // Write policy is checked per target scope: spread neighbours live
          // in other (namespace, type) pairs the primary check did not cover.
          const seen = new Map<string, boolean>();
          const permitted = spreadTargets.filter((t) => {
            const scope = `${t.namespace}/${t.type}`;
            const cached = seen.get(scope);
            if (cached !== undefined) return cached;
            const allow = mayWrite(t.namespace, t.type);
            seen.set(scope, allow);
            return allow;
          });
          // A neighbour the caller cannot read is not reinforced through them.
          const readable = await visibleRefs(
            permitted,
            checkReadPolicy,
            caller,
            store,
            embedder?.modelId
          );
          if (readable.length === 0) return;
          await store.boostSalience(readable, salience.halfLifeHours, salience.spreadDamping);
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`recall route spread boost failure: ${msg}\n`);
        });
    }
  }

  const t3 = performance.now();

  return {
    rows: rowFields === true ? fusedRows : fusedRows.map((r) => projectRow(r, rowFields)),
    // Empty when the dense arm did not run, including the `no-source` case.
    model: denseRan ? (embedder?.modelId ?? '') : '',
    arms: {
      dense: denseRan,
      denseWhy,
      lexical: lexicalRan,
      lexicalWhy
    },
    timings: {
      embed_ms: t1 - t0,
      knn_ms: t2 - t1,
      total_ms: t3 - t0
    }
  };
}

/**
 * Applies the cosine `threshold` to lexical hits the dense arm did not rank,
 * scoring each against its stored vector. A hit with no stored vector cannot
 * meet a floor and is dropped. Returns `hits` unchanged when there is no
 * floor or no query vector (the dense arm did not run).
 */
async function floorLexicalHits<H extends { rowId: string }>(
  hits: ReadonlyArray<H>,
  denseIds: ReadonlySet<string>,
  threshold: number,
  ctx: {
    namespace: string;
    type: string;
    vector: Float32Array | undefined;
    store: EmbeddingsStore | undefined;
    model: string | undefined;
  }
): Promise<ReadonlyArray<H>> {
  const { namespace, type, vector, store, model } = ctx;
  if (threshold <= 0 || vector === undefined || store === undefined || model === undefined) {
    return hits;
  }
  const unranked = hits.filter((h) => !denseIds.has(h.rowId));
  if (unranked.length === 0) return hits;
  const fetched = await store.fetchEmbeddings(
    unranked.map((h) => ({ namespace, type, id: h.rowId })),
    model
  );
  const passing = new Set(
    fetched.filter((f) => cosineSimilarity(vector, f.vector) >= threshold).map((f) => f.id)
  );
  return hits.filter((h) => denseIds.has(h.rowId) || passing.has(h.rowId));
}

function extractTargets(
  namespace: string,
  type: string,
  rows: ReadonlyArray<{ row: Record<string, unknown> }>
): Array<{ namespace: string; type: string; id: string }> {
  const out: Array<{ namespace: string; type: string; id: string }> = [];
  for (const r of rows) {
    const id = r.row.id;
    if (typeof id === 'string' && id.length > 0) {
      out.push({ namespace, type, id });
    }
  }
  return out;
}

/** Why `rowFields` is malformed, or `null` when it is `true` or an object of `field: true`. */
function rowFieldsProblem(value: unknown): string | null {
  if (value === true) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'must be true (the whole body) or an object of field: true, e.g. { "body": true }';
  }
  for (const [field, v] of Object.entries(value)) {
    if (v !== true) return `field "${field}" must be true`;
  }
  return null;
}

/** Narrow a hit's `row` to `id` plus `rowFields`, or plus the handle fields when absent. */
function projectRow<R extends { row: Record<string, unknown> }>(
  hit: R,
  rowFields: Record<string, true> | undefined
): R {
  const row: Record<string, unknown> = {};
  const keep = rowFields === undefined ? HANDLE_FIELDS : Object.keys(rowFields);
  for (const field of ['id', ...keep]) {
    if (Object.hasOwn(hit.row, field)) row[field] = hit.row[field];
  }
  return { ...hit, row };
}
